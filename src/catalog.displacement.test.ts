import { describe, expect, it, vi } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { BazaarCatalog } from "./catalog.js";
import { readOwnership, reopen, tmpStore } from "./store.testkit.js";

// ============================================================================
// G-2 displacement — proof beats no-proof, and never proof beats proof.
//
// THE RULE: a claimant whose payTo appears in the resource's own 402 challenge
// displaces a binding that was NEVER proven. Unverified -> verified only.
//
// An unverified binding is arrival order — whoever settled first — which is not
// evidence. A verified binding is evidence, and stays. The takeover case refused
// as 2C is still refused.
//
// Every test names the mutation that must break it. This repo's history is the
// argument for that: Layer 2 was decorative for its whole life while 22 mocked
// tests stayed green, and a fail-closed path that silently fails open is the
// failure this whole area exists to prevent.
// ============================================================================

const URL_V = "https://api.victim.example/quote";
const A = "GAREALOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "GBSQUATTERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const C = "GCTHIRDPARTYCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

function disc(url = URL_V): DiscoveredResource {
  return {
    resourceUrl: url,
    x402Version: 2,
    discoveryInfo: { input: { type: "http", method: "GET" } },
  } as unknown as DiscoveredResource;
}
function reqs(payTo: string, asset = "CASSET"): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset,
    amount: "1",
    payTo,
    maxTimeoutSeconds: 60,
  } as unknown as PaymentRequirements;
}

/** A verifier that answers `match` only for the addresses the endpoint really
 *  names — i.e. a real 402 challenge, not a rubber stamp. */
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

describe("G-2 — the scenario demonstrated live on 2026-08-11", () => {
  it("empty catalog, B binds unverified, A displaces B and accepts flips to A", async () => {
    // This is the walkthrough, reproduced: B settled first against an empty
    // catalog and took the victim's URL; A — the real owner, settling through
    // its own seller — was locked out and its own payment did not correct it.
    //
    // MUTATION THAT MUST BREAK THIS: delete the `verdict !== "match"` early
    // return in tryDisplace, or remove the tryDisplace call from bazaar.ts. The
    // binding stays on B and `accepts` never flips.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);

    // B settles first. TOFU binds the victim's URL to the squatter.
    expect(await catalog.upsertFromPayment(disc(), reqs(B)), "B wins the race").toBe(true);
    expect(catalog.isBound(URL_V, B)).toBe(true);
    expect(catalog.isEverVerified(URL_V), "arrival order is not proof").toBe(false);

    // A settles. The upsert is refused — A is not bound — exactly as observed.
    expect(await catalog.upsertFromPayment(disc(), reqs(A)), "the real owner is refused").toBe(false);
    expect(catalog.list().items[0]!.accepts.map((x) => x.payTo)).toEqual([B]);

    // The endpoint is A's, and its 402 names A.
    const v = endpointNaming(A);
    const outcome = await catalog.tryDisplace(URL_V, A, reqs(A), disc(), v.fn);

    expect(outcome).toBe("displaced");
    expect(v.calls[0]!.payTos, "the probe asks about the CLAIMANT, not the bound set").toEqual([A]);
    expect(catalog.isBound(URL_V, A), "A owns it").toBe(true);
    expect(catalog.isBound(URL_V, B), "B does not, and is not a secondary payee either").toBe(false);
    expect(
      catalog.list().items[0]!.accepts.map((x) => x.payTo),
      "accepts flipped to A",
    ).toEqual([A]);
    expect(catalog.isVerifiedOwner(URL_V), "and it is verified, because we just proved it").toBe(true);
  });

  it("a squatter's endpoint cannot rubber-stamp itself into keeping the URL", async () => {
    // The probe passes ONLY the claimant's address. If it passed the bound set,
    // a squatter's own endpoint could answer "match" for the address it names
    // and the check would confirm whatever it was already told.
    //
    // MUTATION: pass `[...entry.boundPayTo, claimant]` to verify(). This test
    // then displaces to C on an endpoint that names only B.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs(B));

    const v = endpointNaming(B); // the endpoint names the SQUATTER
    expect(await catalog.tryDisplace(URL_V, C, reqs(C), disc(), v.fn)).toBe("refused");
    expect(catalog.isBound(URL_V, B), "unchanged").toBe(true);
    expect(catalog.isBound(URL_V, C)).toBe(false);
  });
});

