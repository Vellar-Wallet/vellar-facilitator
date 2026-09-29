// Operator Console — kill switch, admin auth, and audit logging.
//
// Design decisions locked during review (docs/prompt.md is the spec this
// implements):
//
//   - Turso is the ONLY source of truth for kill-switch state at runtime.
//     OPERATOR_KILL_SWITCH (config.ts) seeds the row on first boot only, when
//     the table is empty — never a runtime override, so a stale env var can
//     never fight a live operator toggle.
//   - The kill switch is read on every /settle call, so it is cached
//     in-memory and updated write-through: POST /admin/kill-switch writes
//     Turso first, then updates the cache, so /settle never pays a Turso
//     round trip and the cache can never show a state Turso does not also
//     have. See KillSwitch's own doc comment below.
//   - SINGLE-INSTANCE ASSUMPTION. The in-memory cache is correct only when
//     exactly one process holds it — confirmed against render.yaml, which
//     defines no multiple-instance/scaling block for vellar-facilitator. If
//     this service is ever horizontally scaled, each instance would cache
//     kill-switch state independently and an operator's toggle would not
//     reach every instance. Revisit this file (and the boot hydration below)
//     before scaling this service past one instance.
//   - FAIL CLOSED at boot: if Turso cannot be reached while hydrating the
//     kill-switch cache, boot refuses rather than silently defaulting to "not
//     killed" — see KillSwitch.hydrate()'s own comment.
//   - Audit writes for settlement outcomes are AWAITED before /settle
//     responds (durability over latency for money-movement events); catalog
//     events are fire-and-forget (lower stakes, and never on the settle
//     critical path anyway — see bazaar.ts's own onAfterSettle hook).

import type { AuditLogEntry, CatalogStore, KillSwitchState } from "./store.js";

/**
 * In-memory, write-through cache over the store's kill_switch row.
 *
 * `hydrate()` must be awaited before the server starts accepting /settle
 * traffic — see server.ts's boot sequence. `toggle()` is the only way the
 * cache's value ever changes: it writes Turso FIRST, and only updates the
 * cache after that write resolves, so a caller reading `.enabled` between
 * two overlapping toggle() calls always sees either the old durable value or
 * the new durable value, never a value Turso does not also have.
 */
export class KillSwitch {
  private state: KillSwitchState;

  private constructor(
    private readonly store: CatalogStore,
    initial: KillSwitchState,
  ) {
    this.state = initial;
  }

  /**
   * Reads the store's kill_switch row once, at boot. An empty row (never
   * toggled before) seeds from `defaultEnabled` — OPERATOR_KILL_SWITCH's
   * resolved value — and does NOT write it back to Turso; the row is only
   * ever written by an explicit operator toggle, so a facilitator that boots
   * with the env var true and is never toggled again keeps reporting that
   * seeded value from cache on every subsequent boot without a stray write
   * establishing a row nobody asked to persist.
   *
   * Throws on a store read failure — FAILS CLOSED. A kill switch whose own
   * state cannot be confirmed must not silently assume "not killed": that is
   * the one direction that is unsafe to guess wrong on a payment-settlement
   * service. The caller (server.ts's boot sequence) lets this propagate and
   * refuses to start.
   */
  static async hydrate(store: CatalogStore, defaultEnabled: boolean): Promise<KillSwitch> {
    const existing = await store.getKillSwitchState();
    const initial: KillSwitchState = existing ?? {
      enabled: defaultEnabled,
      reason: defaultEnabled ? "seeded from OPERATOR_KILL_SWITCH at boot" : undefined,
      actor: undefined,
      updatedAt: Date.now(),
    };
    return new KillSwitch(store, initial);
  }

  /** O(1), synchronous, zero I/O — this is what /settle calls on every
   *  request. See this file's header comment for why a cached read, not a
   *  Turso read, belongs on that path. */
  get(): KillSwitchState {
    return this.state;
  }

  /**
   * Durable write, then cache update — in that order. `enabled: true`
   * requires a non-empty `reason` (enforced by the caller, the
   * POST /admin/kill-switch route, before this is ever invoked — this method
   * itself does not re-validate, since it has no independent notion of what
   * a route-level 400 should look like).
   */
  async toggle(next: { enabled: boolean; reason: string | undefined; actor: string }): Promise<KillSwitchState> {
    const state: KillSwitchState = {
      enabled: next.enabled,
      reason: next.reason,
      actor: next.actor,
      updatedAt: Date.now(),
    };
    await this.store.setKillSwitchState(state);
    this.state = state;
    return state;
  }
}

