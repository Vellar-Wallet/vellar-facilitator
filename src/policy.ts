// Fix 1 — sponsorship spend control. The audit called the sponsor drain
// self-limiting because the attacker funds each payment; that is wrong. A
// self-dealer deploys their own SEP-41 token, mints supply, and settles
// self→self: the transfer nets to zero for them, but the facilitator's sponsor
// pays XLM network fees every time, and simulation cost can be pushed toward
// MAX_TX_FEE_STROOPS. Fix 0's ownership binding stops payTo diversification
// *under a given URL*, so a self-dealer must reuse their payTo across any new
// URLs they spam — which makes PER-PAYTO throttling the load-bearing control. A
// global rolling XLM-spend ceiling is the fail-closed backstop.
//
// Enforcement is centralized here (the /settle route consults it) rather than
// scattered across handlers. It is fail-OPEN on testnet — limits are evaluated
// and logged but never block, so demos/examples run freely — and fail-CLOSED on
// pubnet, where crossing a limit refuses /settle.
//
// HONEST LIMIT OF THE PER-PAYTO CONTROL (audit D6). The per-payTo rate limit keys
// on the client-supplied payTo. A self-dealer who controls several addresses can
// rotate them and get a fresh bucket per address, so per-payTo is a CONVENIENCE
// THROTTLE against naive/repeated abuse — it is not a hard bound. The real bound
// against a determined rotating self-dealer is the GLOBAL rolling spend ceiling,
// which is address-independent and (since audit D3) cannot be skipped by omitting
// payTo. Deliberately NOT "fixed" by normalizing the payTo string: normalization
// would stop only trivial casing/whitespace variation while making the control
// look stronger than it is. Size the global ceiling as if per-payTo did not exist.
//
// Note on the spend estimate: the simulated fee is NOT exposed on the verify
// response (@x402/core VerifyResponse is isValid/payer/reason only), so we
// cannot read the real per-settle fee at the ROUTE, before calling
// facilitator.settle(), without a second simulation. We therefore still
// RESERVE each settle at a configured worst-case (default: the fee ceiling)
// at that point — which OVER-counts and thus fails safe, the ceiling bites
// earlier, never later, than true spend.
//
// G-10 (2026-11-02): that flat reservation no longer has to stand for the
// whole settlement. src/rpcstatus.ts captures the REAL transaction's own
// `tx.fee` (the max the network could charge) the moment it is actually
// submitted — no second simulation, since it is the exact object being
// sent — and the route adjusts the reservation down to that real number
// immediately after facilitator.settle() returns. A second adjustment, to
// the real post-confirmation `fee_charged` (Soroban can refund unused
// resource fee, so charged <= submitted), happens fire-and-forget once
// getTransaction confirms the outcome. The flat estimate above is now only
// ever the reservation's FIRST few milliseconds — the worst case it was
// sized for is still what protects the ceiling in that brief window before
// either adjustment lands.

import type { StoredSpendReservation } from "./store.js";
import { incrementSpendUnreconcilableTotal } from "./metrics.js";

/** The narrow slice of CatalogStore this file actually needs — same
 *  Pick-shaped-interface convention as trust.ts's rpcServer option, so a
 *  test can hand SpendPolicy a store double without implementing every
 *  other CatalogStore method. */
export type SpendReservationStore = Pick<
  import("./store.js").CatalogStore,
  "saveSpendReservation" | "loadOpenSpendReservations" | "deleteElapsedSpendReservations"
>;

export type SettleRejectReason =
  | "rate_limited_payto"
  | "spend_ceiling"
  | "rate_limited_url"
  | "unbound_pool_exhausted";

/** F12 — the identity a settle is budgeted against. `bound` means the resource
 * URL has a durable ownership binding (F11 tombstone); `unbound` means it does
 * not yet. Deliberately keyed on the BINDING, not on verifiedOwner: the latter
 * is not persisted and resets on every restart, so using it would collapse every
 * merchant into the shared unbound pool after a restart. */
export interface SettleIdentity {
  /** Canonical resource URL. */
  resourceUrl: string;
  /** Payment recipient. */
  payTo: string;
  /** Whether resourceUrl carries a durable ownership binding. */
  bound: boolean;
}