describe("one-way — proof never displaces proof", () => {
  it("a VERIFIED binding is never displaceable, even by a claimant who proves ownership", async () => {
    // The 2C takeover case, still refused. A domain that changes hands is
    // indistinguishable from a hijack, so the answer stays "an operator decides".
    //
    // MUTATION: remove the `everVerified.has(key)` gate in tryDisplace. C then
    // takes a URL whose owner had proven ownership — which is the whole property
    // this design refuses to give up.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs(A));
    await catalog.reverify(URL_V, A, endpointNaming(A).fn);
    expect(catalog.isEverVerified(URL_V)).toBe(true);

    const v = endpointNaming(C); // C genuinely controls the endpoint now
    expect(await catalog.tryDisplace(URL_V, C, reqs(C), disc(), v.fn)).toBe("skipped");
    expect(v.calls.length, "and it must not even PROBE — a refusal it cannot act on is wasted traffic").toBe(0);
    expect(catalog.isBound(URL_V, A)).toBe(true);
  });

  it("EVICTION cannot downgrade a verified binding back to displaceable", async () => {
    // THE ATTACK THIS FILE EXISTS FOR.
    //
    // `verifiedOwner` lives on the ENTRY and is ephemeral by design (RA-9).
    // evictToCap() drops entries while ownership survives, so a re-catalog after
    // eviction rebuilds the entry with `verifiedOwner: false`. If displaceability
    // read that flag, an attacker could fill the catalog to MAX_ENTRIES, evict
    // the victim, and displace a binding that HAD been proven.
    //
    // MUTATION: make tryDisplace gate on `entry.verifiedOwner` instead of
    // `this.everVerified`. This test then displaces a proven binding.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs(A));
    await catalog.reverify(URL_V, A, endpointNaming(A).fn);

    // Simulate the eviction: the entry is gone, the ownership row is not.
    // Re-catalog rebuilds the badge as false, which is correct and is the trap.
    catalog.evictForTest(URL_V);
    await catalog.upsertFromPayment(disc(), reqs(A));
    expect(catalog.isVerifiedOwner(URL_V), "the badge really did reset — this is the setup, not a bug").toBe(
      false,
    );

    const v = endpointNaming(C);
    expect(
      await catalog.tryDisplace(URL_V, C, reqs(C), disc(), v.fn),
      "the durable latch outlives the badge",
    ).toBe("skipped");
    // AND IT MUST NOT PROBE. Without this line the test passes even when the
    // gate reads the badge, because the post-probe re-check catches it anyway —
    // so the binding is safe but the facilitator has still made an outbound
    // request to a claimant-chosen URL on behalf of an attempt that could never
    // succeed. Bounding that traffic is the entire reason the gates come before
    // the fetch. (Found by mutation: gating on `entry.verifiedOwner` left all 13
    // green until this assertion existed.)
    expect(v.calls.length, "refused BEFORE the fetch, not after").toBe(0);
    expect(catalog.isBound(URL_V, A)).toBe(true);
  });

  it("the latch survives a RESTART, so displacement cannot be retried after one", async () => {
    // MUTATION: drop `verified_at` from the ownership schema, or stop calling
    // latchVerified in reverify. After the restart everVerified is empty and the
    // proven binding is displaceable again — a downgrade anyone can trigger by
    // waiting for the free tier to spin down.
    const { store, url } = tmpStore();
    const first = await BazaarCatalog.create(store);
    await first.upsertFromPayment(disc(), reqs(A));
    await first.reverify(URL_V, A, endpointNaming(A).fn);
    await first.flush();

    const restarted = await BazaarCatalog.create(reopen(url));
    expect(restarted.isVerifiedOwner(URL_V), "the badge is NOT restored (RA-9)").toBe(false);
    expect(restarted.isEverVerified(URL_V), "but displaceability is").toBe(true);
    expect(await restarted.tryDisplace(URL_V, C, reqs(C), disc(), endpointNaming(C).fn)).toBe("skipped");
    expect(restarted.isBound(URL_V, A)).toBe(true);
  });
});

describe("the ownership rows — neither an UPDATE nor an append", () => {
  it("displacement REPLACES every row, so the squatter is not left as a secondary payee", async () => {
    // MUTATION: change displaceOwnership's DELETE+INSERT batch to a bare INSERT.
    // B survives as a second row, and since rows load ordered by bound_at, B
    // stays boundPayTo[0] — the owner — with A merely added alongside. The
    // displacement would report success and change nothing that matters.
    const { store, url } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs(B));
    await catalog.tryDisplace(URL_V, A, reqs(A), disc(), endpointNaming(A).fn);

    const rows = await readOwnership(url);
    expect(rows, "exactly one binding, and it is the proven one").toEqual([
      { resourceKey: URL_V, boundPayTo: [A], everVerified: true },
    ]);
  });

  it("the URL is never left with zero ownership rows", async () => {
    // This table IS the tombstone record: "has this URL ever been bound" is "is
    // there a row". A moment with zero rows is a moment when anyone can claim it.
    //
    // MUTATION: split the batch into two calls — DELETE, then INSERT. Between
    // them the URL has no owner. The window is invisible in-process and real
    // across a network.
    const { store, url } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs(B));
    await catalog.tryDisplace(URL_V, A, reqs(A), disc(), endpointNaming(A).fn);
    expect((await readOwnership(url)).length, "never zero").toBe(1);
  });

  it("a failed displacement write leaves the binding UNCHANGED", async () => {
    // MUTATION: move `this.ownership.set(key, [claimant])` above the store write,
    // or drop the try/catch. The binding moves in memory with nothing durable
    // behind it, and the next restart silently reverts it — a rebinding that
    // "worked" and then undid itself.
    const { store, url } = tmpStore();
    await store.init();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs(B));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    (catalog as unknown as { store: { displaceOwnership: () => Promise<void> } }).store.displaceOwnership =
      () => Promise.reject(new Error("store down"));

    expect(await catalog.tryDisplace(URL_V, A, reqs(A), disc(), endpointNaming(A).fn)).toBe("refused");
    expect(catalog.isBound(URL_V, B), "still B in memory").toBe(true);
    expect((await readOwnership(url))[0]!.boundPayTo, "and still B on disk").toEqual([B]);
    expect(err.mock.calls.some((c) => /displacement write FAILED/.test(String(c[0])))).toBe(true);
    err.mockRestore();
  });
});

