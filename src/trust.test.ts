import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { BazaarCatalog } from "./catalog.js";
import {
  annotateTrust,
  createTrustResolver,
  filterVerifiedOnly,
  rerankVerifiedFirst,
  type TrustedDiscoveryResource,
  type TrustResolver,
} from "./trust.js";

const VERIFIED_HASH = "ab".repeat(32);

function historyResponse(status: string, outputHash?: string) {
  return {
    ok: true,
    json: async () => ({ records: [{ status, ...(outputHash ? { outputHash } : {}) }] }),
  } as Response;
}

function fixedResolver(map: Record<string, "verified" | "unverified" | "unknown">): TrustResolver {
  return { assetStatus: async (id) => map[id] ?? "unknown" };
}

function item(asset: string | string[], over: Partial<TrustedDiscoveryResource> = {}): TrustedDiscoveryResource {
  const assets = Array.isArray(asset) ? asset : [asset];
  return {
    resource: "https://api.example.com/r",
    type: "http",
    x402Version: 2,
    accepts: assets.map(
      (a) =>
        ({
          scheme: "exact",
          network: "stellar:testnet",
          asset: a,
          amount: "1",
          payTo: "G",
          maxTimeoutSeconds: 60,
          extra: {},
        }) as PaymentRequirements,
    ),
    lastUpdated: new Date().toISOString(),
    ...over,
  };
}