export interface SpendPolicyConfig {
  network: "stellar:testnet" | "stellar:pubnet";
  /** Max settlements per payTo per window (default 30). */
  /** Per-payTo rate window in ms (default 60_000). */
  rateWindowMs: number;
  /** Global rolling sponsor-spend ceiling in stroops (default 5 XLM = 50_000_000). */
  spendCeilingStroops: number;
  /** Global spend window in ms (default 60_000). */
  spendWindowMs: number;
  /** Estimated stroops charged per settle for accounting (default = fee ceiling). */
  perSettleEstimateStroops: number;
  /** F12: settles per window for one BOUND resource URL (default 10). */
  perUrlMax: number;
  /** F12: settles per window for one payTo across all its URLs (default 100 —
   * equal to the global ceiling, so it never binds honest traffic today and
   * starts doing work only if the global ceiling is later raised). */
  perPayToMax: number;
  /** F12: settles per window shared by ALL unbound URLs (default 10 — exactly
   * one bound URL's budget, so spraying N unverified URLs yields 10/N each). */
  unboundPoolMax: number;
}

export interface SettleVerdict {
  /** Whether the settle may proceed. On testnet this is always true. */
  allowed: boolean;
  /** The reason a pubnet settle was refused. */
  reason?: SettleRejectReason;
  /** On testnet, the reason that WOULD have refused this settle (observability). */
  wouldReject?: SettleRejectReason;
  /** Identifies THIS reservation so refundUnspent releases only it. */
  reservation?: number;
}

type Clock = () => number;

/** G-10 — how often reserve() opportunistically re-triggers
 *  deleteElapsedSpendReservations on a long-running process (boot() only
 *  runs it once, at startup). Deliberately much coarser than the spend
 *  window itself: this is table-size hygiene, not accounting, so it does
 *  not need to run anywhere near every settle — it needs to run often
 *  enough that the table stays bounded, not on a schedule tied to
 *  correctness. */
const DB_CLEANUP_INTERVAL_MS = 10 * 60_000; // 10 minutes

/**
 * In-memory, single-instance rolling-window accounting. Timestamps are kept in
 * arrays and pruned on each check; at the configured windows/limits the arrays
 * stay small.
 *
 * G-10 (2026-11-02): `globalSpend` — the one piece of this that is real
 * sponsor-XLM accounting, not a rate-limit timestamp — now OPTIONALLY
 * persists through a CatalogStore, so a crash between a settlement's
 * submission and its reconciliation cannot lose or double-count real spend.
 * perPayTo/perUrl/unboundPool stay in-memory only: they bound REQUEST RATE,
 * not spend, and losing a few seconds of rate-limit history on a restart
 * was already the accepted tradeoff this file's history describes. Without
 * a store (the constructor's `store` argument omitted), behaviour is
 * UNCHANGED from before G-10 — every reservation is still tracked, just
 * never durably, exactly like today.
 */
export class SpendPolicy {
  private readonly cfg: SpendPolicyConfig;
  private readonly now: Clock;
  private readonly store: SpendReservationStore | undefined;
  private readonly log: (msg: string) => void;
  private readonly perPayTo = new Map<string, number[]>();
  /** F12: settle timestamps per BOUND resource URL. */
  private readonly perUrl = new Map<string, number[]>();
  /** F12: settle timestamps shared by ALL unbound URLs. */
  private unboundPool: number[] = [];
  private globalSpend: Array<{ at: number; stroops: number; id: number }> = [];
  /** Monotonic reservation id so a refund can only release its OWN entry.
   *  Seeded past the highest id loaded from storage at boot() time, so a
   *  restart never reissues an id a still-live persisted row already owns. */
  private nextReservationId = 1;
  /** G-10 — when deleteElapsedSpendReservations last ran. boot() runs it
   *  once; on a long-running process that never restarts, that one run is
   *  the only cleanup the table would EVER get without this — every
   *  settlement persists a row, and nothing else ever removes one. See
   *  reserve()'s own opportunistic trigger below. */
  private lastDbCleanupAt = 0;

  constructor(
    cfg: SpendPolicyConfig,
    now: Clock = Date.now,
    opts: { store?: SpendReservationStore; log?: (msg: string) => void } = {},
  ) {
    this.cfg = cfg;
    this.now = now;
    this.store = opts.store;
    this.log = opts.log ?? ((msg) => console.warn(msg));
  }

  /**
   * Re-seed `globalSpend` from whatever reservations are still inside a
   * live window, so a restart does not silently reset the ceiling to zero
   * spend while real, unreconciled sponsor exposure is still outstanding.
   * A no-op without a store. Call once, at boot, before the first
   * checkSettle() — concurrent calls would double-seed, and this class has
   * no lock to prevent that, matching every other single-instance
   * assumption already documented elsewhere in this file.
   */
  async boot(): Promise<void> {
    if (!this.store) return;
    const t = this.now();
    const rows = await this.store.loadOpenSpendReservations(t - this.cfg.spendWindowMs);
    for (const row of rows) {
      this.globalSpend.push({ at: row.at, stroops: row.stroops, id: row.id });
      if (row.id >= this.nextReservationId) this.nextReservationId = row.id + 1;
    }
    // Opportunistic cleanup — see deleteElapsedSpendReservations' own
    // interface doc for why this runs here rather than on a timer.
    await this.store.deleteElapsedSpendReservations(t - this.cfg.spendWindowMs).catch(() => {
      // Cleanup failing must never block boot; a row that should have been
      // deleted just gets deleted on a LATER boot or write instead.
    });
  }

