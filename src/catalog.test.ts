import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { afterAll, describe, expect, it } from "vitest";
import { BazaarCatalog, expandWithSynonyms, stem } from "./catalog.js";
import { readOwnership, reopen, seedRows } from "./store.testkit.js";

function requirements(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND",
    amount: "1000000",
    payTo: "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A",
    maxTimeoutSeconds: 60,
    extra: {},
    ...over,
  } as PaymentRequirements;
}

function discovered(over: Partial<DiscoveredResource> = {}): DiscoveredResource {
  return {
    resourceUrl: "https://api.example.com/weather",
    description: "Hourly weather data",
    serviceName: "WeatherSvc",
    tags: ["weather", "data"],
    x402Version: 2,
    discoveryInfo: { input: { type: "http", method: "GET" } },
    ...over,
  } as DiscoveredResource;
}

describe("BazaarCatalog", () => {
  it("upserts a resource and lists it with the wire shape", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(discovered(), requirements());
    const res = catalog.list();
    expect(res.x402Version).toBe(2);
    expect(res.pagination).toEqual({ limit: 20, offset: 0, total: 1 });
    expect(res.items).toHaveLength(1);
    const item = res.items[0]!;
    expect(item.resource).toBe("https://api.example.com/weather");
    expect(item.type).toBe("http");
    expect(item.accepts).toHaveLength(1);
    expect(item.serviceName).toBe("WeatherSvc");
    expect(item.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("dedupes identical accepts and accumulates distinct ones", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(discovered(), requirements());
    await catalog.upsertFromPayment(discovered(), requirements()); // same requirements again
    await catalog.upsertFromPayment(discovered(), requirements({ amount: "2000000" }));
    const item = catalog.list().items[0]!;
    expect(catalog.size).toBe(1);
    expect(item.accepts).toHaveLength(2);
  });

  it("filters by type, payTo, network, and extensions key", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(discovered(), requirements());
    await catalog.upsertFromPayment(
      discovered({
        resourceUrl: "https://api.example.com/mcp-tool",
        discoveryInfo: {
          input: { type: "mcp", toolName: "analyze", inputSchema: {} },
        },
        extensions: { bazaar: { info: {} } },
      } as Partial<DiscoveredResource>),
      requirements({ payTo: "GOTHER", network: "stellar:pubnet" }),
    );

    expect(catalog.list({ type: "http" }).items).toHaveLength(1);
    expect(catalog.list({ type: "mcp" }).items).toHaveLength(1);
    expect(catalog.list({ payTo: "GOTHER" }).items).toHaveLength(1);
    expect(catalog.list({ network: "stellar:testnet" }).items).toHaveLength(1);
    expect(catalog.list({ network: "stellar:pubnet" }).items).toHaveLength(1);
    expect(catalog.list({ extensions: "bazaar" }).items).toHaveLength(1);
    expect(catalog.list({ extensions: "nope" }).items).toHaveLength(0);
  });

  it("paginates with limit/offset and clamps limit to [1, 100]", async () => {
    const catalog = await BazaarCatalog.create();
    for (let i = 0; i < 5; i++) {
      await catalog.upsertFromPayment(
        discovered({ resourceUrl: `https://api.example.com/r${i}` }),
        requirements(),
      );
    }
    const page = catalog.list({ limit: 2, offset: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.pagination).toEqual({ limit: 2, offset: 2, total: 5 });
    expect(catalog.list({ limit: 0 }).pagination.limit).toBe(1);
    expect(catalog.list({ limit: 10_000 }).pagination.limit).toBe(100);
  });

  it("search ranks serviceName matches above description matches", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(
      discovered({
        resourceUrl: "https://a.example.com/data",
        serviceName: "Other",
        tags: [],
        description: "weather information by city",
      }),
      requirements(),
    );
    await catalog.upsertFromPayment(
      discovered({
        resourceUrl: "https://b.example.com/data",
        serviceName: "Weather Service",
        tags: [],
        description: "unrelated",
      }),
      requirements(),
    );
    const res = catalog.search({ query: "weather" });
    expect(res.resources).toHaveLength(2);
    expect(res.resources[0]!.resource).toBe("https://b.example.com/data");
  });

  it("search excludes non-matching resources", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(discovered(), requirements());
    await catalog.upsertFromPayment(
      discovered({
        resourceUrl: "https://api.example.com/prices",
        serviceName: "PriceFeed",
        tags: ["prices"],
        description: "token prices",
      }),
      requirements(),
    );
    const res = catalog.search({ query: "weather" });
    expect(res.resources).toHaveLength(1);
    expect(res.resources[0]!.resource).toBe("https://api.example.com/weather");
  });

  it("search paginates with a cursor and ignores a stale cursor from a different query", async () => {
    const catalog = await BazaarCatalog.create();
    for (let i = 0; i < 3; i++) {
      await catalog.upsertFromPayment(
        discovered({ resourceUrl: `https://api.example.com/w${i}` }),
        requirements(),
      );
    }
    const page1 = catalog.search({ query: "weather", limit: 2 });
    expect(page1.resources).toHaveLength(2);
    expect(page1.partialResults).toBe(true);
    expect(page1.pagination?.cursor).toBeTruthy();

    const page2 = catalog.search({ query: "weather", limit: 2, cursor: page1.pagination!.cursor! });
    expect(page2.resources).toHaveLength(1);
    expect(page2.partialResults).toBe(false);
    expect(page2.pagination?.cursor).toBeNull();

    // Same cursor but a different query: cursor must be ignored (fresh page 1).
    const other = catalog.search({ query: "data", limit: 2, cursor: page1.pagination!.cursor! });
    expect(other.resources.length).toBeGreaterThan(0);
    // Garbage cursor: also ignored, no crash.
    const garbage = catalog.search({ query: "weather", limit: 2, cursor: "not-base64!!" });
    expect(garbage.resources).toHaveLength(2);
  });

  describe("persistence", () => {
    const dir = mkdtempSync(join(tmpdir(), "bazaar-catalog-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("round-trips the catalog through the persistence file", async () => {
      const file = `file:${join(dir, "catalog.json.db")}`;
      const catalog = await BazaarCatalog.create(reopen(file));
      await catalog.upsertFromPayment(discovered(), requirements());
      await catalog.flush(); // entry writes are debounced; ownership is already durable
      const reloaded = await BazaarCatalog.create(reopen(file));
      expect(reloaded.size).toBe(1);
      expect(reloaded.list().items[0]!.resource).toBe("https://api.example.com/weather");
    });

    it("drops a row whose payload is not JSON instead of crashing", async () => {
      // The corrupt-FILE case became the corrupt-ROW case. Corrupt persistence
      // must never stop the facilitator starting — but it must also not take the
      // whole catalog down with one bad row.
      //
      // MUTATION THAT MUST BREAK THIS: remove the try/catch around
      // JSON.parse(row.payload) in load(). The throw escapes create() and the
      // service fails to boot on a single malformed row.
      const url = `file:${join(dir, "corrupt.db")}`;
      await seedRows(url, {
        ownership: [
          { key: "https://good.example/r", payTo: "GOWNER" },
          { key: "https://bad.example/r", payTo: "GOWNER" },
        ],
        entries: [
          { key: "https://bad.example/r", payload: "{not json" },
          {
            key: "https://good.example/r",
            payload: {
              resource: {
                resource: "https://good.example/r",
                type: "http",
                x402Version: 2,
                lastUpdated: "2026-08-01T00:00:00.000Z",
                accepts: [
                  { scheme: "exact", network: "stellar:testnet", asset: "CASSET", amount: "1", payTo: "GOWNER" },
                ],
              },
              stats: { settlements: 0, payers: [], observed: 0 },
            },
          },
        ],
      });
      const catalog = await BazaarCatalog.create(reopen(url));
      expect(catalog.size, "the good row survives; only the bad one is dropped").toBe(1);
    });
  });
});

