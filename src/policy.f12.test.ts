import { describe, expect, it } from "vitest";
import { SpendPolicy, type SettleIdentity } from "./policy.js";

// F12 — per-entity spend accounting. The global ceiling alone throttled honest
// merchants while a distributed attacker stayed under every per-bucket limit.
// Budgets are keyed on the DURABLE ownership binding (F11 tombstone), never on
// verifiedOwner, which is not persisted and resets on restart.

const base = {
  network: "stellar:pubnet" as const,
  rateWindowMs: 60_000,
  spendCeilingStroops: 1_000_000_000,
  spendWindowMs: 60_000,
  perSettleEstimateStroops: 500_000,
  perUrlMax: 10,
  perPayToMax: 100,
  unboundPoolMax: 10,
};
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const bound = (url: string, payTo = "GMERCHANT"): SettleIdentity => ({ resourceUrl: url, payTo, bound: true });
const unbound = (url: string, payTo = "GSPRAY"): SettleIdentity => ({ resourceUrl: url, payTo, bound: false });

describe("F12 — per-bound-URL budget", () => {
  it("allows one merchant 10 settles/min on its own URL", async () => {
    const c = clock();
    const p = new SpendPolicy(base, c.now);
    for (let i = 0; i < 10; i++) expect(p.checkSettle(bound("https://a/x")).allowed).toBe(true);
    const over = p.checkSettle(bound("https://a/x"));
    expect(over.allowed).toBe(false);
    expect(over.reason).toBe("rate_limited_url");
  });

  it("one merchant's URL budget does not touch another's", async () => {
    const c = clock();
    const p = new SpendPolicy(base, c.now);
    for (let i = 0; i < 10; i++) p.checkSettle(bound("https://a/x", "GA"));
    expect(p.checkSettle(bound("https://a/x", "GA")).allowed).toBe(false);
    // A different merchant is entirely unaffected — the fairness property F12 exists for.
    expect(p.checkSettle(bound("https://b/y", "GB")).allowed).toBe(true);
  });

  it("does NOT halve an honest merchant: 3 URLs under one payTo each get their full 10", async () => {
    const c = clock();
    const p = new SpendPolicy(base, c.now);
    for (const u of ["https://m/1", "https://m/2", "https://m/3"]) {
      for (let i = 0; i < 10; i++) {
        expect(p.checkSettle(bound(u, "GMERCH")).allowed, `${u} #${i}`).toBe(true);
      }
    }
    // 30 settles for one payTo, all allowed — per-payTo (100) never bound.
  });
});

describe("F12 — the per-payTo budget is the ONLY one on that key", () => {
  it("admits exactly perPayToMax settles for one payTo — no tighter budget may shadow it", async () => {
    // This is the test that did not exist while the defect did. `SETTLE_RATE_MAX`
    // (30) and `SETTLE_PER_PAYTO_MAX` (100) were two budgets over the same key
    // and window; the tighter silently won, so the per-payTo dimension never ran
    // and nothing failed. Any second per-payTo limit below perPayToMax breaks
    // this test.
    const c = clock();
    const p = new SpendPolicy({ ...base, perPayToMax: 50, perUrlMax: 1_000 }, c.now);
    let allowed = 0;
    for (let i = 0; i < 60; i++) {
      if (p.checkSettle(bound(`https://m/${i}`, "GMERCH")).allowed) allowed++;
    }
    expect(allowed, "a shadowing budget would cut this below perPayToMax").toBe(50);
    expect(p.checkSettle(bound("https://m/x", "GMERCH")).reason).toBe("rate_limited_payto");
  });
});

describe("F12 — unbound pool is the economic signal", () => {
  it("all unbound URLs share ONE budget, so spraying competes with itself", async () => {
    const c = clock();
    const p = new SpendPolicy(base, c.now);
    // Spray 10 distinct unverified URLs: together they get one bound URL's worth.
    let allowed = 0;
    for (let i = 0; i < 40; i++) {
      if (p.checkSettle(unbound(`https://spray/${i % 10}`)).allowed) allowed++;
    }
    expect(allowed).toBe(10); // the whole spray got what ONE bound URL gets
    const over = p.checkSettle(unbound("https://spray/99"));
    expect(over.reason).toBe("unbound_pool_exhausted");
  });

  it("an exhausted unbound pool does not affect bound merchants", async () => {
    const c = clock();
    const p = new SpendPolicy(base, c.now);
    for (let i = 0; i < 10; i++) p.checkSettle(unbound(`https://spray/${i}`));
    expect(p.checkSettle(unbound("https://spray/x")).allowed).toBe(false);
    // The honest, bound merchant is untouched.
    expect(p.checkSettle(bound("https://honest/x", "GHONEST")).allowed).toBe(true);
  });
});

describe("F12 — all-or-none reservation", () => {
  it("a REFUSED settle consumes no budget in any window", async () => {
    const c = clock();
    // perPayToMax is deliberately TIGHT (15) so a leak is observable: 10 real
    // settles + 20 refusals would put a reserve-as-you-go implementation at 30,
    // far past 15, and starve the merchant's other URL. With all-or-none the
    // payTo window holds exactly 10 and 5 remain.
    const p = new SpendPolicy({ ...base, perPayToMax: 15 }, c.now);
    for (let i = 0; i < 10; i++) {
      expect(p.checkSettle(bound("https://a/x", "GA")).allowed).toBe(true);
    }

    // 20 refusals against the now-exhausted URL budget.
    for (let i = 0; i < 20; i++) {
      expect(p.checkSettle(bound("https://a/x", "GA")).allowed).toBe(false);
    }

    // Exactly the 5 remaining payTo slots must be available on another URL.
    let ok = 0;
    for (let i = 0; i < 10; i++) if (p.checkSettle(bound("https://a/y", "GA")).allowed) ok++;
    expect(ok, "refusals must not leak into the payTo budget").toBe(5);
  });

  it("concurrent settles never over-consume: exactly perUrlMax succeed", async () => {
    const c = clock();
    const p = new SpendPolicy(base, c.now);
    // Fire 50 concurrent settles at ONE bound URL. checkSettle is synchronous by
    // design precisely so evaluate-then-reserve cannot interleave; racing them
    // must still admit exactly 10.
    const results = await Promise.all(
      Array.from({ length: 50 }, async () => p.checkSettle(bound("https://race/x", "GR")).allowed),
    );
    expect(results.filter(Boolean).length).toBe(10);
  });

  it("a settle refused by the GLOBAL ceiling leaves the url and payTo budgets untouched", async () => {
    const c = clock();
    const p = new SpendPolicy(
      { ...base, spendCeilingStroops: 1_000_000, perSettleEstimateStroops: 500_000 }, // 2 settles globally
      c.now,
    );
    expect(p.checkSettle(bound("https://a/x", "GA")).allowed).toBe(true);
    expect(p.checkSettle(bound("https://a/x", "GA")).allowed).toBe(true);
    const refused = p.checkSettle(bound("https://a/x", "GA"));
    expect(refused.reason).toBe("spend_ceiling");

    // Window rolls over; the URL budget must show 2 used, not 3 — the refused
    // settle must not have been recorded anywhere.
    c.advance(60_001);
    let ok = 0;
    for (let i = 0; i < 10; i++) if (p.checkSettle(bound("https://a/x", "GA")).allowed) ok++;
    expect(ok).toBe(2); // global still limits to 2/window; url budget was never over-consumed
  });
});
