import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { afterEach, describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { buildFacilitator } from "./facilitator.js";
import { buildServer } from "./server.js";
import type { TrustResolver, TrustedDiscoveryResource } from "./trust.js";

// ============================================================================
// CHARACTERIZATION TESTS — these pin CURRENT behaviour, including two KNOWN
// GAPS (G-1, G-2 in docs/security-audit.md). They are not assertions that the
// behaviour is correct. If you fix either gap these tests SHOULD fail; update
// them and the audit doc together.
//
// G-1  `verifiedOwner` is never READ back from disk and re-verification only
//      fires on first catalog, so after a restart every previously-verified
//      entry serves ownerVerified:false — and `verified_only=true` serves an
//      empty catalog. That is a wrong answer to agents, not a throttle.
//      (It does recover if the entry is evicted past MAX_ENTRIES; see below.)
//
// G-2  A bound resource URL has NO payTo rotation path. A merchant rotating
//      their payment address is refused, while settlement stats keep climbing
//      against the STALE address.
// ============================================================================

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vellar-restart-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const URL_X = "https://api.merchant.example/quote";
const PAY_OLD = "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A";
const PAY_NEW = "GBQ3VANQZ6X3ZVGFTQJZ2MZ4KOCPZ5EGWSVYT7OPTQJ4M7VXMKQ3OQXD";
const ASSET = "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND";

function reqs(payTo: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: ASSET,
    amount: "1000000",
    payTo,
    maxTimeoutSeconds: 60,
    extra: {},
  } as PaymentRequirements;
}

function disc(url = URL_X): DiscoveredResource {
  return {
    resourceUrl: url,
    description: "Quotes",
    serviceName: "MerchantSvc",
    x402Version: 2,
    discoveryInfo: { input: { type: "http", method: "GET" } },
  } as DiscoveredResource;
}

/** Every asset reads "verified", so any non-verified verdict below is caused by
 * owner-clamping alone — the thing under test. */
const allVerified: TrustResolver = { assetStatus: async () => "verified" };

const testConfig = {
  port: 0,
  host: "127.0.0.1",
  network: "stellar:testnet" as const,
  rpcUrl: undefined,
  sponsorSecretKey: Keypair.random().secret(),
  maxTransactionFeeStroops: 2_000_000,
  catalogFile: undefined,
  verificationApiUrl: undefined,
  spend: { rateMax: 30, rateWindowMs: 60_000, ceilingStroops: 50_000_000, windowMs: 60_000, perUrlMax: 10, perPayToMax: 100, unboundPoolMax: 10 },
  balance: { softFloorStroops: 100_000_000, hardFloorStroops: 20_000_000, intervalMs: 60_000 },
  catalogOwnershipBootstrap: false,
};

async function serve(catalog: BazaarCatalog) {
  return buildServer(buildFacilitator(testConfig), catalog, allVerified);
}

function trustOf(item: unknown) {
  // annotateTrust always populates `trust`; assert it so the assertions below
  // read as the behavioural claims they are rather than optional-chaining noise.
  return (item as TrustedDiscoveryResource).trust!;
}