describe("stats — reset, because the merchant changed", () => {
  it("the displaced owner's settlement history does not transfer to the new one", async () => {
    // G-4 established that a bound owner can inflate their own stats. If those
    // survived a displacement, a squatter could manufacture a reputation and
    // hand it to the victim — and consumers would read numbers describing
    // someone else's activity as the current merchant's track record.
    //
    // MUTATION: keep the existing entry instead of deleting it before the
    // re-ingest (drop `this.entries.delete(key)`). The counters carry over.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs(B));
    for (let i = 0; i < 5; i++) catalog.recordSettlement(URL_V, `CPAYER${i}`, B);
    expect(
      (catalog.list().items[0] as unknown as { trust: { settlements: number } }).trust.settlements,
    ).toBe(5);

    await catalog.tryDisplace(URL_V, A, reqs(A), disc(), endpointNaming(A).fn);

    const trust = (catalog.list().items[0] as unknown as { trust: Record<string, number> }).trust;
    expect(trust.settlements, "not the squatter's five").toBe(0);
    expect(trust.uniquePayers).toBe(0);
    expect(trust.observedSettlements).toBe(0);
  });
});

describe("cooldowns — an attacker can only rate-limit themselves", () => {
  it("is keyed by (url, payTo): a failed attempt does not block the real owner", async () => {
    // MUTATION: key displaceState on `key` alone. C's failed probe then parks
    // the URL, and A — the real owner — is refused for the whole cooldown. That
    // hands an attacker a cheap denial of the recovery path, mounted against the
    // very party the recovery exists for.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs(B));

    // C tries and fails; the endpoint names A.
    expect(await catalog.tryDisplace(URL_V, C, reqs(C), disc(), endpointNaming(A).fn, 1_000)).toBe("refused");
    // A tries immediately afterwards, inside C's cooldown window.
    expect(
      await catalog.tryDisplace(URL_V, A, reqs(A), disc(), endpointNaming(A).fn, 1_001),
      "the real owner is not caught in someone else's cooldown",
    ).toBe("displaced");
  });

  it("the SAME claimant is held off after a refusal, bounding probes at a victim", async () => {
    // Each check is an outbound fetch at someone else's endpoint, so a settler
    // repeating a claim must not be able to drive traffic there.
    //
    // MUTATION: remove the cooldown check. The second call probes again
    // immediately, and an attacker settling in a loop turns the facilitator into
    // a request amplifier pointed at the victim.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs(B));
    const v = endpointNaming(A); // C will never match

    expect(await catalog.tryDisplace(URL_V, C, reqs(C), disc(), v.fn, 1_000)).toBe("refused");
    expect(await catalog.tryDisplace(URL_V, C, reqs(C), disc(), v.fn, 1_001)).toBe("skipped");
    expect(v.calls.length, "exactly one probe, not two").toBe(1);
  });
});

describe("displacement does not weaken what it sits next to", () => {
  it("a frozen catalog rebinds nothing", async () => {
    // MUTATION: remove the frozen check. A store outage — during which ownership
    // could not be loaded — becomes a window in which URLs can be rebound, which
    // is fail-open at the exact moment nobody can see the state.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs(B));
    (catalog as unknown as { frozen: string }).frozen = "ownership-unreachable";
    expect(await catalog.tryDisplace(URL_V, A, reqs(A), disc(), endpointNaming(A).fn)).toBe("skipped");
    expect(catalog.isBound(URL_V, B)).toBe(true);
  });

  it("a templated key is never probed", async () => {
    // MUTATION: drop the isTemplatedKey guard. The facilitator GETs a literal
    // `:symbol` at the merchant's origin.
    const url = "https://api.victim.example/quote/:symbol";
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(url), reqs(B));
    const v = endpointNaming(A);
    expect(await catalog.tryDisplace(url, A, reqs(A), disc(url), v.fn)).toBe("skipped");
    expect(v.calls.length).toBe(0);
  });
});
