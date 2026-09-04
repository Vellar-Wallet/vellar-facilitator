// Channel-account balance monitor.
//
// THE GAP THIS CLOSES. `ChannelPool.disable()` / `enable()` have been fully
// implemented, exported and tested since the pool shipped — and had ZERO
// production call sites. Nothing ever pulled a channel account out of rotation,
// so an account drifting toward the Stellar minimum reserve stayed `available`
// and kept being acquired until a settlement using it failed on-chain. That is
// the operational gap named in docs/deploy-runbook.md §11 and BUILD-PLAN.md
// Phase 3; this module is the caller those two methods were waiting for.
//
// WHY CHANNEL ACCOUNTS NEED SO LITTLE. They never pay their own transaction
// fees — the sponsor is the `feeBumpSigner` for every settlement — and they
// never hold the payment asset, since funds move payer -> payTo directly. So
// each one only needs the Stellar minimum reserve to keep existing
// (docs/channel-pool-design.md §5/§6). The floor here is a reserve floor, not a
// fee budget.
//
// HOW THIS DIFFERS FROM BalanceGuard, deliberately. BalanceGuard watches ONE
// account and fails OPEN on an unreadable balance: refusing settlement because
// Horizon hiccuped would be self-inflicted downtime. Here the risk inverts — if
// an unreadable balance disabled an account, a single Horizon outage would
// disable all 50 and take the pool to zero, halting settlement completely. So a
// failed check leaves the account exactly as it is, and only a PER-ACCOUNT run
// of CONSECUTIVE_FAILURE_LIMIT failures disables it. That bound exists so a
// genuinely unreachable account is eventually pulled, without letting a global
// outage empty the pool on the first tick.

import type { ChannelPool } from "./channelPool.js";

/**
 * Consecutive failed checks for ONE account before it is disabled as stale.
 *
 * Hardcoded, not configurable: it is a safety backstop, and the failure mode of
 * tuning it is asymmetric. Too low and a transient Horizon blip empties the
 * pool; too high and a genuinely dead account keeps being handed out. Five at
 * the default 60s interval means ~5 minutes of sustained per-account failure
 * before withdrawal — long enough to ride out a blip, short enough to matter.
 */
export const CONSECUTIVE_FAILURE_LIMIT = 5;

const STROOPS_PER_XLM = 10_000_000;