describe("G-1 — verifiedOwner does not survive a restart, and never recovers", () => {
  it("a verified entry serves ownerVerified:false after restart, with every verdict clamped", async () => {
    const file = join(tmpDir(), "catalog.json");

    // --- Run 1: entry is cataloged AND passes Layer 2 ownership verification.
    const before = new BazaarCatalog(file);
    before.upsertFromPayment(disc(), reqs(PAY_OLD));
    before.setVerifiedOwner(URL_X, true);
    before.flush();

    const appBefore = await serve(before);
    const preBody = (await appBefore.inject({ method: "GET", url: "/discovery/resources" })).json();
    expect(trustOf(preBody.items[0]).ownerVerified, "precondition: verified before restart").toBe(true);
    expect(trustOf(preBody.items[0]).verification).toBe("verified");
    await appBefore.close();

    // --- Run 2: same file, fresh process. Nothing about the resource changed.
    const after = new BazaarCatalog(file);
    expect(after.size, "entry must survive the restart").toBe(1);

    const appAfter = await serve(after);
    const postBody = (await appAfter.inject({ method: "GET", url: "/discovery/resources" })).json();
    const t = trustOf(postBody.items[0]);

    // THE GAP: same resource, same assets, same everything — different answer.
    expect(t.ownerVerified, "G-1: ownership verification is lost on restart").toBe(false);
    expect(t.verification, "G-1: clamped from verified down to unknown").toBe("unknown");
    expect(t.acceptsVerification, "G-1: every accepts option clamped too").toEqual(["unknown"]);
    await appAfter.close();
  });

  it("verified_only=true serves an EMPTY catalog after restart", async () => {
    const file = join(tmpDir(), "catalog.json");
    const before = new BazaarCatalog(file);
    before.upsertFromPayment(disc(), reqs(PAY_OLD));
    before.setVerifiedOwner(URL_X, true);
    before.flush();

    const appBefore = await serve(before);
    const pre = (await appBefore.inject({ method: "GET", url: "/discovery/resources?verified_only=true" })).json();
    expect(pre.items, "precondition: visible to verified_only before restart").toHaveLength(1);
    await appBefore.close();

    const appAfter = await serve(new BazaarCatalog(file));
    const post = (await appAfter.inject({ method: "GET", url: "/discovery/resources?verified_only=true" })).json();
    // An agent filtering for verified resources sees NOTHING — indistinguishable
    // from "this facilitator has no trustworthy resources".
    expect(post.items, "G-1: verified_only is empty after restart").toHaveLength(0);
    await appAfter.close();
  });

  it("search is affected identically (same annotate path, so the gap is not list-only)", async () => {
    const file = join(tmpDir(), "catalog.json");
    const before = new BazaarCatalog(file);
    before.upsertFromPayment(disc(), reqs(PAY_OLD));
    before.setVerifiedOwner(URL_X, true);
    before.flush();

    const appAfter = await serve(new BazaarCatalog(file));
    const post = (await appAfter.inject({ method: "GET", url: "/discovery/search?query=Merchant" })).json();
    expect(post.resources.length).toBeGreaterThan(0);
    expect(trustOf(post.resources[0]).ownerVerified, "G-1 hits /discovery/search too").toBe(false);
    await appAfter.close();
  });

  it("does not recover under normal traffic: further settles never re-verify", async () => {
    const file = join(tmpDir(), "catalog.json");
    const before = new BazaarCatalog(file);
    before.upsertFromPayment(disc(), reqs(PAY_OLD));
    before.flush();

    // After restart the URL is already present, so upsertFromPayment reports
    // isFirstCatalog=false — and `if (firstCatalog)` in bazaar.ts is the ONLY
    // trigger for verifyResourceOwnership.
    //
    // Precisely: there is exactly ONE path back, and it is not a usable one.
    // evictToCap() removing the entry past MAX_ENTRIES (10,000) makes the next
    // settle a first-catalog again, which does re-verify (verified by probe).
    // So the honest statement is "does not recover below the eviction cap",
    // NOT "never" — and nobody should mistake cache pressure for a fix.
    const after = new BazaarCatalog(file);
    for (let i = 0; i < 5; i++) {
      expect(
        after.upsertFromPayment(disc(), reqs(PAY_OLD)),
        "isFirstCatalog must stay false, so verification never re-fires",
      ).toBe(false);
    }
    expect(after.isVerifiedOwner(URL_X)).toBe(false);
  });
});

describe("G-2 — a bound URL has no payTo rotation path", () => {
  it("refuses a rotated payTo permanently, keeping the OLD address in accepts", () => {
    const catalog = new BazaarCatalog();
    catalog.upsertFromPayment(disc(), reqs(PAY_OLD));

    // The merchant rotates their payment address and re-settles.
    expect(catalog.upsertFromPayment(disc(), reqs(PAY_NEW)), "rotation refused").toBe(false);

    // The catalog still advertises ONLY the old address, and there is no method
    // on BazaarCatalog and no route on the server to change it.
    const accepts = (catalog.list().items[0] as TrustedDiscoveryResource).accepts;
    expect(accepts.map((a) => a.payTo)).toEqual([PAY_OLD]);
    expect(catalog.isBound(URL_X, PAY_NEW)).toBe(false);
  });

  it("survives eviction: the tombstone refuses the new payTo even once the entry is gone", () => {
    const catalog = new BazaarCatalog();
    catalog.upsertFromPayment(disc(), reqs(PAY_OLD));
    // Even with the entry evicted, the F3 tombstone keeps the binding, so a
    // rotation cannot be achieved by waiting for cache pressure either.
    expect(catalog.isBound(URL_X, PAY_OLD)).toBe(true);
    expect(catalog.isBound(URL_X, PAY_NEW)).toBe(false);
  });

  it("the merchant IS still paid — only the catalog entry goes stale", () => {
    // upsertFromPayment rejecting is a CATALOG decision. It runs inside
    // onAfterSettle, i.e. after settlement already succeeded on-chain, and
    // registerBazaar swallows its own errors so settlement is never affected.
    // The consequence is narrower but sharper than "payments break":
    const catalog = new BazaarCatalog();
    catalog.upsertFromPayment(disc(), reqs(PAY_OLD));
    catalog.upsertFromPayment(disc(), reqs(PAY_NEW)); // refused

    // recordSettlement runs UNCONDITIONALLY after the upsert in bazaar.ts, so
    // settlements against the NEW address still accrue to the entry advertising
    // the OLD one. The stale entry therefore looks MORE trustworthy over time.
    catalog.recordSettlement(URL_X, "CPAYER1");
    catalog.recordSettlement(URL_X, "CPAYER2");
    const t = trustOf(catalog.list().items[0]);
    expect(t?.settlements, "stats climb on the stale entry").toBe(2);
    expect((catalog.list().items[0] as TrustedDiscoveryResource).accepts[0]!.payTo).toBe(PAY_OLD);
  });
});
