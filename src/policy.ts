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
// cannot read the real per-settle fee at the route without a second simulation.
// We therefore estimate each settle at a configured worst-case (default: the fee
// ceiling), which OVER-counts and thus fails safe — the ceiling bites earlier,
// never later, than true spend.

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
  rateMax: number;
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

/**
 * In-memory, single-instance rolling-window accounting. Timestamps are kept in
 * arrays and pruned on each check; at the configured windows/limits the arrays
 * stay small. No external store — consistent with the no-DB constraint. State is
 * lost on restart (acceptable: the windows are seconds, not durable budgets).
 */
export class SpendPolicy {
  private readonly cfg: SpendPolicyConfig;
  private readonly now: Clock;
  private readonly perPayTo = new Map<string, number[]>();
  /** F12: settle timestamps per BOUND resource URL. */
  private readonly perUrl = new Map<string, number[]>();
  /** F12: settle timestamps shared by ALL unbound URLs. */
  private unboundPool: number[] = [];
  private globalSpend: Array<{ at: number; stroops: number; id: number }> = [];
  /** Monotonic reservation id so a refund can only release its OWN entry. */
  private nextReservationId = 1;

  constructor(cfg: SpendPolicyConfig, now: Clock = Date.now) {
    this.cfg = cfg;
    this.now = now;
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
    if (payToRecent.length >= this.cfg.rateMax) return "rate_limited_payto";
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
    return reservationId;
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
  }
}

function prune(times: number[], cutoff: number): number[] {
  return times.filter((t) => t > cutoff);
}

/** Build a policy from config values, applying defaults. */
export function createSpendPolicy(input: {
  network: "stellar:testnet" | "stellar:pubnet";
  rateMax?: number;
  rateWindowMs?: number;
  spendCeilingStroops?: number;
  spendWindowMs?: number;
  perSettleEstimateStroops: number;
  perUrlMax?: number;
  perPayToMax?: number;
  unboundPoolMax?: number;
}): SpendPolicy {
  return new SpendPolicy({
    network: input.network,
    rateMax: input.rateMax ?? 30,
    rateWindowMs: input.rateWindowMs ?? 60_000,
    spendCeilingStroops: input.spendCeilingStroops ?? 50_000_000, // 5 XLM
    spendWindowMs: input.spendWindowMs ?? 60_000,
    perSettleEstimateStroops: input.perSettleEstimateStroops,
    perUrlMax: input.perUrlMax ?? 10,
    perPayToMax: input.perPayToMax ?? 100,
    unboundPoolMax: input.unboundPoolMax ?? 10,
  });
}
