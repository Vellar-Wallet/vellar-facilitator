import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { BazaarCatalog } from "./catalog.js";
import { tmpStore } from "./store.testkit.js";

// ============================================================================
// Voluntary rotation (docs/proposal-voluntary-rotation.md), end to end through
// BazaarCatalog with a real store — tryDisplace's rotation bypass, both latch
// checkpoints, and the stats-carryover rule that distinguishes it from an
// ordinary displacement.
// ============================================================================

const URL_V = "https://api.merchant.example/quote";
const OLD = "GOLDOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NEW = "GNEWOWNERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const OTHER = "GOTHERCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const NONCE = "nonce-rotation-1";

function disc(url = URL_V): DiscoveredResource {
  return {
    resourceUrl: url,
    x402Version: 2,
    discoveryInfo: { input: { type: "http", method: "GET" } },
  } as unknown as DiscoveredResource;
}
function reqs(payTo: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CASSET",
    amount: "1",
    payTo,
    maxTimeoutSeconds: 60,
  } as unknown as PaymentRequirements;
}

function endpointNaming(...owners: string[]) {
  const calls: { url: string; payTos: string[] }[] = [];
  return {
    calls,
    fn: async (url: string, payTos: string[]) => {
      calls.push({ url, payTos });
      return payTos.some((p) => owners.includes(p)) ? ("match" as const) : ("mismatch" as const);
    },
  };
}

/** Verified binding to OLD, ready for a rotation attempt. */
async function verifiedEntry(store: Awaited<ReturnType<typeof tmpStore>>["store"]) {
  const catalog = await BazaarCatalog.create(store);
  await catalog.upsertFromPayment(disc(), reqs(OLD));
  await catalog.reverify(URL_V, OLD, endpointNaming(OLD).fn);
  expect(catalog.isEverVerified(URL_V)).toBe(true);
  return catalog;
}