  /** True on pubnet (limits enforced), false on testnet (log-only). */
  private get enforced(): boolean {
    return this.cfg.network === "stellar:pubnet";
  }

  /**
   * Consult before calling facilitator.settle. On pubnet a tripped limit returns
   * allowed:false with a reason; on testnet it returns allowed:true but sets
   * wouldReject so the route can log what production would have refused.
   *
   * There is NO separate record step: a checkSettle that returns allowed:true
   * has already reserved the settle in both rolling windows, so concurrent
   * bursts are bounded without a second call racing the check. If the settlement
   * then turns out to have spent nothing on-chain, the caller releases the
   * global reservation with refundUnspent().
   */
  checkSettle(id: SettleIdentity | string): SettleVerdict {
    // A bare payTo keeps older callers working; such a settle is treated as
    // unbound with no URL of its own.
    const ident: SettleIdentity =
      typeof id === "string" ? { resourceUrl: "", payTo: id, bound: false } : id;
    const t = this.now();
    const tripped = this.evaluate(ident, t);
    if (tripped) {
      if (this.enforced) return { allowed: false, reason: tripped };
      // Fail-open (testnet): allow, but still reserve and flag.
      const tok = this.reserve(ident, t);
      return { allowed: true, wouldReject: tripped, reservation: tok };
    }
    const tok = this.reserve(ident, t);
    return { allowed: true, reservation: tok };
  }

  /**
   * Which limit (if any) this settle would cross. Evaluates EVERY budget and
   * mutates nothing — reservation happens only after all of them pass, so a
   * refused settle can never leave a partial consume behind (the failure mode
   * that let a throwing settle leak its reservation).
   */
  private evaluate(id: SettleIdentity, t: number): SettleRejectReason | undefined {
    const payToRecent = prune(this.perPayTo.get(id.payTo) ?? [], t - this.cfg.rateWindowMs);
    // ONE per-payTo budget. There used to be two (rateMax and perPayToMax) over
    // the same key and window, so the tighter silently shadowed the looser and
    // F12's per-payTo dimension never ran.
    if (payToRecent.length >= this.cfg.perPayToMax) return "rate_limited_payto";

    if (id.bound && id.resourceUrl) {
      const urlRecent = prune(this.perUrl.get(id.resourceUrl) ?? [], t - this.cfg.rateWindowMs);
      if (urlRecent.length >= this.cfg.perUrlMax) return "rate_limited_url";
    } else {
      // Unbound URLs share ONE pool sized at a single bound URL's budget, so
      // spraying N unverified URLs yields perUrlMax/N each. Spraying competes
      // with itself rather than with honest merchants — that ratio IS the
      // economic signal attached to claiming an identity (F11).
      const pool = prune(this.unboundPool, t - this.cfg.rateWindowMs);
      if (pool.length >= this.cfg.unboundPoolMax) return "unbound_pool_exhausted";
    }

    this.globalSpend = this.globalSpend.filter((e) => e.at > t - this.cfg.spendWindowMs);
    const windowSpend = this.globalSpend.reduce((s, e) => s + e.stroops, 0);
    if (windowSpend + this.cfg.perSettleEstimateStroops > this.cfg.spendCeilingStroops) {
      return "spend_ceiling";
    }
    return undefined;
  }

