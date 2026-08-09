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
import { BazaarCatalog, ownershipPathFor } from "./catalog.js";
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
afterEach(() => {
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
  it("leaves no partial file: entries and ownership both land atomically", () => {
    const dir = tmpDir();
    const file = join(dir, "catalog.json");
    const cat = new BazaarCatalog(file);
    cat.upsertFromPayment(disc("https://x.example/r"), reqs("GOWNER"));
    cat.flush();

    // Both files parse cleanly, and no .tmp is left behind.
    expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
    expect(() => JSON.parse(readFileSync(ownershipPathFor(file), "utf8"))).not.toThrow();
    expect(() => readFileSync(`${file}.tmp`, "utf8")).toThrow();
  });

  it("writes ownership SYNCHRONOUSLY — it must not wait for the entry debounce", () => {
    const dir = tmpDir();
    const file = join(dir, "catalog.json");
    const cat = new BazaarCatalog(file);
    cat.upsertFromPayment(disc("https://x.example/r"), reqs("GOWNER"));
    // No flush() called: the ENTRY file may not exist yet, but ownership must,
    // because losing a tombstone silently reopens the URL to first-writer claim.
    const own = JSON.parse(readFileSync(ownershipPathFor(file), "utf8"));
    expect(own).toEqual([{ resource: "https://x.example/r", boundPayTo: ["GOWNER"] }]);
  });
});

describe("F3 — bounds", () => {
  it("caps entries and evicts least-recently-updated first", () => {
    const cat = new BazaarCatalog();
    for (let i = 0; i < 10_050; i++) {
      cat.upsertFromPayment(disc(`https://x.example/r${i}`), reqs("GOWNER"));
    }
    expect(cat.size).toBeLessThanOrEqual(10_000);
  });

  it("caps accepts per entry", () => {
    const cat = new BazaarCatalog();
    const url = "https://x.example/r";
    for (let i = 0; i < 30; i++) {
      cat.upsertFromPayment(disc(url), {
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
      const cat = new BazaarCatalog();
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
        cat.upsertFromPayment(disc(`https://flood.example/r${i}`), reqs("GFLOOD"));
      }
      expect(cat.list({ limit: 1 }).pagination.total).toBeLessThanOrEqual(10_000);

      // The victim's entry is gone — now an attacker tries to claim the URL.
      const reclaimed = cat.upsertFromPayment(disc(url), reqs("GATTACKER"));
      expect(reclaimed, "eviction must not reopen the URL to a different payTo").toBe(false);

      // And the true owner can still re-establish it.
      expect(cat.upsertFromPayment(disc(url), reqs(owner))).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("F3 — tombstone durability and tampering", () => {
  it("survives a restart via the persisted ownership file", () => {
    const dir = tmpDir();
    const file = join(dir, "catalog.json");
    const url = "https://x.example/r";

    const first = new BazaarCatalog(file);
    first.upsertFromPayment(disc(url), reqs("GOWNER"));
    first.flush();

    // Restart. The binding must have survived via the ownership file.
    const second = new BazaarCatalog(file);
    expect(second.isBound(url, "GOWNER")).toBe(true);
    expect(second.isBound(url, "GATTACKER")).toBe(false);

    // A different payTo is refused and changes nothing...
    second.upsertFromPayment(disc(url), { ...reqs("GATTACKER"), asset: "CEVIL" } as PaymentRequirements);
    expect(second.list().items[0]!.accepts.some((a) => a.payTo === "GATTACKER")).toBe(false);

    // ...while the true owner can still add a payment option.
    second.upsertFromPayment(disc(url), { ...reqs("GOWNER"), asset: "CUSDC" } as PaymentRequirements);
    expect(second.list().items[0]!.accepts.some((a) => a.asset === "CUSDC")).toBe(true);
  });

  it("a crafted ownership file cannot FORGE a binding into a malformed shape", () => {
    const dir = tmpDir();
    const file = join(dir, "catalog.json");
    writeFileSync(file, JSON.stringify([]));
    // Structurally invalid ownership rows must not load as bindings.
    writeFileSync(ownershipPathFor(file), JSON.stringify([{ resource: 123, boundPayTo: "not-an-array" }]));
    const cat = new BazaarCatalog(file);
    // Schema rejected the file -> fail closed, not silently accepted.
    expect(cat.catalogFrozen).toBe("ownership-unreadable");
  });

  it("fails CLOSED when the catalog loads but ownership is missing", () => {
    const dir = tmpDir();
    const file = join(dir, "catalog.json");
    writeFileSync(file, JSON.stringify([
      {
        resource: {
          resource: "https://x.example/r", type: "http", x402Version: 2,
          accepts: [{ scheme: "exact", network: "stellar:testnet", asset: "CA", amount: "1", payTo: "GLEGIT" }],
          lastUpdated: "2026-08-01T00:00:00.000Z",
        },
        stats: { settlements: 5, payers: [] },
      },
    ]));
    // No ownership file — the state a tampering attacker (or a half-finished
    // deploy) produces. Serving the catalog with absent bindings would reopen
    // every URL, so we refuse both.
    const cat = new BazaarCatalog(file);
    expect(cat.catalogFrozen).toBe("ownership-unreadable");
    expect(cat.size).toBe(0);
    expect(cat.upsertFromPayment(disc("https://new.example/r"), reqs("GANY"))).toBe(false);
  });

  it("in-memory only (no CATALOG_FILE) still enforces bindings for the process lifetime", () => {
    const cat = new BazaarCatalog(); // no path -> no ownership file
    const url = "https://x.example/r";
    expect(cat.upsertFromPayment(disc(url), reqs("GOWNER"))).toBe(true);
    expect(cat.upsertFromPayment(disc(url), reqs("GATTACKER"))).toBe(false);
    expect(cat.catalogFrozen).toBe(false);
  });
});