describe("voluntary rotation — the latch bypass", () => {
  it("a verified binding with a live A->B marker displaces when B's probe matches", async () => {
    const { store } = tmpStore();
    const catalog = await verifiedEntry(store);

    await catalog.authorizeRotation(URL_V, OLD, OLD, NEW, NONCE, 1, Date.now() + 1_000_000);

    const v = endpointNaming(NEW);
    const outcome = await catalog.tryDisplace(URL_V, NEW, reqs(NEW), disc(), v.fn);

    expect(outcome).toBe("displaced");
    expect(catalog.isBound(URL_V, NEW)).toBe(true);
    expect(catalog.isBound(URL_V, OLD)).toBe(false);
    expect(catalog.isEverVerified(URL_V), "re-latches under the new owner").toBe(true);
    expect(catalog.isVerifiedOwner(URL_V)).toBe(true);
  });

  it("without a marker, a verified binding stays non-displaceable (ordinary one-way latch, unchanged)", async () => {
    const { store } = tmpStore();
    const catalog = await verifiedEntry(store);

    const v = endpointNaming(NEW); // NEW genuinely controls the endpoint now, but has no marker
    expect(await catalog.tryDisplace(URL_V, NEW, reqs(NEW), disc(), v.fn)).toBe("skipped");
    expect(v.calls.length, "refused before the probe, exactly as an ordinary verified binding is").toBe(0);
    expect(catalog.isBound(URL_V, OLD)).toBe(true);
  });

  it("the marker bypasses the LATCH only — a probe that doesn't match is still refused", async () => {
    const { store } = tmpStore();
    const catalog = await verifiedEntry(store);
    await catalog.authorizeRotation(URL_V, OLD, OLD, NEW, NONCE, 1, Date.now() + 1_000_000);

    // NEW's own endpoint does not actually name NEW (misconfigured, or a
    // marker settled ahead of the real cutover).
    const v = endpointNaming(OTHER);
    expect(await catalog.tryDisplace(URL_V, NEW, reqs(NEW), disc(), v.fn)).toBe("refused");
    expect(catalog.isBound(URL_V, OLD), "the probe still has to pass; the marker alone proves nothing").toBe(
      true,
    );
  });

  it("A->B marker cannot complete as A->C: C's own successful probe is irrelevant without C's own marker", async () => {
    const { store } = tmpStore();
    const catalog = await verifiedEntry(store);
    await catalog.authorizeRotation(URL_V, OLD, OLD, NEW, NONCE, 1, Date.now() + 1_000_000);

    const v = endpointNaming(OTHER); // OTHER genuinely controls ITS OWN endpoint
    const outcome = await catalog.tryDisplace(URL_V, OTHER, reqs(OTHER), disc(), v.fn);

    expect(outcome, "no marker exists for (OLD, OTHER) — the one-way latch applies normally").toBe("skipped");
    expect(v.calls.length, "never even probed").toBe(0);
    expect(catalog.isBound(URL_V, OLD)).toBe(true);
  });

  it("expired marker: refused, same as having none", async () => {
    const { store } = tmpStore();
    const catalog = await verifiedEntry(store);
    await catalog.authorizeRotation(URL_V, OLD, OLD, NEW, NONCE, 1, Date.now() - 1); // already expired

    const v = endpointNaming(NEW);
    expect(await catalog.tryDisplace(URL_V, NEW, reqs(NEW), disc(), v.fn)).toBe("skipped");
    expect(v.calls.length).toBe(0);
    expect(catalog.isBound(URL_V, OLD)).toBe(true);
  });

  it("second checkpoint: a second rotation wins the race, the first marker's attempt is refused mid-flight", async () => {
    // Two DIFFERENT claimants racing the same verified OLD-owned entry, each
    // with their own live marker — displaceInFlight is keyed on (key,
    // claimant), so NEW's and OTHER's probes run concurrently without
    // colliding. OTHER's probe resolves first and wins the rotation; NEW's
    // marker was valid for OLD as current owner, which stops being true
    // the moment OTHER's rotation commits.
    const { store } = tmpStore();
    const catalog = await verifiedEntry(store);
    await catalog.authorizeRotation(URL_V, OLD, OLD, NEW, "nonce-new", 1, Date.now() + 1_000_000);
    await catalog.authorizeRotation(URL_V, OLD, OLD, OTHER, "nonce-other", 1, Date.now() + 1_000_000);

    let resolveNewProbe: (v: "match") => void;
    const slowProbe = new Promise<"match">((r) => {
      resolveNewProbe = r;
    });
    const newProbeCalls: string[][] = [];
    const newDisplacePromise = catalog.tryDisplace(URL_V, NEW, reqs(NEW), disc(), async (_url, payTos) => {
      newProbeCalls.push(payTos);
      return slowProbe;
    });

    // OTHER's rotation completes first, fully, while NEW's probe is still
    // pending.
    const otherOutcome = await catalog.tryDisplace(URL_V, OTHER, reqs(OTHER), disc(), endpointNaming(OTHER).fn);
    expect(otherOutcome).toBe("displaced");
    expect(catalog.isBound(URL_V, OTHER)).toBe(true);

    // Now let NEW's probe resolve. The pre-probe snapshot said OLD was the
    // owner; by commit time OTHER is. The second checkpoint must catch this.
    resolveNewProbe!("match");
    const newOutcome = await newDisplacePromise;

    expect(
      newOutcome,
      "NEW's marker was valid for OLD as current owner; that stopped being true while the probe was in flight",
    ).toBe("skipped");
    expect(catalog.isBound(URL_V, OTHER), "OTHER's rotation stands, unaffected by NEW's stale attempt").toBe(
      true,
    );
    expect(catalog.isBound(URL_V, NEW)).toBe(false);
  });

  it("stats CARRY OVER on a voluntary rotation — same merchant, not a new party", async () => {
    const { store } = tmpStore();
    const catalog = await verifiedEntry(store);
    for (let i = 0; i < 5; i++) catalog.recordSettlement(URL_V, `CPAYER${i}`, OLD);
    expect((catalog.list().items[0] as unknown as { trust: { settlements: number } }).trust.settlements).toBe(
      5,
    );

    await catalog.authorizeRotation(URL_V, OLD, OLD, NEW, NONCE, 1, Date.now() + 1_000_000);
    await catalog.tryDisplace(URL_V, NEW, reqs(NEW), disc(), endpointNaming(NEW).fn);

    const trust = (catalog.list().items[0] as unknown as { trust: { settlements: number } }).trust;
    expect(trust.settlements, "the old owner authorized this successor — same history, not reset").toBe(5);
  });

  it("stats still RESET on an ordinary (non-rotation) displacement — unchanged behaviour", async () => {
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs(OLD)); // unverified squat, no reverify
    for (let i = 0; i < 5; i++) catalog.recordSettlement(URL_V, `CPAYER${i}`, OLD);

    await catalog.tryDisplace(URL_V, NEW, reqs(NEW), disc(), endpointNaming(NEW).fn);

    const trust = (catalog.list().items[0] as unknown as { trust: { settlements: number } }).trust;
    expect(trust.settlements, "ordinary displacement still resets — this is a different party").toBe(0);
  });

  it("authorizeRotation rejects newPayTo === oldPayTo", async () => {
    const { store } = tmpStore();
    const catalog = await verifiedEntry(store);
    await catalog.authorizeRotation(URL_V, OLD, OLD, OLD, NONCE, 1, Date.now() + 1_000_000);

    const v = endpointNaming(OLD);
    // No marker was recorded (newPayTo === oldPayTo is a no-op), so a
    // "rotation" to the SAME address finds no live authorization and the
    // ordinary latch applies.
    expect(await catalog.tryDisplace(URL_V, OLD, reqs(OLD), disc(), v.fn), "already bound to OLD").toBe(
      "skipped",
    );
  });

  it("the three-way match refuses a forged oldPayTo: claimed OLD who never actually paid as OLD", async () => {
    const { store } = tmpStore();
    const catalog = await verifiedEntry(store);

    // OTHER settles, but the extension CLAIMS to be rotating from OLD. The
    // authenticated payer (OTHER) does not match the claimed oldPayTo (OLD).
    await catalog.authorizeRotation(URL_V, OTHER, OLD, NEW, NONCE, 1, Date.now() + 1_000_000);

    const v = endpointNaming(NEW);
    expect(
      await catalog.tryDisplace(URL_V, NEW, reqs(NEW), disc(), v.fn),
      "no marker was ever recorded — the forged claim never got past the three-way match",
    ).toBe("skipped");
    expect(v.calls.length).toBe(0);
  });

  it("the three-way match refuses a claimed oldPayTo that isn't the CURRENT owner", async () => {
    const { store } = tmpStore();
    const catalog = await verifiedEntry(store); // current owner is OLD

    // OTHER settles and authentically pays as OTHER, but claims to be
    // rotating FROM OTHER even though OTHER never owned this resource.
    await catalog.authorizeRotation(URL_V, OTHER, OTHER, NEW, NONCE, 1, Date.now() + 1_000_000);

    const v = endpointNaming(NEW);
    expect(await catalog.tryDisplace(URL_V, NEW, reqs(NEW), disc(), v.fn)).toBe("skipped");
  });

  it("a rotation marker against an UNVERIFIED binding is irrelevant — ordinary displacement rules apply", async () => {
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs(OLD)); // unverified squat
    // A marker recorded against an unverified binding (unusual, but the
    // three-way match only cares about current ownership, not verification
    // state) has no effect: the first checkpoint only fires when
    // everVerified.has(key), which is false here.
    await catalog.authorizeRotation(URL_V, OLD, OLD, NEW, NONCE, 1, Date.now() + 1_000_000);

    const outcome = await catalog.tryDisplace(URL_V, NEW, reqs(NEW), disc(), endpointNaming(NEW).fn);
    expect(outcome, "ordinary unverified displacement, unaffected by the marker's presence").toBe("displaced");

    // And it reset stats — the ordinary path, not the rotation path, ran.
    const trust = (catalog.list().items[0] as unknown as { trust: { settlements: number } }).trust;
    expect(trust.settlements).toBe(0);
  });
});