  /**
   * Count this settle in EVERY window at once. Called only after evaluate()
   * cleared all budgets, so the three records succeed or fail together — there
   * is no interleaving point at which one budget is consumed and another is not.
   */
  private reserve(id: SettleIdentity, t: number): number {
    const recent = prune(this.perPayTo.get(id.payTo) ?? [], t - this.cfg.rateWindowMs);
    recent.push(t);
    this.perPayTo.set(id.payTo, recent);

    if (id.bound && id.resourceUrl) {
      const u = prune(this.perUrl.get(id.resourceUrl) ?? [], t - this.cfg.rateWindowMs);
      u.push(t);
      this.perUrl.set(id.resourceUrl, u);
    } else {
      this.unboundPool = prune(this.unboundPool, t - this.cfg.rateWindowMs);
      this.unboundPool.push(t);
    }
    const reservationId = this.nextReservationId++;
    this.globalSpend.push({ at: t, stroops: this.cfg.perSettleEstimateStroops, id: reservationId });
    this.evictElapsed(t);
    // Fire-and-forget: checkSettle() (this method's only caller) is
    // SYNCHRONOUS, consulted on /settle's hot path before anything about
    // the real transaction exists yet, so this cannot become a round trip
    // in front of settlement. Losing JUST this initial write in a crash
    // within the next few milliseconds leaves the in-memory ceiling
    // slightly ahead of the persisted one for that brief window — the
    // SAME exposure this class already had before G-10, for the SAME
    // reason (the flat estimate here is immediately superseded by
    // adjustReservation's real-fee write, which IS awaited at its call
    // site — see server.ts). The durability guarantee this file promises
    // is about the SUBMIT -> RECONCILE gap, not this pre-submission one.
    void this.persist(reservationId, t, this.cfg.perSettleEstimateStroops, "open");
    this.maybeCleanupDb(t);
    return reservationId;
  }

  /**
   * G-10 — opportunistic, time-gated trigger for
   * deleteElapsedSpendReservations, so the persisted table does not grow
   * forever on a process that runs for a long time without restarting
   * (boot() only cleans up once, at startup). Gated on wall-clock time
   * since the LAST cleanup, not on settle count, so a quiet period does
   * not need N settles to happen before the table gets tidied, and a busy
   * one does not run the cleanup query on every single settle.
   *
   * Fire-and-forget, same reasoning as persist() above: this is table
   * hygiene, never something /settle should wait on.
   */
  private maybeCleanupDb(t: number): void {
    if (!this.store) return;
    if (t - this.lastDbCleanupAt < DB_CLEANUP_INTERVAL_MS) return;
    this.lastDbCleanupAt = t;
    void this.store.deleteElapsedSpendReservations(t - this.cfg.spendWindowMs).catch((err) => {
      this.log(
        `[policy] periodic spend_reservation cleanup failed (${String((err as Error)?.message ?? err)}) — ` +
          `will retry on the next trigger; accounting is unaffected either way`,
      );
    });
  }