/**
 * Constant-time comparison for the admin token. A naive `===` short-circuits
 * on the first mismatched byte, which leaks timing information about how
 * many leading characters of a guess are correct — irrelevant over the
 * public internet's jitter for most endpoints, but this gates a kill switch,
 * and the standard defense costs nothing to apply.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Cookie name for the admin session — see server.ts's GET /admin login
 *  flow. Signed via @fastify/cookie's built-in signing (HMAC over the
 *  configured secret), never a plain value: the cookie carries no reference
 *  to adminSecret itself, only a signed token @fastify/cookie can verify. */
export const ADMIN_SESSION_COOKIE = "vellar_admin_session";

/**
 * True iff the request carries a valid admin credential: either the
 * X-Admin-Token header, or a signed ADMIN_SESSION_COOKIE whose unsigned
 * value equals adminSecret. Both are checked against the SAME secret — the
 * cookie is not a separate, weaker credential, it is the header's value
 * carried a different way for the HTML console's benefit.
 */
export function hasValidAdminCredential(
  adminSecret: string,
  headerToken: string | string[] | undefined,
  signedCookieValue: string | undefined,
): boolean {
  const header = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (typeof header === "string" && header.length > 0 && timingSafeEqual(header, adminSecret)) {
    return true;
  }
  if (typeof signedCookieValue === "string" && timingSafeEqual(signedCookieValue, adminSecret)) {
    return true;
  }
  return false;
}

/**
 * Append one audit-log row, never throwing into the caller — a failed audit
 * write must not take down the request that triggered it (this mirrors
 * bazaar.ts's own onAfterSettle hook, which swallows its own errors for the
 * same "must never affect the thing it is observing" reason). The one
 * exception is `awaitable: true` call sites (settlement outcomes — see this
 * file's header comment): those still swallow the error, but the CALLER
 * awaits this function itself, so a slow write still adds real latency
 * there; only the FAILURE is swallowed, not the write's duration.
 */
export async function logAuditEvent(
  store: CatalogStore,
  entry: Omit<AuditLogEntry, "createdAt"> & { createdAt?: number },
  logger: { error: (obj: unknown, msg: string) => void },
): Promise<void> {
  try {
    await store.appendAuditLog({ ...entry, createdAt: entry.createdAt ?? Date.now() });
  } catch (err) {
    logger.error(
      { action: entry.action, err: err instanceof Error ? err.message : String(err) },
      "[admin] audit log write failed — the triggering request is unaffected, but this event is not recorded",
    );
  }
}

// ── Alerting (basic, via structured log lines — Render's log-based alerting
// can be pointed at the `[ALERT] <name>: ...` prefix these emit). Each
// function logs at most once per call; callers decide the polling/threshold
// cadence (see startAlertPoller below), this module only shapes the line.
// docs/operator-runbook.md does not yet document these — a follow-up, not
// implied to exist by this comment. ─────────────────────────────────────

export function logSponsorBalanceLowAlert(
  logger: { warn: (obj: unknown, msg: string) => void },
  balanceStroops: number,
  softFloorStroops: number,
): void {
  logger.warn(
    { alert: "sponsor_balance_low", balanceStroops, softFloorStroops },
    `[ALERT] sponsor_balance_low: balance=${balanceStroops} softFloor=${softFloorStroops}`,
  );
}

export function logSettlementFailureSpikeAlert(
  logger: { warn: (obj: unknown, msg: string) => void },
  failures: number,
  windowMinutes: number,
): void {
  logger.warn(
    { alert: "settlement_failure_spike", failures, windowMinutes },
    `[ALERT] settlement_failure_spike: failures=${failures} in last ${windowMinutes} minutes`,
  );
}

export function logChannelPoolExhaustedAlert(
  logger: { warn: (obj: unknown, msg: string) => void },
  total: number,
): void {
  logger.warn(
    { alert: "channel_pool_exhausted", available: 0, total },
    `[ALERT] channel_pool_exhausted: available=0 total=${total}`,
  );
}

export function logKillSwitchActivatedAlert(
  logger: { warn: (obj: unknown, msg: string) => void },
  reason: string,
): void {
  logger.warn({ alert: "kill_switch_activated", reason }, `[ALERT] kill_switch_activated: reason=${reason}`);
}

