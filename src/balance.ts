// Fix 3 — sponsor balance guard. The sponsor account pays every settlement's
// network fee; if it runs dry, settlements fail on-chain with confusing errors.
// This guard polls the sponsor's XLM balance on an interval (off the hot path)
// and lets /settle consult a cached verdict:
//   - above the soft floor            → ok
//   - between soft and hard floor     → low  (warn-logged, settle still allowed)
//   - below the hard floor            → critical (settle refused with 503)
//   - check never succeeded / errored → unknown (settle ALLOWED — fail open)
//
// Design constraints honored: the first check is not awaited at startup (the
// guard begins "unknown"/allow), and a failing check degrades to "unknown"
// rather than refusing — a flaky balance read must never cause a self-inflicted
// settle outage. Discovery is unaffected regardless.

export type BalanceStatus = "ok" | "low" | "critical" | "unknown";

export interface BalanceGuardOptions {
  /** Returns the sponsor's available XLM balance in stroops. */
  fetchBalanceStroops: () => Promise<number | string>;
  /** Warn below this (default 10 XLM). */
  softFloorStroops: number;
  /** Refuse settle below this (default 2 XLM). */
  hardFloorStroops: number;
  /** Poll interval in ms (default 60_000). */
  intervalMs: number;
  /** Injected logger (defaults to console). */
  logger?: { warn: (msg: string) => void; error: (msg: string) => void };
}

export class BalanceGuard {
  private readonly opts: BalanceGuardOptions;
  private currentStatus: BalanceStatus = "unknown";
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: BalanceGuardOptions) {
    this.opts = opts;
  }

  /** Current cached status. "unknown" until the first successful check. */
  status(): BalanceStatus {
    return this.currentStatus;
  }

  /** Whether /settle may proceed. Only "critical" blocks; "unknown" fails open. */
  settleAllowed(): boolean {
    return this.currentStatus !== "critical";
  }

  /** Perform one balance check and update status. Never throws. */
  async refresh(): Promise<void> {
    try {
      const raw = await this.opts.fetchBalanceStroops();
      const stroops = typeof raw === "string" ? Number(raw) : raw;
      if (!Number.isFinite(stroops)) {
        this.currentStatus = "unknown";
        this.opts.logger?.error("[balance] sponsor balance check returned a non-numeric value");
        return;
      }
      if (stroops < this.opts.hardFloorStroops) {
        this.currentStatus = "critical";
        this.opts.logger?.error(
          `[balance] sponsor below HARD floor (${stroops} < ${this.opts.hardFloorStroops} stroops) — /settle refused`,
        );
      } else if (stroops < this.opts.softFloorStroops) {
        this.currentStatus = "low";
        this.opts.logger?.warn(
          `[balance] sponsor below soft floor (${stroops} < ${this.opts.softFloorStroops} stroops) — top up soon`,
        );
      } else {
        this.currentStatus = "ok";
      }
    } catch (err) {
      // A failed check must not flip settle off; degrade to unknown (fail open).
      this.currentStatus = "unknown";
      this.opts.logger?.error(`[balance] sponsor balance check failed (settle still allowed): ${String(err)}`);
    }
  }

  /** Begin periodic checks. Does not await the first check — startup is not
   * blocked. The interval is unref'd so it never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    void this.refresh(); // fire-and-forget first check
    this.timer = setInterval(() => void this.refresh(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