  private async persist(
    id: number,
    at: number,
    stroops: number,
    status: StoredSpendReservation["status"],
  ): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.saveSpendReservation({ id, at, stroops, status });
    } catch (err) {
      this.log(
        `[policy] failed to persist spend reservation ${id} (${String((err as Error)?.message ?? err)}) — ` +
          `in-memory accounting is unaffected, but this reservation will not survive a restart`,
      );
    }
  }

  /**
   * Audit D10: drop per-payTo buckets whose entries have all aged out. Without
   * this the Map grows monotonically under payTo rotation (and on testnet, where
   * fail-open reserves even on a rejected settle, under ANY traffic) — an
   * unbounded-memory vector. Eviction is O(size) and runs on the settle path, so
   * it is bounded by how many payTos are actually active in the window.
   */
  private evictElapsed(t: number): void {
    const cutoff = t - this.cfg.rateWindowMs;
    for (const [key, times] of this.perPayTo) {
      // Use the MAX rather than the last element: prune() preserves insertion
      // order, which is only ascending while the clock moves forward. A backward
      // clock step (NTP correction) would otherwise evict a bucket that still
      // holds in-window entries, silently resetting that payTo's rate limit.
      if (times.length === 0 || Math.max(...times) <= cutoff) this.perPayTo.delete(key);
    }
    for (const [key, times] of this.perUrl) {
      if (times.length === 0 || Math.max(...times) <= cutoff) this.perUrl.delete(key);
    }
  }

  /** Number of per-payTo buckets currently tracked (observability + tests). */
  trackedPayTos(): number {
    return this.perPayTo.size;
  }

  /**
   * Release a reservation made by checkSettle when the settlement turned out to
   * spend NOTHING on-chain (it never reached submission). Without this, a
   * request carrying an unsubmittable payload — which costs the sponsor zero XLM
   * — still consumed a slice of the global ceiling, so cheap junk could exhaust
   * the budget and refuse all real settlement for a whole window.
   *
   * Only the global spend reservation is released; the per-payTo RATE count is
   * deliberately kept, so failed attempts still count against flood limits.
   */
  refundUnspent(token?: number): void {
    if (token === undefined) return;
    const idx = this.globalSpend.findIndex((e) => e.id === token);
    if (idx !== -1) this.globalSpend.splice(idx, 1);
    // Fire-and-forget, same reasoning as reserve()'s own persist() call —
    // refundUnspent fires synchronously from /settle's response path for a
    // submission that spent ZERO sponsor XLM, so there is no real-money
    // exposure riding on this particular write landing durably before the
    // response returns. Marked 'reconciled' at 0 stroops rather than left
    // 'open': there is no single-row delete on CatalogStore (only the
    // batch window-cutoff one), and a 0-stroops 'reconciled' row costs
    // nothing against any budget in the meantime and is swept by the next
    // deleteElapsedSpendReservations pass at `at: 0`, i.e. immediately.
    if (this.store) {
      void this.persist(token, 0, 0, "reconciled");
    }
  }

  /**
   * G-10 — correct a reservation's amount in place, without changing its
   * position in the window (the `at` timestamp is untouched, so it still
   * ages out on the SAME schedule it was reserved on — adjusting the amount
   * is not a new reservation).
   *
   * Called twice per settlement, at two different points of certainty:
   *  1. Right after facilitator.settle() returns, down from the flat
   *     perSettleEstimateStroops to the real submitted fee (tx.fee — the
   *     max the network COULD charge, captured by rpcstatus.ts).
   *  2. After on-chain confirmation, down again to the real fee_charged
   *     (Soroban can refund unused resource fee, so charged <= submitted).
   *
   * UNLIKE reserve()'s own write, this one IS awaited at its call site
   * (server.ts) — this is exactly the "crash between submit and reconcile"
   * window the durability requirement is about, so the persisted row must
   * reflect the real fee before the caller considers the adjustment done.
   *
   * A no-op if the token is unknown (already refunded, or never reserved —
   * e.g. the flat estimate reservation that already got removed via
   * refundUnspent for a submission that never reached the chain at all).
   * Returns whether it found and adjusted the entry, so a caller can tell
   * "already gone" from "adjusted".
   */
  async adjustReservation(
    token: number | undefined,
    newStroops: number,
    status: StoredSpendReservation["status"] = "open",
  ): Promise<boolean> {
    if (token === undefined) return false;
    const entry = this.globalSpend.find((e) => e.id === token);
    if (!entry) return false;
    entry.stroops = newStroops;
    await this.persist(token, entry.at, newStroops, status);
    if (status === "unreconcilable") {
      this.log(
        `[policy] spend reservation ${token} is UNRECONCILABLE — getTransaction reported NOT_FOUND past ` +
          `the RPC's retention window. Kept at its last-known amount (${newStroops} stroops), never ` +
          `adjusted again. If this ever happens, something was unreachable for close to the retention ` +
          `window's full length.`,
      );
      incrementSpendUnreconcilableTotal();
    }
    return true;
  }

  /** The current stroops booked for a reservation, or undefined if it is
   *  not (or no longer) tracked — e.g. already released, or its window has
   *  already elapsed and evictElapsed/evaluate's own filter dropped it.
   *  Read-only; exists for persistence (snapshotting what to write) and for
   *  tests, never consulted by the accounting itself. */
  reservedStroops(token: number | undefined): number | undefined {
    if (token === undefined) return undefined;
    return this.globalSpend.find((e) => e.id === token)?.stroops;
  }
}

function prune(times: number[], cutoff: number): number[] {
  return times.filter((t) => t > cutoff);
}

/** Build a policy from config values, applying defaults. */
export function createSpendPolicy(input: {
  network: "stellar:testnet" | "stellar:pubnet";
  rateWindowMs?: number;
  spendCeilingStroops?: number;
  spendWindowMs?: number;
  perSettleEstimateStroops: number;
  perUrlMax?: number;
  perPayToMax?: number;
  unboundPoolMax?: number;
  /** G-10 — optional restart-survival for the global spend reservation.
   *  Omitted means exactly pre-G-10 behaviour: in-memory only. */
  store?: SpendReservationStore;
  log?: (msg: string) => void;
}): SpendPolicy {
  return new SpendPolicy(
    {
      network: input.network,
      rateWindowMs: input.rateWindowMs ?? 60_000,
      spendCeilingStroops: input.spendCeilingStroops ?? 50_000_000, // 5 XLM
      spendWindowMs: input.spendWindowMs ?? 60_000,
      perSettleEstimateStroops: input.perSettleEstimateStroops,
      perUrlMax: input.perUrlMax ?? 10,
      perPayToMax: input.perPayToMax ?? 50,
      unboundPoolMax: input.unboundPoolMax ?? 10,
    },
    undefined,
    {
      ...(input.store !== undefined ? { store: input.store } : {}),
      ...(input.log !== undefined ? { log: input.log } : {}),
    },
  );
}