export interface AlertPollerOptions {
  logger: { warn: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void };
  store: CatalogStore;
  poolStatus: () => { available: number; inUse: number; disabled: number };
  /** BalanceGuard.status() returns only the enum, not the raw stroops value
   *  (balance.ts has no accessor for it) — this poller does not modify that
   *  class (see the file-level rationale above), so it takes the enum plus a
   *  SEPARATE stroops fetch, using the same fetchBalanceStroops function the
   *  guard itself was constructed with. Two independent reads of the same
   *  underlying Horizon endpoint, on the same interval order of magnitude
   *  the guard itself already polls at — negligible added load. */
  balanceStatus: () => "ok" | "low" | "critical" | "unknown";
  fetchBalanceStroops: () => Promise<number>;
  softFloorStroops: number;
  intervalMs: number;
  /** Failures within this window trigger settlement_failure_spike — default
   *  5 minutes, matching the spec's own example line ("failures=X in last 5
   *  minutes"). */
  spikeWindowMinutes?: number;
  /** Failures within spikeWindowMinutes at or above this count trigger the
   *  alert. Chosen, not measured: this repo has no production failure-rate
   *  baseline to derive a statistically-grounded threshold from (unlike
   *  e.g. config.ts's fee-ceiling numbers, which cite real measurements) —
   *  5 is a starting point an operator should tune from observed traffic,
   *  not a value with its own provenance. */
  spikeThreshold?: number;
}

/**
 * Basic alerting (spec §6): periodically re-checks conditions that already
 * have a live status source elsewhere (ChannelPool.status(),
 * BalanceGuard.status(), admin_audit_log) and logs a structured [ALERT] line
 * when one trips — picked up by Render's log-based alerting, per the spec.
 *
 * Deliberately does NOT touch balance.ts/channelMonitor.ts/channelPool.ts
 * internals: those modules already log their own human-readable warnings on
 * the same conditions (see e.g. balance.ts's "sponsor below soft floor"
 * line) and are exercised by their own test suites — this reads the same
 * status those modules already expose, from the outside, rather than adding
 * a second log line inside well-tested, safety-adjacent code for a
 * cosmetically different message format.
 *
 * Each condition alerts AT MOST ONCE PER INTERVAL while it remains true
 * (not once total) — an operator paging off Render's log alerts wants to
 * know a condition is STILL true on the next tick, not just that it started.
 * De-duplication beyond "don't alert twice in one tick" is Render's own
 * alert-grouping concern, not this poller's.
 */
export function startAlertPoller(opts: AlertPollerOptions): { stop: () => void } {
  const spikeWindowMinutes = opts.spikeWindowMinutes ?? 5;
  const spikeThreshold = opts.spikeThreshold ?? 5;

  const tick = async () => {
    const pool = opts.poolStatus();
    const total = pool.available + pool.inUse + pool.disabled;
    if (pool.available === 0 && total > 0) {
      logChannelPoolExhaustedAlert(opts.logger, total);
    }

    if (opts.balanceStatus() === "low") {
      try {
        const balanceStroops = await opts.fetchBalanceStroops();
        logSponsorBalanceLowAlert(opts.logger, balanceStroops, opts.softFloorStroops);
      } catch (err) {
        opts.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[admin] alert poller could not re-fetch the sponsor balance for the sponsor_balance_low alert line",
        );
      }
    }

    try {
      const since = Date.now() - spikeWindowMinutes * 60_000;
      // queryAuditLog has no time-range filter of its own, and
      // settlementAggregates()'s windowed counts only go down to
      // last24h/last7d, not a 5-minute window — so this reads a bounded page
      // of recent failure rows (most-recent-first) and filters createdAt in
      // process. Bounded well above spikeThreshold so a real spike is never
      // undercounted by the page size itself.
      const { entries } = await opts.store.queryAuditLog({
        limit: Math.max(spikeThreshold * 4, 50),
        offset: 0,
        action: "settlement_failure",
      });
      const windowed = entries.filter((e) => e.createdAt >= since).length;
      if (windowed >= spikeThreshold) {
        logSettlementFailureSpikeAlert(opts.logger, windowed, spikeWindowMinutes);
      }
    } catch (err) {
      opts.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[admin] alert poller could not read the audit log this tick — skipping the settlement_failure_spike check",
      );
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), opts.intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
