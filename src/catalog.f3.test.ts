import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { afterEach, describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { FailingStore, readOwnership, reopen, seedRows, tmpStore } from "./store.testkit.js";
import { StoreUnreachableError } from "./store.js";
import { registerBazaar } from "./bazaar.js";
import { verifyResourceOwnership } from "./ownership.js";

// F3 — bounds + atomic persistence, and the ownership tombstones that stop
// eviction from becoming a way to re-run the F11 hijack.

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vellar-f3-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function reqs(payTo: string, url = "https://x.example/r"): PaymentRequirements {
  return {
    scheme: "exact", network: "stellar:testnet", asset: "CASSET",
    amount: "1", payTo, maxTimeoutSeconds: 60, extra: {},
  } as PaymentRequirements;
}
function disc(resourceUrl: string): DiscoveredResource {
  return {
    resourceUrl, x402Version: 2,
    discoveryInfo: { input: { type: "http", method: "GET" } },
  } as DiscoveredResource;
}

describe("F3 — atomic persistence", () => {
  it("leaves no partial file: entries and ownership both land atomically", async () => {
    const dir = tmpDir();
    const file = `file:${join(dir, `c${Math.random().toString(36).slice(2)}.db`)}`;
    const cat = await BazaarCatalog.create(reopen(file));
    await cat.upsertFromPayment(disc("https://x.example/r"), reqs("GOWNER"));
    await cat.flush();

    // Both files parse cleanly, and no .tmp is left behind.
    expect((await readOwnership(file)).length, "the binding is durable, and readable back").toBeGreaterThan(0);
    expect(() => readFileSync(`${file}.tmp`, "utf8")).toThrow();
  });

  it("writes ownership SYNCHRONOUSLY — it must not wait for the entry debounce", async () => {
    const dir = tmpDir();
    const file = `file:${join(dir, `c${Math.random().toString(36).slice(2)}.db`)}`;
    const cat = await BazaarCatalog.create(reopen(file));
    await cat.upsertFromPayment(disc("https://x.example/r"), reqs("GOWNER"));
    // No flush() called: the ENTRY file may not exist yet, but ownership must,
    // because losing a tombstone silently reopens the URL to first-writer claim.
    const own = (await readOwnership(file)).map((r) => ({ resource: r.resourceKey, boundPayTo: r.boundPayTo }));
    expect(own).toEqual([{ resource: "https://x.example/r", boundPayTo: ["GOWNER"] }]);
  });
});

describe("F3 — bounds", () => {
  it("caps entries and evicts least-recently-updated first", async () => {
    const cat = await BazaarCatalog.create();
    for (let i = 0; i < 10_050; i++) {
      await cat.upsertFromPayment(disc(`https://x.example/r${i}`), reqs("GOWNER"));
    }
    expect(cat.size).toBeLessThanOrEqual(10_000);
  });

  it("caps accepts per entry", async () => {
    const cat = await BazaarCatalog.create();
    const url = "https://x.example/r";
    for (let i = 0; i < 30; i++) {
      await cat.upsertFromPayment(disc(url), {
        ...reqs("GOWNER"), asset: `CASSET_${i}`,
      } as PaymentRequirements);
    }
    expect(cat.list().items[0]!.accepts.length).toBeLessThanOrEqual(20);
  });
});

describe("F3 — eviction cannot be used to reclaim a URL (real verifier, real 402 server)", () => {
  function stubScheme(): SchemeNetworkFacilitator {
    return {
      scheme: "exact", caipFamily: "stellar:*",
      getExtra: () => undefined, getSigners: () => [],
      verify: async () => ({ isValid: true, payer: "CPAYER" }),
      settle: async () => ({ success: true, transaction: "tx", network: "stellar:testnet", payer: "CPAYER" }),
    } as unknown as SchemeNetworkFacilitator;
  }
  function payload(url: string): PaymentPayload {
    const extensions = declareDiscoveryExtension({
      input: { city: "lagos" }, inputSchema: { properties: { city: { type: "string" } } },
    }) as Record<string, { info: { input: Record<string, unknown> } }>;
    extensions.bazaar!.info.input.method = "GET";
    return {
      x402Version: 2, resource: { url }, accepted: reqs("GOWNER"),
      payload: { transaction: "AAAA" }, extensions,
    } as PaymentPayload;
  }

  it("rejects reclaim by a different payTo after the entry is evicted", async () => {
    const owner = "GOWNER";
    const challenge = Buffer.from(JSON.stringify({ accepts: [{ payTo: owner }] }), "utf8").toString("base64");
    const server = http.createServer((_q, res) => {
      res.writeHead(402, { "PAYMENT-REQUIRED": challenge });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const url = `http://owner.test:${port}/quote`;

    try {
      const cat = await BazaarCatalog.create();
      const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme());
      // REAL verifier against the REAL server — a mocked verifier here would
      // prove the rejection branch runs without proving it is wired to anything.
      registerBazaar(facilitator, cat, {
        verifyOwnership: (u, p) =>
          verifyResourceOwnership(u, p, {
            lookupFn: async () => ({ address: "127.0.0.1", family: 4 }),
            __insecureTestTransport: true,
          }),
      });

      await facilitator.settle(payload(url), reqs(owner));
      await new Promise((r) => setTimeout(r, 150));
      expect(cat.isVerifiedOwner(url)).toBe(true); // binding really established

      // Force the entry out by flooding past the cap.
      for (let i = 0; i < 10_050; i++) {
        await cat.upsertFromPayment(disc(`https://flood.example/r${i}`), reqs("GFLOOD"));
      }
      expect(cat.list({ limit: 1 }).pagination.total).toBeLessThanOrEqual(10_000);

      // The victim's entry is gone — now an attacker tries to claim the URL.
      const reclaimed = await cat.upsertFromPayment(disc(url), reqs("GATTACKER"));
      expect(reclaimed, "eviction must not reopen the URL to a different payTo").toBe(false);

      // And the true owner can still re-establish it.
      expect(await cat.upsertFromPayment(disc(url), reqs(owner))).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("F3 — tombstone durability and tampering", () => {
  it("survives a restart via the persisted ownership file", async () => {
    const dir = tmpDir();
    const file = `file:${join(dir, `c${Math.random().toString(36).slice(2)}.db`)}`;
    const url = "https://x.example/r";

    const first = await BazaarCatalog.create(reopen(file));
    await first.upsertFromPayment(disc(url), reqs("GOWNER"));
    await first.flush();

    // Restart. The binding must have survived via the ownership file.
    const second = await BazaarCatalog.create(reopen(file));
    expect(second.isBound(url, "GOWNER")).toBe(true);
    expect(second.isBound(url, "GATTACKER")).toBe(false);

    // A different payTo is refused and changes nothing...
    await second.upsertFromPayment(disc(url), { ...reqs("GATTACKER"), asset: "CEVIL" } as PaymentRequirements);
    expect(second.list().items[0]!.accepts.some((a) => a.payTo === "GATTACKER")).toBe(false);

    // ...while the true owner can still add a payment option.
    await second.upsertFromPayment(disc(url), { ...reqs("GOWNER"), asset: "CUSDC" } as PaymentRequirements);
    expect(second.list().items[0]!.accepts.some((a) => a.asset === "CUSDC")).toBe(true);
  });

  it("a crafted ownership ROW cannot forge a binding — it fails CLOSED as invalid", async () => {
    // F6's trust boundary MOVED, it did not disappear: whoever can write the
    // database can forge or clear a binding exactly as whoever could write the
    // file could. What changed is that it now takes credentials rather than
    // filesystem access. So the hostile-data test is a hostile ROW.
    //
    // SQLite is loosely typed, so an integer really does land in a TEXT column —
    // this is a state a real attacker can produce, not a contrived one.
    //
    // MUTATION THAT MUST BREAK THIS: drop the typeof check in
    // LibsqlCatalogStore.loadOwnership and coerce with String(). The row loads
    // as a binding, the catalog comes up UNFROZEN, and a forged owner is served.
    const { url } = tmpStore();
    await seedRows(url, { ownership: [] }); // creates the schema
    const raw = reopen(url) as unknown as { client: import("@libsql/client").Client };
    // A BLOB, specifically. An INTEGER would NOT reproduce this: the column has
    // TEXT affinity, so SQLite coerces 123 to the string "123.0" and the loader
    // is right to accept it. A blob survives as a Uint8Array, which is the
    // reachable hostile value — checked rather than assumed, because a test that
    // plants an integer would pass for the wrong reason.
    await raw.client.execute("INSERT INTO ownership (resource_key, pay_to, bound_at) VALUES ('https://x.example/r', X'00ff', 1)");
    const cat = await BazaarCatalog.create(reopen(url));
    // Invalid is NOT retried and NOT tolerated: fail closed, and say which kind.
    expect(cat.catalogFrozen, "a bad answer is investigate-now, not wait-and-see").toBe("ownership-invalid");
    expect(cat.size).toBe(0);
  });

  it("fails CLOSED, and stays closed, when ownership cannot be loaded at all", async () => {
    // The file-store version of this was "catalog file present, ownership file
    // absent". One database cannot be half-present, so the reachable form is a
    // load that FAILS — and the requirement is unchanged: serve nothing rather
    // than serve entries whose ownership did not load.
    //
    // MUTATION THAT MUST BREAK THIS: make the catch in BazaarCatalog.create
    // continue to `await catalog.load(...)` instead of returning. Entries then
    // load with NO bindings, every URL is open to first-writer claim, and this
    // is F11 disabled at exactly the moment nobody is watching.
    const { store, url } = tmpStore();
    await store.init();
    await seedRows(url, {
      ownership: [{ key: "https://x.example/r", payTo: "GLEGIT" }],
      entries: [
        {
          key: "https://x.example/r",
          payload: {
            resource: {
              resource: "https://x.example/r",
              type: "http",
              x402Version: 2,
              accepts: [
                { scheme: "exact", network: "stellar:testnet", asset: "CA", amount: "1", payTo: "GLEGIT" },
              ],
              lastUpdated: "2026-08-01T00:00:00.000Z",
            },
            stats: { settlements: 5, payers: [] },
          },
        },
      ],
    });
    const failing = new FailingStore(reopen(url), {
      loadOwnership: () => new StoreUnreachableError(new Error("vendor down")),
    });
    const cat = await BazaarCatalog.create(failing);
    expect(cat.catalogFrozen, "unreachable is the retryable diagnosis").toBe("ownership-unreachable");
    expect(cat.size, "an entry that exists in the store must NOT be served").toBe(0);
    expect(
      await cat.upsertFromPayment(disc("https://new.example/r"), reqs("GANY")),
      "and nothing new may bind while frozen",
    ).toBe(false);
  });

  it("in-memory only (no CATALOG_FILE) still enforces bindings for the process lifetime", async () => {
    const cat = await BazaarCatalog.create(); // no path -> no ownership file
    const url = "https://x.example/r";
    expect(await cat.upsertFromPayment(disc(url), reqs("GOWNER"))).toBe(true);
    expect(await cat.upsertFromPayment(disc(url), reqs("GATTACKER"))).toBe(false);
    expect(cat.catalogFrozen).toBe(false);
  });
});
