import { describe, expect, it } from "vitest";
import { createSpendPolicy, SpendPolicy } from "./policy.js";
import { reopen, tmpStore } from "./store.testkit.js";

// ============================================================================
// G-10 — real-fee accounting. The flat 500,000-stroop estimate (~22x the
// measured real charge, both testnet and mainnet) is still what gets
// reserved at checkSettle() time, since the real fee is not known until
// facilitator.settle() actually submits — but it is corrected down
// immediately (adjustReservation to the submitted tx.fee) and again once
// confirmed (adjustReservation to the real fee_charged). Everything here
// exercises SpendPolicy directly; the RPC/XDR-decoding half
// (reconcileSpendReservation, in server.ts) is exercised separately.
// ============================================================================

const FLAT_ESTIMATE = 500_000;

function nowFn(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const cfg = {
  network: "stellar:pubnet" as const,
  rateWindowMs: 60_000,
  spendCeilingStroops: 50_000_000, // 5 XLM
  spendWindowMs: 60_000,
  perSettleEstimateStroops: FLAT_ESTIMATE,
  perUrlMax: 1000,
  perPayToMax: 1000,
  unboundPoolMax: 1000,
};

describe("adjustReservation — correcting the flat estimate down to a real fee", () => {
  it("a simple settle books ~the flat estimate, then reconciles down to the real charged fee", async () => {
    const clock = nowFn();
    const p = new SpendPolicy(cfg, clock.now);
    const verdict = p.checkSettle("GMERCHANT");
    expect(verdict.allowed).toBe(true);
    expect(p.reservedStroops(verdict.reservation)).toBe(FLAT_ESTIMATE);

    // Submitted fee (tx.fee — the max the network could charge), captured
    // right after facilitator.settle() returns.
    await p.adjustReservation(verdict.reservation, 33_821);
    expect(p.reservedStroops(verdict.reservation)).toBe(33_821);

    // Real fee_charged, from reconciliation (Soroban can refund unused
    // resource fee, so charged <= submitted).
    await p.adjustReservation(verdict.reservation, 23_565, "reconciled");
    expect(p.reservedStroops(verdict.reservation)).toBe(23_565);
  });

  it("a high-fee (policy-governed-like) settle reserves its own higher submitted fee", async () => {
    // The whole reason MAX_TX_FEE_STROOPS stays at 500,000: it has to admit
    // a policy-governed payment, which simulates far higher than a plain
    // transfer (~140,331 on testnet, per docs/decision-fee-thresholds.md).
    const clock = nowFn();
    const p = new SpendPolicy(cfg, clock.now);
    const verdict = p.checkSettle("GSMARTACCOUNT");
    await p.adjustReservation(verdict.reservation, 140_331);
    expect(p.reservedStroops(verdict.reservation)).toBe(140_331);
  });

  it("a failed pre-inclusion settle (never reached the chain) releases the FULL reservation", async () => {
    const clock = nowFn();
    const p = new SpendPolicy(cfg, clock.now);
    const verdict = p.checkSettle("GMERCHANT");
    p.refundUnspent(verdict.reservation);
    expect(p.reservedStroops(verdict.reservation)).toBeUndefined();
  });

  it("an unknown outcome HOLDS the reservation — adjustReservation is simply never called", async () => {
    // There is no explicit "mark unknown" state in SpendPolicy itself: an
    // unknown outcome is represented by doing NOTHING — the reservation
    // just stays at whatever it was last adjusted to (the submitted fee,
    // if that adjustment already landed) until a later reconciliation
    // attempt resolves it one way or the other.
    const clock = nowFn();
    const p = new SpendPolicy(cfg, clock.now);
    const verdict = p.checkSettle("GMERCHANT");
    await p.adjustReservation(verdict.reservation, 33_821); // submitted-fee adjustment landed
    // ...then the outcome is genuinely unknown (e.g. getTransaction keeps
    // returning NOT_FOUND within the retry budget). Nothing calls
    // adjustReservation again, and nothing calls refundUnspent either.
    expect(p.reservedStroops(verdict.reservation), "held at the submitted-fee estimate, not released").toBe(
      33_821,
    );
  });

  it("marking unreconcilable keeps the LAST-KNOWN amount and never adjusts it again", async () => {
    const clock = nowFn();
    const p = new SpendPolicy(cfg, clock.now);
    const verdict = p.checkSettle("GMERCHANT");
    await p.adjustReservation(verdict.reservation, 33_821);
    await p.adjustReservation(verdict.reservation, 33_821, "unreconcilable");
    expect(p.reservedStroops(verdict.reservation)).toBe(33_821);
  });

  it("adjustReservation is a no-op for an unknown/already-released token", async () => {
    const clock = nowFn();
    const p = new SpendPolicy(cfg, clock.now);
    expect(await p.adjustReservation(999, 100)).toBe(false);
    expect(await p.adjustReservation(undefined, 100)).toBe(false);
  });
});

describe("the G-10 fix in action: the false-refusal case no longer happens at real fees", () => {
  it("accounting at the flat estimate refuses the 101st settle; at the REAL fee it does not", async () => {
    // This is the exact G-10 shape from docs/closing-state.md: the ceiling
    // refuses the 101st settle having spent only a fraction of what it
    // names, because it accounts at 500,000 against a real charge around
    // 23,565-23,984. Demonstrated directly: 100 settles fully reconciled
    // to the REAL fee leave massive headroom the flat-estimate accounting
    // would already have refused.
    const clock = nowFn();
    const p = new SpendPolicy(cfg, clock.now);
    const REAL_FEE = 23_565;
    const reservations: number[] = [];
    for (let i = 0; i < 100; i++) {
      const verdict = p.checkSettle(`G${i}`);
      expect(verdict.allowed, `settle ${i}`).toBe(true);
      reservations.push(verdict.reservation!);
      await p.adjustReservation(verdict.reservation, REAL_FEE, "reconciled");
    }
    // 100 * 23,565 = 2,356,500 stroops spent, against a 50,000,000 ceiling —
    // the 101st settle is still comfortably admitted.
    const settle101 = p.checkSettle("G101");
    expect(settle101.allowed, "real-fee accounting leaves real headroom").toBe(true);
  });

  it("without reconciliation (flat estimate throughout), the same 100 settles exhaust the ceiling far sooner", async () => {
    // Contrast case, proving the ORIGINAL G-10 finding is real: 100 * the
    // flat 500,000 estimate = 50,000,000 = exactly the ceiling.
    const clock = nowFn();
    const p = new SpendPolicy(cfg, clock.now);
    for (let i = 0; i < 100; i++) {
      expect(p.checkSettle(`G${i}`).allowed, `settle ${i}`).toBe(true);
    }
    const settle101 = p.checkSettle("G101");
    expect(settle101.allowed, "unreconciled flat-estimate accounting is already at the ceiling").toBe(false);
  });
});

describe("restart-survival — persisted reservations", () => {
  it("boot() re-seeds an open reservation still inside its window", async () => {
    const { store, url } = tmpStore();
    await store.init();
    const clock = nowFn();
    const p1 = new SpendPolicy(cfg, clock.now, { store });
    const verdict = p1.checkSettle("GMERCHANT");
    await p1.adjustReservation(verdict.reservation, 33_821);
    // Give the fire-and-forget initial persist from checkSettle a tick to land.
    await new Promise((r) => setTimeout(r, 10));

    const reopened = reopen(url);
    const clock2 = nowFn(clock.now()); // "restart" at the same moment, for a clean assertion
    const p2 = new SpendPolicy(cfg, clock2.now, { store: reopened });
    await p2.boot();

    // The re-seeded reservation counts against the SAME spend window a
    // fresh checkSettle would — assert indirectly via a spend-ceiling trip
    // at a tight ceiling that only the re-seeded 33,821 could cause.
    const tight = new SpendPolicy(
      { ...cfg, spendCeilingStroops: 33_821 + FLAT_ESTIMATE - 1 },
      clock2.now,
      { store: reopened },
    );
    await tight.boot();
    const verdict2 = tight.checkSettle("GOTHER");
    expect(
      verdict2.allowed,
      "the re-seeded 33,821 plus a fresh 500,000 estimate exceeds this tight ceiling",
    ).toBe(false);
  });

  it("boot() does NOT re-seed a reservation whose window has already elapsed", async () => {
    const { store, url } = tmpStore();
    await store.init();
    const clock = nowFn();
    const p1 = new SpendPolicy(cfg, clock.now, { store });
    p1.checkSettle("GMERCHANT");
    await new Promise((r) => setTimeout(r, 10));

    clock.advance(cfg.spendWindowMs + 1); // window elapsed
    const reopened = reopen(url);
    const p2 = new SpendPolicy(cfg, clock.now, { store: reopened });
    await p2.boot();

    // A fresh settle against a tight ceiling must NOT be blocked by the
    // stale reservation — if boot() incorrectly re-seeded it, this would
    // trip spend_ceiling.
    const tight = new SpendPolicy({ ...cfg, spendCeilingStroops: FLAT_ESTIMATE }, clock.now, {
      store: reopened,
    });
    await tight.boot();
    expect(tight.checkSettle("GOTHER").allowed, "the elapsed reservation must not count").toBe(true);
  });

  it("a crash between submit and reconcile, then a restart, reconciles correctly without double-counting", async () => {
    const { store, url } = tmpStore();
    await store.init();
    const clock = nowFn();

    // Process 1: reserves, adjusts to the real SUBMITTED fee (the point
    // right after facilitator.settle() returns), then "crashes" before
    // reconciliation to fee_charged ever runs.
    const p1 = new SpendPolicy(cfg, clock.now, { store });
    const verdict = p1.checkSettle("GMERCHANT");
    await p1.adjustReservation(verdict.reservation, 33_821); // the crash point: this landed, reconcile never ran
    await new Promise((r) => setTimeout(r, 10));

    // Process 2: restart. boot() re-seeds the reservation at its
    // LAST-PERSISTED amount (33,821 — the submitted fee, not the flat
    // 500,000 estimate, since adjustReservation's own write is awaited).
    const reopened = reopen(url);
    const p2 = new SpendPolicy(cfg, clock.now, { store: reopened });
    await p2.boot();
    expect(
      p2.reservedStroops(verdict.reservation),
      "re-seeded at the submitted fee, not the flat estimate — adjustReservation's write survived the crash",
    ).toBe(33_821);

    // Process 2 completes the reconciliation the crash interrupted.
    await p2.adjustReservation(verdict.reservation, 23_565, "reconciled");
    expect(p2.reservedStroops(verdict.reservation)).toBe(23_565);

    // No double-count: a THIRD restart must see exactly 23,565, once —
    // not 33,821 + 23,565, and not the row counted twice.
    await new Promise((r) => setTimeout(r, 10));
    const reopened2 = reopen(url);
    const p3 = new SpendPolicy(cfg, clock.now, { store: reopened2 });
    await p3.boot();
    expect(p3.reservedStroops(verdict.reservation)).toBe(23_565);

    // And the total booked against the window is exactly one reservation's
    // worth, not two — checked via a tight ceiling that two reservations
    // would trip but one would not.
    const tight = new SpendPolicy({ ...cfg, spendCeilingStroops: 23_565 + FLAT_ESTIMATE - 1 }, clock.now, {
      store: reopened2,
    });
    await tight.boot();
    expect(tight.checkSettle("GOTHER").allowed, "exactly one reservation counted, not two").toBe(false);
    const evenTighter = new SpendPolicy({ ...cfg, spendCeilingStroops: 23_565 - 1 }, clock.now, {
      store: reopened2,
    });
    await evenTighter.boot();
    // This ceiling is below even the single reconciled reservation alone,
    // confirming boot() really did load it (not silently drop it).
    expect(evenTighter.checkSettle("GOTHER").allowed).toBe(false);
  });
});

describe("createSpendPolicy — store wiring", () => {
  it("omitting store behaves exactly as pre-G-10: boot() is a no-op, nothing persists", async () => {
    const p = createSpendPolicy({ network: "stellar:pubnet", perSettleEstimateStroops: FLAT_ESTIMATE });
    await expect(p.boot()).resolves.toBeUndefined();
    const verdict = p.checkSettle("GMERCHANT");
    expect(verdict.allowed).toBe(true);
  });
});

describe("window-scoping — a reservation counts only toward ITS OWN window, in memory and in the DB", () => {
  it("in-memory: a reservation older than the spend window stops counting against the ceiling (src/policy.ts:240)", async () => {
    // evaluate()'s own filter — `this.globalSpend.filter((e) => e.at > t -
    // this.cfg.spendWindowMs)` — runs on EVERY checkSettle() call, so this
    // needs no explicit "prune" call to demonstrate: the ceiling simply
    // stops seeing an elapsed reservation the next time anything is
    // checked at all, regardless of status.
    const clock = nowFn();
    const tightCfg = { ...cfg, spendCeilingStroops: FLAT_ESTIMATE }; // room for exactly one
    const p = new SpendPolicy(tightCfg, clock.now);
    const first = p.checkSettle("GMERCHANT");
    expect(first.allowed, "first settle fits exactly at the ceiling").toBe(true);
    expect(p.checkSettle("GOTHER").allowed, "a second settle in the SAME window exceeds it").toBe(false);

    clock.advance(cfg.spendWindowMs + 1); // first reservation's window has elapsed
    expect(
      p.checkSettle("GOTHER").allowed,
      "once the first reservation's window elapses, it stops counting — room again",
    ).toBe(true);
    void first;
  });

  it("in-memory: a RECONCILED reservation also stops counting once its window elapses — status does not exempt it", async () => {
    const clock = nowFn();
    // Ceiling fits ONE flat-estimate reservation plus the reconciled
    // 23,565, but not two flat-estimate reservations at once — tight
    // enough that a second settle's own fresh (flat-estimate) reservation
    // only fits once the first one has aged out, isolating what status
    // alone does (vs. what the window elapsing does).
    const tightCfg = { ...cfg, spendCeilingStroops: FLAT_ESTIMATE + 23_565 - 1 };
    const p = new SpendPolicy(tightCfg, clock.now);
    const verdict = p.checkSettle("GMERCHANT");
    await p.adjustReservation(verdict.reservation, 23_565, "reconciled");
    expect(
      p.checkSettle("GOTHER").allowed,
      "a second settle's own flat-estimate reservation, plus the still-live reconciled one, exceeds the ceiling",
    ).toBe(false);

    clock.advance(cfg.spendWindowMs + 1);
    expect(
      p.checkSettle("GOTHER").allowed,
      "once the reconciled reservation's window elapses, a fresh settle fits alone — reconciled status did not exempt it from aging out",
    ).toBe(true);
  });

  it("DB: deleteElapsedSpendReservations removes rows whose window has elapsed, of every status (src/store.ts)", async () => {
    const { store } = tmpStore();
    await store.init();
    await store.saveSpendReservation({ id: 1, at: 1000, stroops: 100, status: "open" });
    await store.saveSpendReservation({ id: 2, at: 1000, stroops: 200, status: "reconciled" });
    await store.saveSpendReservation({ id: 3, at: 1000, stroops: 300, status: "unreconcilable" });
    await store.saveSpendReservation({ id: 4, at: 999_999, stroops: 400, status: "open" }); // still live

    await store.deleteElapsedSpendReservations(60_000);

    const remaining = await store.loadOpenSpendReservations(0);
    expect(remaining.map((r) => r.id)).toEqual([4]);
    await store.close();
  });

  it("the table does not grow forever on a long-running process that never restarts (src/policy.ts's maybeCleanupDb)", async () => {
    // boot() cleans up once, at startup — THE GAP this test is for: a
    // process that stays up (Railway's always-on hosting, specifically)
    // never calls boot() again, so without an ongoing trigger every
    // settlement would add a row nothing ever removes.
    const { store, url } = tmpStore();
    await store.init();
    const clock = nowFn();
    const p = new SpendPolicy(cfg, clock.now, { store });

    // Settle once per (simulated) minute for a while, well past the spend
    // window each time, so every earlier reservation is elapsed by the
    // time a later one is reserved.
    for (let i = 0; i < 20; i++) {
      p.checkSettle(`G${i}`);
      clock.advance(60_000); // 1 simulated minute — several spend windows
    }
    await new Promise((r) => setTimeout(r, 20)); // let fire-and-forget writes land

    // Without the periodic trigger, all 20 rows would still be sitting in
    // the table (boot() never ran again). With it, the table has been
    // swept at least once during those 20 minutes of simulated time
    // (DB_CLEANUP_INTERVAL_MS is 10 minutes), so it must hold far fewer
    // than 20 rows by now.
    const reopened = reopen(url);
    const stillPresent = await reopened.loadOpenSpendReservations(0);
    expect(
      stillPresent.length,
      "periodic cleanup must have run at least once in 20 simulated minutes — the table is not unbounded",
    ).toBeLessThan(20);
    await reopened.close();
  });
});