describe("createTrustResolver", () => {
  it("returns unknown when no verification API is configured", async () => {
    const resolver = createTrustResolver({});
    expect(await resolver.assetStatus("CASSET")).toBe("unknown");
  });

  it("maps a latest-verified record to verified", async () => {
    const fetchFn = vi.fn(async () => historyResponse("verified", VERIFIED_HASH));
    const resolver = createTrustResolver({ verificationApiUrl: "http://v/verification", fetchFn });
    expect(await resolver.assetStatus("CASSET")).toBe("verified");
    expect(fetchFn).toHaveBeenCalledWith("http://v/verification/CASSET");
  });

  it("maps failed / empty history to unverified", async () => {
    const failed = createTrustResolver({
      verificationApiUrl: "http://v",
      fetchFn: vi.fn(async () => historyResponse("failed")),
    });
    expect(await failed.assetStatus("CA")).toBe("unverified");

    const empty = createTrustResolver({
      verificationApiUrl: "http://v",
      fetchFn: vi.fn(async () => ({ ok: true, json: async () => ({ records: [] }) }) as Response),
    });
    expect(await empty.assetStatus("CB")).toBe("unverified");
  });

  it("degrades to unknown when the verification API is unreachable", async () => {
    const resolver = createTrustResolver({
      verificationApiUrl: "http://v",
      fetchFn: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    });
    expect(await resolver.assetStatus("CASSET")).toBe("unknown");
  });

  it("caches verdicts (one fetch per contract within the TTL)", async () => {
    const fetchFn = vi.fn(async () => historyResponse("verified", VERIFIED_HASH));
    const resolver = createTrustResolver({ verificationApiUrl: "http://v", fetchFn });
    await resolver.assetStatus("CASSET");
    await resolver.assetStatus("CASSET");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("downgrades verified to unverified when the LIVE wasm hash drifted (TOCTOU)", async () => {
    const resolver = createTrustResolver({
      verificationApiUrl: "http://v",
      fetchFn: vi.fn(async () => historyResponse("verified", VERIFIED_HASH)),
      rpcServer: {
        getContractData: async () => makeContractDataEntry("cd".repeat(32)),
      } as never,
    });
    expect(await resolver.assetStatus("CASSET")).toBe("unverified");
  });

  it("keeps the verified verdict when the live hash matches", async () => {
    const resolver = createTrustResolver({
      verificationApiUrl: "http://v",
      fetchFn: vi.fn(async () => historyResponse("verified", VERIFIED_HASH)),
      rpcServer: {
        getContractData: async () => makeContractDataEntry(VERIFIED_HASH),
      } as never,
    });
    expect(await resolver.assetStatus("CASSET")).toBe("verified");
  });

  it("keeps the API verdict when the live-hash check errors (uncertainty never downgrades)", async () => {
    const resolver = createTrustResolver({
      verificationApiUrl: "http://v",
      fetchFn: vi.fn(async () => historyResponse("verified", VERIFIED_HASH)),
      rpcServer: {
        getContractData: async () => {
          throw new Error("rpc down");
        },
      } as never,
    });
    expect(await resolver.assetStatus("CASSET")).toBe("verified");
  });
});

/** Minimal shape of an rpc getContractData entry carrying a wasm executable. */
function makeContractDataEntry(hashHex: string) {
  const wasmHash = Buffer.from(hashHex, "hex");
  return {
    val: {
      contractData: () => ({
        val: () => ({
          instance: () => ({
            executable: () => ({
              // The real enum singleton: trust.ts compares by identity.
              switch: () => xdr.ContractExecutableType.contractExecutableWasm(),
              wasmHash: () => wasmHash,
            }),
          }),
        }),
      }),
    },
  };
}

describe("annotateTrust precedence", () => {
  it("all assets verified ⇒ verified; any unverified ⇒ unverified; else unknown", async () => {
    const resolver = fixedResolver({ CV: "verified", CU: "unverified", CX: "unknown" });

    // Fix 0 Layer 3: "verified" now also requires the owner to have passed the
    // Layer 2 402 challenge, so these precedence cases pass an owner-verified
    // check. (Asset-precedence itself is unchanged: any unverified ⇒ unverified.)
    const ownerVerified = () => true;

    const [allVerified] = await annotateTrust([item(["CV"])], resolver, ownerVerified);
    expect(allVerified!.trust?.verification).toBe("verified");

    const [mixed] = await annotateTrust([item(["CV", "CU"])], resolver, ownerVerified);
    expect(mixed!.trust?.verification).toBe("unverified");

    const [withUnknown] = await annotateTrust([item(["CV", "CX"])], resolver, ownerVerified);
    expect(withUnknown!.trust?.verification).toBe("unknown");
  });

  it("preserves existing settlement stats while adding the verdict", async () => {
    const resolver = fixedResolver({ CV: "verified" });
    const withStats = item("CV", {
      trust: { settlements: 7, uniquePayers: 3, lastSettled: "2026-08-01T00:00:00Z" },
    });
    const [annotated] = await annotateTrust([withStats], resolver, () => true);
    expect(annotated!.trust).toEqual({
      settlements: 7,
      uniquePayers: 3,
      lastSettled: "2026-08-01T00:00:00Z",
      verification: "verified",
      acceptsVerification: ["verified"],
      ownerVerified: true,
    });
  });
});

describe("filter + rerank", () => {
  const verified = { ...item("CV"), trust: { settlements: 0, uniquePayers: 0, verification: "verified" as const } };
  const unverified = { ...item("CU"), trust: { settlements: 0, uniquePayers: 0, verification: "unverified" as const } };
  const unknown = { ...item("CX"), trust: { settlements: 0, uniquePayers: 0, verification: "unknown" as const } };

  it("filterVerifiedOnly keeps only verified", () => {
    expect(filterVerifiedOnly([verified, unverified, unknown])).toEqual([verified]);
  });

  it("rerankVerifiedFirst orders verified > unknown > unverified, stably", () => {
    const ranked = rerankVerifiedFirst([unverified, unknown, verified]);
    expect(ranked.map((r) => r.trust?.verification)).toEqual(["verified", "unknown", "unverified"]);
  });
});

describe("catalog settlement stats", () => {
  function seed(catalog: BazaarCatalog, url = "https://api.example.com/weather") {
    catalog.upsertFromPayment(
      {
        resourceUrl: url,
        x402Version: 2,
        discoveryInfo: { input: { type: "http", method: "GET" } },
      } as DiscoveredResource,
      {
        scheme: "exact",
        network: "stellar:testnet",
        asset: "CASSET",
        amount: "1",
        payTo: "G",
        maxTimeoutSeconds: 60,
        extra: {},
      } as PaymentRequirements,
    );
  }

  it("counts settlements and dedupes unique payers", () => {
    const catalog = new BazaarCatalog();
    seed(catalog);
    catalog.recordSettlement("https://api.example.com/weather", "CPAYER1");
    catalog.recordSettlement("https://api.example.com/weather", "CPAYER1");
    catalog.recordSettlement("https://api.example.com/weather", "CPAYER2");

    const trust = (catalog.list().items[0] as TrustedDiscoveryResource).trust;
    expect(trust?.settlements).toBe(3);
    expect(trust?.uniquePayers).toBe(2);
    expect(trust?.lastSettled).toBeTruthy();
  });

  it("ignores settlements for uncataloged resources", () => {
    const catalog = new BazaarCatalog();
    catalog.recordSettlement("https://nowhere.example.com/x", "CPAYER");
    expect(catalog.size).toBe(0);
  });

  it("stats survive re-upserts of the same resource", () => {
    const catalog = new BazaarCatalog();
    seed(catalog);
    catalog.recordSettlement("https://api.example.com/weather", "CPAYER1");
    seed(catalog); // repeat payment re-catalogs the resource
    const trust = (catalog.list().items[0] as TrustedDiscoveryResource).trust;
    expect(trust?.settlements).toBe(1);
    expect(trust?.uniquePayers).toBe(1);
  });
});