// ── SEARCH QUALITY ────────────────────────────────────────────────────────────
//
// The scorer drops anything scoring 0, so a query sharing no literal token with
// any listing returns NOTHING — not a weak ranking, an empty list. That was the
// real failure mode: "unique identifier" found no UUID generator because the
// word "uuid" never appeared in the query. These tests are the ground truth for
// docs/search-eval.md, and they are what a future scorer change is measured
// against.
//
// Fixtures mirror the live demo catalog's own serviceName/description/tags text
// rather than inventing convenient wording — a synonym map tuned to fixtures
// that do not exist would pass here and fail in production.
describe("search quality — synonyms, stemming, trust ranking", () => {
  const PAYER_A = "GPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const PAYER_B = "GPAYERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const OWNER = "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A";

  /** The demo catalog, as it actually reads in production. */
  async function demoCatalog() {
    const catalog = await BazaarCatalog.create();
    const add = (url: string, serviceName: string, description: string, tags: string[]) =>
      catalog.upsertFromPayment(
        discovered({ resourceUrl: url, serviceName, description, tags }),
        requirements(),
      );
    await add("https://demo.example.com/uuid", "UUID Generator",
      "Returns a fresh UUID v4 with a SHA-256 fingerprint. Each call is unique and independently verifiable.",
      ["uuid", "identifier", "unique", "guid", "fingerprint", "verifiable"]);
    await add("https://demo.example.com/hash", "Text Hasher",
      "Give it any text, get back SHA-256 and MD5 hashes. Results are independently verifiable.",
      ["hash", "sha256", "md5", "checksum", "fingerprint", "text", "verifiable"]);
    await add("https://demo.example.com/timestamp", "Trusted Timestamp",
      "Returns the current time anchored to the Stellar ledger sequence number — a verifiable timestamp from the chain.",
      ["timestamp", "time", "ledger", "stellar", "verifiable", "clock"]);
    await add("https://demo.example.com/base64", "Base64 Encoder/Decoder",
      "Encode or decode base64. Useful for reading raw x402 payment headers.",
      ["base64", "encode", "decode", "encoding", "x402", "header"]);
    await add("https://demo.example.com/stroops", "Stroop Converter",
      "Give it a USDC amount, get back the exact stroop value. Useful for building x402 payment payloads.",
      ["stroops", "xlm", "convert", "stellar", "usdc", "payment"]);
    return catalog;
  }
  const top = (c: BazaarCatalog, query: string) => c.search({ query }).resources[0]?.resource;

  it("1. 'unique identifier' finds the UUID endpoint without the word uuid", async () => {
    const catalog = await demoCatalog();
    expect(top(catalog, "unique identifier")).toBe("https://demo.example.com/uuid");
  });

  it("2. 'verify content' finds the hash endpoint without the word hash", async () => {
    // MUTATION: remove "verify" from the hash synonym group. The query then
    // shares no token with any listing and search returns [] — the exact
    // empty-result failure this change exists to fix.
    const catalog = await demoCatalog();
    expect(top(catalog, "verify content")).toBe("https://demo.example.com/hash");
  });

  it("3. stemming: 'generating' finds 'UUID Generator'", async () => {
    // generating -> generat (‑ing), generator -> generat (‑er). Neither is a
    // substring of the other, so ONLY stemming connects them.
    const catalog = await demoCatalog();
    expect(top(catalog, "generating")).toBe("https://demo.example.com/uuid");
  });

  it("4. stemming: 'encoded' finds 'Base64 Encoder'", async () => {
    const catalog = await demoCatalog();
    expect(top(catalog, "encoded")).toBe("https://demo.example.com/base64");
  });

  it("7. 'time converter' reaches both the timestamp and stroops endpoints", async () => {
    // Two mechanisms in one query: "time" is a timestamp synonym, and
    // "converter" stems to "convert", which is a stroops synonym.
    const catalog = await demoCatalog();
    const urls = catalog.search({ query: "time converter" }).resources.map((r) => r.resource);
    expect(urls).toContain("https://demo.example.com/timestamp");
    expect(urls).toContain("https://demo.example.com/stroops");
  });

  it("5. an empty query ranks by trust, not by recency", async () => {
    // MUTATION: revert the empty-query branch to `return 1`. Every score ties,
    // the sort falls to the lastUpdated tiebreak, and the NEWEST entry wins —
    // which is `busy` here only by accident of insertion order, so the
    // assertion below is written to fail on that.
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(
      discovered({ resourceUrl: "https://demo.example.com/busy", serviceName: "Busy" }),
      requirements(),
    );
    await catalog.upsertFromPayment(
      discovered({ resourceUrl: "https://demo.example.com/quiet", serviceName: "Quiet" }),
      requirements(),
    );
    // `quiet` is the more RECENT entry but the less used one.
    catalog.recordSettlement("https://demo.example.com/quiet", PAYER_A, OWNER);
    for (let i = 0; i < 5; i++) {
      catalog.recordSettlement("https://demo.example.com/busy", i % 2 ? PAYER_A : PAYER_B, OWNER);
    }

    const urls = catalog.search({ query: "" }).resources.map((r) => r.resource);
    expect(urls[0], "proven use outranks recency").toBe("https://demo.example.com/busy");
    expect(urls).toContain("https://demo.example.com/quiet");
  });

  it("6. an unsettled entry is absent from empty-query results but still findable", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(
      discovered({ resourceUrl: "https://demo.example.com/proven", serviceName: "Proven" }),
      requirements(),
    );
    await catalog.upsertFromPayment(
      discovered({ resourceUrl: "https://demo.example.com/brandnew", serviceName: "Brandnew" }),
      requirements(),
    );
    catalog.recordSettlement("https://demo.example.com/proven", PAYER_A, OWNER);

    const browsing = catalog.search({ query: "" }).resources.map((r) => r.resource);
    expect(browsing).toEqual(["https://demo.example.com/proven"]);

    // Absent from UNDIRECTED browsing only — a directed query still finds it,
    // which is what keeps this a ranking rule rather than a hidden entry.
    expect(top(catalog, "brandnew")).toBe("https://demo.example.com/brandnew");
  });

  it("9. synonym expansion does not change the cursor hash for a raw query", async () => {
    // hashKey() is computed from params.query, never from the expanded tokens —
    // so editing the synonym map cannot invalidate in-flight cursors.
    const catalog = await BazaarCatalog.create();
    for (let i = 0; i < 3; i++) {
      await catalog.upsertFromPayment(
        discovered({ resourceUrl: `https://demo.example.com/u${i}`, serviceName: "UUID Generator" }),
        requirements(),
      );
    }
    const page1 = catalog.search({ query: "unique identifier", limit: 2 });
    expect(page1.pagination?.cursor).toBeTruthy();
    const page2 = catalog.search({
      query: "unique identifier",
      limit: 2,
      cursor: page1.pagination!.cursor!,
    });
    expect(page2.resources.length, "cursor resumed rather than resetting to page 1").toBe(1);
  });

  it("stem() applies one rule per call and guards short words", () => {
    expect(stem("generating")).toBe("generat");
    expect(stem("encoded")).toBe("encod");
    expect(stem("encoder")).toBe("encod");
    expect(stem("identifiers")).toBe("identifier");
    expect(stem("independently")).toBe("independent");
    expect(stem("conversion")).toBe("convert");
    // "ss" is exempt, so an address does not become an "addres".
    expect(stem("address")).toBe("address");
    // Short words survive intact rather than being eaten to noise.
    expect(stem("ing")).toBe("ing");
    expect(stem("ted")).toBe("ted");
  });

  it("expandWithSynonyms is bidirectional and one hop only", () => {
    expect(expandWithSynonyms(["uuid"])).toContain("identifier");
    expect(expandWithSynonyms(["identifier"]), "the reverse direction").toContain("uuid");
    // One hop: "id" reaches its own group, not the whole map transitively.
    expect(expandWithSynonyms(["uuid"])).not.toContain("timestamp");
    // An unknown token passes through untouched rather than vanishing.
    expect(expandWithSynonyms(["zzzz"])).toEqual(["zzzz"]);
  });
});
