import { describe, expect, it } from "vitest";
import { SpendPolicy } from "./policy.js";

// Fix 1 — sponsorship spend control. A self-dealer deploys their own SEP-41
// token and settles self→self; the transfer nets to zero for them but the
// sponsor pays XLM each time, and they can push simulation cost toward
// MAX_TX_FEE_STROOPS. Fix 0 stops payTo diversification per URL, making per-payTo
// throttling viable; new-URL spam keeps the same payTo, so per-payTo is the
// load-bearing control. A global rolling XLM ceiling is the fail-closed backstop.
//
// Enforcement is fail-OPEN on testnet (log-only) and fail-CLOSED on pubnet.

const cfg = {
  rateMax: 3,
  rateWindowMs: 1000,
  spendCeilingStroops: 600, // 3 settles * 200 estimate = 600 exactly at ceiling
  spendWindowMs: 1000,
  perSettleEstimateStroops: 200,
};

function nowFn() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("SpendPolicy — pubnet (fail-closed)", () => {
  it("allows settlements under the per-payTo rate limit", () => {
    const clock = nowFn();
    const p = new SpendPolicy({ network: "stellar:pubnet", ...cfg }, clock.now);
    for (let i = 0; i < 3; i++) expect(p.checkSettle("GMERCHANT").allowed).toBe(true);
  });

  it("rejects the 4th settlement from one payTo within the window", () => {
    const clock = nowFn();
    const p = new SpendPolicy({ network: "stellar:pubnet", ...cfg }, clock.now);
    for (let i = 0; i < 3; i++) p.checkSettle("GMERCHANT");
    const verdict = p.checkSettle("GMERCHANT");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("rate_limited_payto");
  });

  it("does not let one payTo's rate limit affect another payTo", () => {
    const clock = nowFn();
    // Give spend headroom so the per-payTo RATE limit is what we isolate here.
    const p = new SpendPolicy(
      { network: "stellar:pubnet", ...cfg, spendCeilingStroops: 1_000_000 },
      clock.now,
    );
    for (let i = 0; i < 3; i++) p.checkSettle("GMERCHANT_A");
    expect(p.checkSettle("GMERCHANT_A").allowed).toBe(false); // A is rate-limited
    // A different payTo is unaffected by A's rate limit.
    expect(p.checkSettle("GMERCHANT_B").allowed).toBe(true);
  });

  it("frees the rate limit after the window elapses", () => {
    const clock = nowFn();
    const p = new SpendPolicy({ network: "stellar:pubnet", ...cfg }, clock.now);
    for (let i = 0; i < 3; i++) p.checkSettle("GM");
    expect(p.checkSettle("GM").allowed).toBe(false);
    clock.advance(1001);
    expect(p.checkSettle("GM").allowed).toBe(true);
  });

  it("refuses with spend_ceiling once the global rolling XLM estimate is exceeded", () => {
    const clock = nowFn();
    // Give rate headroom so the SPEND ceiling is what trips.
    const p = new SpendPolicy(
      { network: "stellar:pubnet", ...cfg, rateMax: 100 },
      clock.now,
    );
    // 3 settles * 200 = 600 == ceiling; the 4th exceeds it.
    for (let i = 0; i < 3; i++) expect(p.checkSettle(`G${i}`).allowed).toBe(true);
    const verdict = p.checkSettle("G4");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("spend_ceiling");
  });
});

describe("SpendPolicy — bounded state (audit D10)", () => {
  it("evicts elapsed per-payTo buckets instead of growing forever", () => {
    const clock = nowFn();
    const p = new SpendPolicy(
      { network: "stellar:pubnet", ...cfg, rateMax: 1000, spendCeilingStroops: 1e12 },
      clock.now,
    );
    // 500 distinct payTos (the rotation vector) all settle at t0.
    for (let i = 0; i < 500; i++) p.checkSettle(`GPAYTO_${i}`);
    expect(p.trackedPayTos()).toBe(500);

    // After the rate window elapses, those buckets are dead weight and must go.
    clock.advance(cfg.rateWindowMs + 1);
    p.checkSettle("GFRESH");
    expect(p.trackedPayTos()).toBeLessThanOrEqual(1);
  });
});

describe("SpendPolicy — testnet (fail-open)", () => {
  it("never blocks on testnet, even over the limits (log-only)", () => {
    const clock = nowFn();
    const p = new SpendPolicy({ network: "stellar:testnet", ...cfg }, clock.now);
    for (let i = 0; i < 20; i++) expect(p.checkSettle("GM").allowed).toBe(true);
  });

  it("still reports what WOULD have tripped, for observability", () => {
    const clock = nowFn();
    const p = new SpendPolicy({ network: "stellar:testnet", ...cfg }, clock.now);
    for (let i = 0; i < 3; i++) p.checkSettle("GM");
    const verdict = p.checkSettle("GM");
    expect(verdict.allowed).toBe(true); // not blocked
    expect(verdict.wouldReject).toBe("rate_limited_payto"); // but flagged
  });
});
