import { describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { assertRoutableResourceUrl } from "./ownership.js";
import { seedRows, tmpStore } from "./store.testkit.js";

// scan-unroutable-urls.ts's own logic, extracted for testing without the
// CATALOG_DB_URL env var / process.exit machinery its main() wraps around
// it. The script itself is a thin CLI shell around exactly this walk —
// tested here so the actual scanning logic (page through catalog.list(),
// check every distinct network in accepts[], collect findings) is proven
// correct independent of how the script is invoked.
async function scan(catalog: BazaarCatalog): Promise<
  Array<{ resourceUrl: string; network: string; reason: string }>
> {
  const findings: Array<{ resourceUrl: string; network: string; reason: string }> = [];
  let offset = 0;
  for (;;) {
    const page = catalog.list({ limit: 100, offset });
    for (const item of page.items) {
      const networks = new Set(item.accepts.map((a) => a.network));
      if (networks.size === 0) networks.add("stellar:testnet");
      for (const network of networks) {
        const verdict = assertRoutableResourceUrl(item.resource, network);
        if (!verdict.ok) findings.push({ resourceUrl: item.resource, network, reason: verdict.reason });
      }
    }
    if (page.items.length < 100) break;
    offset += 100;
  }
  return findings;
}

// Rows seeded DIRECTLY via seedRows, bypassing upsertFromPayment entirely —
// this is deliberate: it proves the scan catches an entry that predates the
// registration gate (the exact real-world shape of the incident: a bad URL
// that got in BEFORE the gate existed, which is precisely what this script
// exists to find). Going through upsertFromPayment would just prove the
// gate works again, which src/catalog.unverifiable.test.ts already covers.
//
// Shape matches storedEntrySchema/storedResourceSchema in catalog.ts
// EXACTLY (resource.resource is the URL string, a required `type` field,
// `lastUpdated` on the resource itself) — this is the real on-disk shape,
// not a guess, confirmed by reading those schemas directly.
function storedEntry(resourceUrl: string, network: string, payTo: string) {
  return {
    resource: {
      resource: resourceUrl,
      type: "http" as const,
      x402Version: 2,
      accepts: [{ scheme: "exact", network, asset: "CTEST", amount: "1", payTo, maxTimeoutSeconds: 60, extra: {} }],
      lastUpdated: new Date().toISOString(),
      description: "test",
      mimeType: "application/json",
      serviceName: "TestSvc",
      tags: [],
    },
    stats: { settlements: 0, payers: [] },
  };
}

describe("scan-unroutable-urls — finds entries the registration gate would now refuse", () => {
  it("finds the exact incident shape: http://localhost:<port>/... seeded before the gate existed", async () => {
    const { store, url } = tmpStore();
    await seedRows(url, {
      ownership: [{ key: "http://localhost:4002/lifecycle/execute", payTo: "GOWNER" }],
      entries: [
        {
          key: "http://localhost:4002/lifecycle/execute",
          payload: storedEntry("http://localhost:4002/lifecycle/execute", "stellar:pubnet", "GOWNER"),
        },
      ],
    });
    const catalog = await BazaarCatalog.create(store);
    const findings = await scan(catalog);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      resourceUrl: "http://localhost:4002/lifecycle/execute",
      network: "stellar:pubnet",
      reason: "localhost_or_loopback_literal",
    });
    await store.close();
  });

  it("finds nothing in a clean catalog", async () => {
    const { store, url } = tmpStore();
    await seedRows(url, {
      ownership: [{ key: "https://good.example.com/quote", payTo: "GOWNER" }],
      entries: [
        {
          key: "https://good.example.com/quote",
          payload: storedEntry("https://good.example.com/quote", "stellar:pubnet", "GOWNER"),
        },
      ],
    });
    const catalog = await BazaarCatalog.create(store);
    const findings = await scan(catalog);
    expect(findings).toHaveLength(0);
  });

  it("checks EVERY distinct network in accepts[], not just the first", async () => {
    // A resource offering exact on both testnet (http, legitimately) and
    // pubnet (http, NOT legitimate) in the SAME accepts[] array — the exact
    // shape vellar-seller-demo's own live entry has (two accepts, two
    // networks), just with the pubnet leg deliberately broken here.
    const { store, url } = tmpStore();
    await seedRows(url, {
      ownership: [{ key: "http://good.example.com/quote", payTo: "GOWNER" }],
      entries: [
        {
          key: "http://good.example.com/quote",
          payload: {
            resource: {
              resource: "http://good.example.com/quote",
              type: "http" as const,
              x402Version: 2,
              accepts: [
                { scheme: "exact", network: "stellar:testnet", asset: "CTEST", payTo: "GOWNER", amount: "1", maxTimeoutSeconds: 60, extra: {} },
                { scheme: "exact", network: "stellar:pubnet", asset: "CTEST", payTo: "GOWNER", amount: "1", maxTimeoutSeconds: 60, extra: {} },
              ],
              lastUpdated: new Date().toISOString(),
              description: "test",
              mimeType: "application/json",
              serviceName: "TestSvc",
              tags: [],
            },
            stats: { settlements: 0, payers: [] },
          },
        },
      ],
    });
    const catalog = await BazaarCatalog.create(store);
    const findings = await scan(catalog);
    // testnet leg is fine (http is legitimate there); only the pubnet leg
    // should be flagged.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.network).toBe("stellar:pubnet");
    expect(findings[0]?.reason).toBe("non_https_on_pubnet");
  });

  it("finds multiple bad entries across a catalog with mostly-good ones", async () => {
    const { store, url } = tmpStore();
    await seedRows(url, {
      ownership: [
        { key: "https://good1.example.com/a", payTo: "G1" },
        { key: "http://localhost/b", payTo: "G2" },
        { key: "https://good2.example.com/c", payTo: "G3" },
        { key: "https://192.168.1.1/d", payTo: "G4" },
      ],
      entries: [
        { key: "https://good1.example.com/a", payload: storedEntry("https://good1.example.com/a", "stellar:pubnet", "G1") },
        { key: "http://localhost/b", payload: storedEntry("http://localhost/b", "stellar:pubnet", "G2") },
        { key: "https://good2.example.com/c", payload: storedEntry("https://good2.example.com/c", "stellar:pubnet", "G3") },
        { key: "https://192.168.1.1/d", payload: storedEntry("https://192.168.1.1/d", "stellar:pubnet", "G4") },
      ],
    });
    const catalog = await BazaarCatalog.create(store);
    const findings = await scan(catalog);
    expect(findings).toHaveLength(2);
    const urls = findings.map((f) => f.resourceUrl).sort();
    expect(urls).toEqual(["http://localhost/b", "https://192.168.1.1/d"]);
  });

  it("does not mutate anything — the catalog size is unchanged after a scan", async () => {
    const { store, url } = tmpStore();
    await seedRows(url, {
      ownership: [{ key: "http://localhost/x", payTo: "GOWNER" }],
      entries: [{ key: "http://localhost/x", payload: storedEntry("http://localhost/x", "stellar:pubnet", "GOWNER") }],
    });
    const catalog = await BazaarCatalog.create(store);
    const before = catalog.size;
    await scan(catalog);
    expect(catalog.size).toBe(before);
  });
});
