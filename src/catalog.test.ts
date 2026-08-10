import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { afterAll, describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";
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
