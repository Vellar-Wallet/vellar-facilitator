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

export type SettleRejectReason = "rate_limited_payto" | "spend_ceiling";

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
}

export interface SettleVerdict {
  /** Whether the settle may proceed. On testnet this is always true. */
  allowed: boolean;
  /** The reason a pubnet settle was refused. */
  reason?: SettleRejectReason;
  /** On testnet, the reason that WOULD have refused this settle (observability). */
  wouldReject?: SettleRejectReason;
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
  private globalSpend: Array<{ at: number; stroops: number }> = [];

  constructor(cfg: SpendPolicyConfig, now: Clock = Date.now) {
    this.cfg = cfg;
    this.now = now;
  }

  /** True on pubnet (limits enforced), false on testnet (log-only). */
  private get enforced(): boolean {
    return this.cfg.network === "stellar:pubnet";
  }

  /**
   * Consult before calling facilitator.settle. If allowed, the caller should
   * proceed and then call recordSettle. On pubnet a tripped limit returns
   * allowed:false with a reason; on testnet it returns allowed:true but sets
   * wouldReject so the route can log what production would have refused.
   *
   * A checkSettle that returns allowed:true reserves the settle in the rolling
   * windows (it counts immediately), so concurrent bursts are bounded without a
   * separate record step racing the check.
   */
  checkSettle(payTo: string): SettleVerdict {
    const t = this.now();
    const tripped = this.evaluate(payTo, t);
    if (tripped) {
      if (this.enforced) return { allowed: false, reason: tripped };
      // Fail-open (testnet): allow, but still reserve and flag.
      this.reserve(payTo, t);
      return { allowed: true, wouldReject: tripped };
    }
    this.reserve(payTo, t);
    return { allowed: true };
  }

  /** Which limit (if any) this settle would cross, without mutating state. */
  private evaluate(payTo: string, t: number): SettleRejectReason | undefined {
    const recent = prune(this.perPayTo.get(payTo) ?? [], t - this.cfg.rateWindowMs);
    if (recent.length >= this.cfg.rateMax) return "rate_limited_payto";

    this.globalSpend = this.globalSpend.filter((e) => e.at > t - this.cfg.spendWindowMs);
    const windowSpend = this.globalSpend.reduce((s, e) => s + e.stroops, 0);
    if (windowSpend + this.cfg.perSettleEstimateStroops > this.cfg.spendCeilingStroops) {
      return "spend_ceiling";
    }
    return undefined;
  }

  /** Count this settle in both rolling windows. */
  private reserve(payTo: string, t: number): void {
    const recent = prune(this.perPayTo.get(payTo) ?? [], t - this.cfg.rateWindowMs);
    recent.push(t);
    this.perPayTo.set(payTo, recent);
    this.globalSpend.push({ at: t, stroops: this.cfg.perSettleEstimateStroops });
    this.evictElapsed(t);
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
      const last = times[times.length - 1];
      if (last === undefined || last <= cutoff) this.perPayTo.delete(key);
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
  refundUnspent(): void {
    const idx = this.globalSpend.findIndex((e) => e.stroops === this.cfg.perSettleEstimateStroops);
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
}): SpendPolicy {
  return new SpendPolicy({
    network: input.network,
    rateMax: input.rateMax ?? 30,
    rateWindowMs: input.rateWindowMs ?? 60_000,
    spendCeilingStroops: input.spendCeilingStroops ?? 50_000_000, // 5 XLM
    spendWindowMs: input.spendWindowMs ?? 60_000,
    perSettleEstimateStroops: input.perSettleEstimateStroops,
  });
}
