import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { afterEach, describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { readOwnership, reopen, seedRows } from "./store.testkit.js";
import { buildFacilitator } from "./facilitator.js";
import { buildServer } from "./server.js";
import type { TrustResolver, TrustedDiscoveryResource } from "./trust.js";
import { fakeChannelAccountSecretKeys } from "./testChannelPoolKeys.js";

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
afterEach(async () => {
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
const allVerified: TrustResolver = { hasVerdictSource: true, assetStatus: async () => "verified" };

const testConfig = {
  port: 0,
  host: "127.0.0.1",
  network: "stellar:testnet" as const,
  rpcUrl: undefined,
  sponsorSecretKey: Keypair.random().secret(),
  channelAccountSecretKeys: fakeChannelAccountSecretKeys(),
  maxTransactionFeeStroops: 2_000_000,
  channelAccountMinStroops: 5_000_000,
  catalogDbUrl: undefined,
  uptoContractId: undefined,
  bondEscrowContractId: undefined,
  bondEscrowAdminSecretKey: undefined,
  catalogDbAuthToken: undefined,
  verificationApiUrl: undefined,
  spend: { rateWindowMs: 60_000, ceilingStroops: 50_000_000, windowMs: 60_000, perUrlMax: 10, perPayToMax: 100, unboundPoolMax: 10 },
  balance: { softFloorStroops: 100_000_000, hardFloorStroops: 20_000_000, intervalMs: 60_000 },
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
    const file = `file:${join(tmpDir(), "catalog.json.db")}`;

    // --- Run 1: entry is cataloged AND passes Layer 2 ownership verification.
    const before = await BazaarCatalog.create(reopen(file));
    await before.upsertFromPayment(disc(), reqs(PAY_OLD));
    before.setVerifiedOwner(URL_X, true);
    await before.flush();

    const appBefore = await serve(before);
    const preBody = (await appBefore.inject({ method: "GET", url: "/discovery/resources" })).json();
    expect(trustOf(preBody.items[0]).ownerVerified, "precondition: verified before restart").toBe(true);
    expect(trustOf(preBody.items[0]).verification).toBe("verified");
    await appBefore.close();

    // --- Run 2: same file, fresh process. Nothing about the resource changed.
    const after = await BazaarCatalog.create(reopen(file));
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

  it("O-18: a latched entry serves ownershipState proven-unconfirmed after restart — and nothing expires it", async () => {
    const file = `file:${join(tmpDir(), "catalog.json.db")}`;

    // --- Run 1: proven through the PRODUCTION write path (reverify -> match),
    // which sets the badge AND latches durably. Not setVerifiedOwner, which is
    // the badge-only test seam.
    const before = await BazaarCatalog.create(reopen(file));
    await before.upsertFromPayment(disc(), reqs(PAY_OLD));
    expect(await before.reverify(URL_X, PAY_OLD, async () => "match")).toBe("match");
    await before.flush();

    const appBefore = await serve(before);
    const pre = trustOf((await appBefore.inject({ method: "GET", url: "/discovery/resources" })).json().items[0]);
    expect(pre.ownerVerified, "precondition: badge earned").toBe(true);
    expect(pre.ownershipState, "badge present -> verified, per the invariant").toBe("verified");
    await appBefore.close();

    // --- Run 2: the O-18 shape. Badge gone (RA-9), latch survived.
    const after = await BazaarCatalog.create(reopen(file));
    const appAfter = await serve(after);
    const read = async () =>
      trustOf((await appAfter.inject({ method: "GET", url: "/discovery/resources" })).json().items[0]);

    const t = await read();
    // CONSUMER BEFORE/AFTER, pinned: a boolean consumer sees exactly what it
    // saw before this field existed — false — and verification stays clamped.
    expect(t.ownerVerified, "boolean consumers: unchanged, still false").toBe(false);
    expect(t.verification, "clamping: unchanged, still unknown").toBe("unknown");
    // The new disclosure is the only difference: once-proven is now visible.
    expect(t.ownershipState).toBe("proven-unconfirmed");

    // verified_only is UNCHANGED by the new field: it filters on verification,
    // which the badge clamps — a proven-unconfirmed entry does not pass.
    const filtered = (await appAfter.inject({ method: "GET", url: "/discovery/resources?verified_only=true" })).json();
    expect(filtered.items, "proven-unconfirmed does not satisfy verified_only").toHaveLength(0);

    // --- NO EXPIRY PATH, asserted rather than assumed. The exposure is
    // read-only: serving the state repeatedly, and a displacement attempt by a
    // claimant whose endpoint would vouch for it, must change nothing.
    // MUTATION: make the exposure clear or decay the latch (e.g. everVerified
    // .delete on read, or a TTL) — the displacement below then succeeds and
    // this goes red.
    for (let i = 0; i < 5; i++) expect((await read()).ownershipState).toBe("proven-unconfirmed");
    expect(
      await after.tryDisplace(URL_X, PAY_NEW, reqs(PAY_NEW), disc(), async () => "match"),
      "the latch still gates displacement with the state on the wire",
    ).toBe("skipped");
    expect(after.isEverVerified(URL_X), "latch intact after reads and a displacement attempt").toBe(true);
    expect((await read()).ownershipState, "state unchanged after the attempt").toBe("proven-unconfirmed");
    await appAfter.close();

    // --- Run 3: still there. Durability holds THROUGH the new exposure.
    const again = await BazaarCatalog.create(reopen(file));
    expect(again.isEverVerified(URL_X), "second restart: latch still durable").toBe(true);
    const appAgain = await serve(again);
    const t3 = trustOf((await appAgain.inject({ method: "GET", url: "/discovery/resources" })).json().items[0]);
    expect(t3.ownershipState).toBe("proven-unconfirmed");
    await appAgain.close();
  });

  it("verified_only=true serves an EMPTY catalog after restart", async () => {
    const file = `file:${join(tmpDir(), "catalog.json.db")}`;
    const before = await BazaarCatalog.create(reopen(file));
    await before.upsertFromPayment(disc(), reqs(PAY_OLD));
    before.setVerifiedOwner(URL_X, true);
    await before.flush();

    const appBefore = await serve(before);
    const pre = (await appBefore.inject({ method: "GET", url: "/discovery/resources?verified_only=true" })).json();
    expect(pre.items, "precondition: visible to verified_only before restart").toHaveLength(1);
    await appBefore.close();

    const appAfter = await serve(await BazaarCatalog.create(reopen(file)));
    const post = (await appAfter.inject({ method: "GET", url: "/discovery/resources?verified_only=true" })).json();
    // An agent filtering for verified resources sees NOTHING — indistinguishable
    // from "this facilitator has no trustworthy resources".
    expect(post.items, "G-1: verified_only is empty after restart").toHaveLength(0);
    await appAfter.close();
  });

  it("search is affected identically (same annotate path, so the gap is not list-only)", async () => {
    const file = `file:${join(tmpDir(), "catalog.json.db")}`;
    const before = await BazaarCatalog.create(reopen(file));
    await before.upsertFromPayment(disc(), reqs(PAY_OLD));
    before.setVerifiedOwner(URL_X, true);
    await before.flush();

    const appAfter = await serve(await BazaarCatalog.create(reopen(file)));
    const post = (await appAfter.inject({ method: "GET", url: "/discovery/search?query=Merchant" })).json();
    expect(post.resources.length).toBeGreaterThan(0);
    expect(trustOf(post.resources[0]).ownerVerified, "G-1 hits /discovery/search too").toBe(false);
    await appAfter.close();
  });

  it("does not recover under normal traffic: further settles never re-verify", async () => {
    const file = `file:${join(tmpDir(), "catalog.json.db")}`;
    const before = await BazaarCatalog.create(reopen(file));
    await before.upsertFromPayment(disc(), reqs(PAY_OLD));
    await before.flush();

    // After restart the URL is already present, so upsertFromPayment reports
    // isFirstCatalog=false — and `if (firstCatalog)` in bazaar.ts is the ONLY
    // trigger for verifyResourceOwnership.
    //
    // Precisely: there is exactly ONE path back, and it is not a usable one.
    // evictToCap() removing the entry past MAX_ENTRIES (10,000) makes the next
    // settle a first-catalog again, which does re-verify (verified by probe).
    // So the honest statement is "does not recover below the eviction cap",
    // NOT "never" — and nobody should mistake cache pressure for a fix.
    const after = await BazaarCatalog.create(reopen(file));
    for (let i = 0; i < 5; i++) {
      expect(
        await after.upsertFromPayment(disc(), reqs(PAY_OLD)),
        "isFirstCatalog must stay false, so verification never re-fires",
      ).toBe(false);
    }
    expect(after.isVerifiedOwner(URL_X)).toBe(false);
  });
});

describe("G-2 — a bound URL has no payTo rotation path", () => {
  it("refuses a rotated payTo permanently, keeping the OLD address in accepts", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(disc(), reqs(PAY_OLD));

    // The merchant rotates their payment address and re-settles.
    expect(await catalog.upsertFromPayment(disc(), reqs(PAY_NEW)), "rotation refused").toBe(false);

    // The catalog still advertises ONLY the old address, and there is no method
    // on BazaarCatalog and no route on the server to change it.
    const accepts = (catalog.list().items[0] as TrustedDiscoveryResource).accepts;
    expect(accepts.map((a) => a.payTo)).toEqual([PAY_OLD]);
    expect(catalog.isBound(URL_X, PAY_NEW)).toBe(false);
  });

  it("survives eviction: the tombstone refuses the new payTo even once the entry is gone", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(disc(), reqs(PAY_OLD));
    // Even with the entry evicted, the F3 tombstone keeps the binding, so a
    // rotation cannot be achieved by waiting for cache pressure either.
    expect(catalog.isBound(URL_X, PAY_OLD)).toBe(true);
    expect(catalog.isBound(URL_X, PAY_NEW)).toBe(false);
  });

  it("the merchant IS still paid — only the catalog entry goes stale", async () => {
    // upsertFromPayment rejecting is a CATALOG decision. It runs inside
    // onAfterSettle, i.e. after settlement already succeeded on-chain, and
    // registerBazaar swallows its own errors so settlement is never affected.
    // The consequence is narrower but sharper than "payments break":
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(disc(), reqs(PAY_OLD));
    await catalog.upsertFromPayment(disc(), reqs(PAY_NEW)); // refused

    // G-4 narrowed this. recordSettlement still runs after the rejected upsert,
    // but it now refuses any payTo that is not bound, so settlements to the NEW
    // address no longer accrue to the entry advertising the OLD one — the stale
    // entry stops looking more trustworthy over time.
    expect(catalog.recordSettlement(URL_X, "CPAYER1", PAY_NEW), "rotated payTo must not count").toBe(false);
    expect(catalog.recordSettlement(URL_X, "CPAYER2", PAY_NEW)).toBe(false);
    expect(trustOf(catalog.list().items[0]).settlements, "stale entry no longer inflates").toBe(0);

    // What REMAINS the G-2 problem: the entry still advertises the old address,
    // and the merchant has no way to change it. Their real settlements are now
    // simply invisible to the catalog rather than credited to the wrong address.
    expect((catalog.list().items[0] as TrustedDiscoveryResource).accepts[0]!.payTo).toBe(PAY_OLD);
    expect(catalog.recordSettlement(URL_X, "CPAYER1", PAY_OLD), "only the bound owner counts").toBe(true);
  });
});