export interface ChannelMonitorOptions {
  pool: ChannelPool;
  /** PUBLIC keys (G…) of every channel account. Derived from the keypairs at
   *  the call site — never secrets, which this module must never see, and never
   *  read out of the pool, whose address sets are deliberately private. */
  addresses: readonly string[];
  /** Injected so the monitor is testable without a network. Production passes
   *  the same Horizon-backed reader the sponsor guard uses. */
  fetchBalanceStroops: (address: string) => Promise<number>;
  /** Below this, an account is pulled from rotation. */
  floorStroops: number;
  intervalMs: number;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

/**
 * `GABC…WXYZ` — enough to identify one of 50 accounts in a log line without
 * writing a full address into log storage. These are public keys, so this is
 * hygiene rather than secrecy; the monitor is never given a secret key at all,
 * so there is nothing here that COULD leak one.
 */
export function truncateAddress(address: string): string {
  if (address.length <= 8) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function toXlm(stroops: number): string {
  return (stroops / STROOPS_PER_XLM).toFixed(4);
}

export class ChannelMonitor {
  private readonly opts: Required<Pick<ChannelMonitorOptions, "logger">> &
    Omit<ChannelMonitorOptions, "logger">;
  /** Per-account consecutive failure counts. Reset to 0 by any success. */
  private readonly failures = new Map<string, number>();
  /** Last successfully read balance, for observability only — never a decision
   *  input, so a stale value can never gate a disable/enable. */
  private readonly lastBalance = new Map<string, number>();
  /** Mirrors what THIS monitor has disabled. The pool's own `disabled` set is
   *  private and `status()` returns counts only, so tracking intent here is the
   *  only way to avoid calling disable()/enable() repeatedly on every tick —
   *  both are idempotent, but a log line per tick per account is not. */
  private readonly disabledByMonitor = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(opts: ChannelMonitorOptions) {
    this.opts = { ...opts, logger: opts.logger ?? console };
  }

  /** Consecutive failure count for one address. Test/observability seam. */
  failureCount(address: string): number {
    return this.failures.get(address) ?? 0;
  }

  /** Last successfully read balance in stroops, or undefined if never read. */
  lastKnownBalance(address: string): number | undefined {
    return this.lastBalance.get(address);
  }

  /**
   * One pass over every account, SEQUENTIALLY.
   *
   * Sequential is the point, not an accident: 50 accounts checked in parallel is
   * a 50-request burst at Horizon, whereas awaiting each in turn spreads them
   * across the interval. At the default 60s tick that is ~50 req/min against a
   * ~60 req/min per-IP budget, with the sponsor guard taking one more — which is
   * why lowering SPONSOR_BALANCE_INTERVAL_MS is the thing that would make this
   * the binding constraint. Do not go below ~10s — at 10s the monitor alone
   * generates 300 req/min, which exceeds Horizon's per-IP limit; checks then
   * fail, and five consecutive failures on one account disable an account that
   * is actually healthy. Never throws.
   */
  async checkAll(): Promise<void> {
    for (const address of this.opts.addresses) {
      if (this.stopped) return;
      await this.checkOne(address);
    }
  }

  private async checkOne(address: string): Promise<void> {
    let stroops: number;
    try {
      stroops = await this.opts.fetchBalanceStroops(address);
      // A non-finite reading is a malformed answer, not a balance. Treated as a
      // failed check rather than compared against the floor — NaN < floor is
      // false, so letting it through would silently mean "healthy".
      if (!Number.isFinite(stroops)) {
        this.recordFailure(address, "non-numeric balance");
        return;
      }
    } catch (err) {
      this.recordFailure(address, String(err));
      return;
    }

    // Success: the account answered, so any prior run of failures is over.
    this.failures.set(address, 0);
    this.lastBalance.set(address, stroops);

    const belowFloor = stroops < this.opts.floorStroops;
    const isDisabled = this.disabledByMonitor.has(address);

    if (belowFloor && !isDisabled) {
      this.opts.pool.disable(address);
      this.disabledByMonitor.add(address);
      this.opts.logger.warn(
        `[channel-monitor] DISABLED ${truncateAddress(address)} — ${toXlm(stroops)} XLM is below the ` +
          `${toXlm(this.opts.floorStroops)} XLM floor. It will not be handed to a new settlement until ` +
          `it is re-funded; any settlement already in flight on it finishes normally.`,
      );
      return;
    }

    if (!belowFloor && isDisabled) {
      this.opts.pool.enable(address);
      this.disabledByMonitor.delete(address);
      this.opts.logger.info(
        `[channel-monitor] re-enabled ${truncateAddress(address)} — ${toXlm(stroops)} XLM is back above ` +
          `the ${toXlm(this.opts.floorStroops)} XLM floor.`,
      );
    }
    // Otherwise: state already matches the balance. Say nothing — a healthy pool
    // logging 50 lines a minute is a pool nobody reads the logs of.
  }

  private recordFailure(address: string, detail: string): void {
    const count = this.failureCount(address) + 1;
    this.failures.set(address, count);

    if (count >= CONSECUTIVE_FAILURE_LIMIT) {
      // Already disabled by an earlier tick: keep counting, stay quiet. The
      // account is out of rotation, which is the outcome that matters.
      if (this.disabledByMonitor.has(address)) return;
      this.opts.pool.disable(address);
      this.disabledByMonitor.add(address);
      this.opts.logger.error(
        `[channel-monitor] DISABLED ${truncateAddress(address)} after ${count} consecutive failed balance ` +
          `checks — its balance is unknown, so it is withdrawn rather than handed out blind. ` +
          `Last error: ${detail}`,
      );
      return;
    }

    this.opts.logger.warn(
      `[channel-monitor] balance check failed for ${truncateAddress(address)} ` +
        `(${count}/${CONSECUTIVE_FAILURE_LIMIT}) — leaving it in its current state. ${detail}`,
    );
  }

  /** First pass fires immediately and unawaited, so boot is never blocked —
   *  same contract as BalanceGuard.start(). The interval is unref'd so it can
   *  never hold the process alive. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/** Factory, mirroring how BalanceGuard is constructed at its call site. */
export function createChannelMonitor(opts: ChannelMonitorOptions): ChannelMonitor {
  return new ChannelMonitor(opts);
}
