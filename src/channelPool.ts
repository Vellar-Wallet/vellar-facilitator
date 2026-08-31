// Channel-account pool — gives concurrent ExactStellarScheme settlements
// independent sequence-number lanes instead of racing on one signer.
// Design: docs/channel-pool-design.md. Locked decisions that shape this file:
//   - Pool exhaustion is reject-fast (PoolExhaustedError, retryable: true),
//     never a queue or a wait — see docs/channel-pool-design.md §4.
//   - The sponsor account is never a member of this pool (§5) — this module
//     only ever holds channel-account addresses, nothing else.
//   - Sized for N=50, true simultaneity (§2) — this class itself is
//     size-agnostic; the caller decides N by how many addresses it
//     constructs the pool with.
//
// THREADING, the correctness-critical detail (§3 of the design): acquire()
// is a synchronous function that RETURNS the acquired address directly to
// its caller. That return value — an ordinary local variable at each call
// site — is the entire threading mechanism. There is no shared "last
// acquired" slot anywhere in this module, because there is nothing to read
// back out: JavaScript's single-threaded execution means the body of one
// acquire() call (pop from available, mark in_use, return) runs to
// completion before any other call to acquire() begins, even when 50
// separate async callers are all "racing" to call it at once — there is no
// interleaving possible WITHIN one synchronous call. A module-level "last
// acquired address" variable was explicitly rejected: it would race exactly
// like the sequence-number contention this pool exists to fix, since two
// overlapping callers could each read the OTHER call's write before using
// it. Returning the value directly needs no such slot to exist at all.

export interface PoolExhaustedError extends Error {
  readonly code: "pool_exhausted";
  readonly retryable: true;
}

function makePoolExhaustedError(): PoolExhaustedError {
  const err = new Error(
    "channel-account pool exhausted: no available address to acquire",
  ) as Error & { code?: string; retryable?: boolean };
  err.code = "pool_exhausted";
  err.retryable = true;
  return err as PoolExhaustedError;
}

/** True iff `err` is the specific error acquire() throws on exhaustion —
 *  the one place callers should check `code`/`retryable` rather than
 *  re-deriving them from a plain Error's shape. */
export function isPoolExhaustedError(err: unknown): err is PoolExhaustedError {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === "pool_exhausted" &&
    (err as { retryable?: unknown }).retryable === true
  );
}

export interface ChannelPoolStatus {
  available: number;
  inUse: number;
  disabled: number;
}

/**
 * A fixed set of channel-account addresses, each in exactly one of three
 * states at any time: available, in_use, or disabled (see
 * docs/channel-pool-design.md §3/§5). Construct once with the full set of
 * addresses the pool will ever manage — there is no add/remove-account
 * operation, only state transitions on addresses given at construction.
 */
export class ChannelPool {
  private readonly available: Set<string>;
  private readonly inUse: Set<string>;
  private readonly disabled: Set<string>;

  constructor(addresses: readonly string[]) {
    this.available = new Set(addresses);
    this.inUse = new Set();
    this.disabled = new Set();
  }

  /**
   * Acquire one available address. Synchronous, non-blocking: on an empty
   * available set this throws immediately (see makePoolExhaustedError)
   * rather than waiting for a release — reject-fast is the locked design
   * decision (§4), not an implementation shortcut.
   *
   * Returns the address directly — see this file's own header comment for
   * why that return value alone is the whole threading mechanism.
   */
  acquire(): string {
    const iterResult = this.available.values().next();
    if (iterResult.done) {
      throw makePoolExhaustedError();
    }
    const address = iterResult.value;
    this.available.delete(address);
    this.inUse.add(address);
    return address;
  }

  /**
   * Return an address to available. Idempotent: calling this on an address
   * that is already available (never acquired, or already released) is a
   * no-op, not an error — a settlement path that releases in a `finally`
   * after a verify-stage failure that never actually acquired anything
   * (or a caller that double-releases defensively) must never crash the
   * release path itself.
   *
   * SECURITY (found in review): also a no-op — not a silent pool-size
   * corruption — when `address` was never a member of this pool at all.
   * Without this guard, `this.available.add(address)` unconditionally
   * admitted ANY string, growing the pool past its configured, locked
   * size of exactly 50 (docs/channel-pool-design.md §2) and making that
   * arbitrary value acquirable by a future settle() call. Reachable by an
   * ordinary bug (a caller passing the wrong value), not an adversarial
   * input — checked here rather than trusted at every call site.
   *
   * Releasing a DISABLED address is also a no-op with respect to its
   * disabled state — release does not implicitly re-enable a
   * low-balance account. Use enable() for that, deliberately, once the
   * balance is confirmed healthy again (§5). Note this is still a KNOWN
   * member, just not one that should become available again here — the
   * guard above and this check are answering two different questions
   * ("is this a real pool address at all" vs. "is it currently disabled")
   * and both must run.
   */
  release(address: string): void {
    if (!this.available.has(address) && !this.inUse.has(address) && !this.disabled.has(address)) {
      return; // not a member of this pool — ignore silently
    }
    if (this.disabled.has(address)) return;
    this.inUse.delete(address);
    this.available.add(address);
  }

  /**
   * Move an address to disabled — acquire() will never return it while
   * disabled, regardless of whether it was available or in_use at the
   * moment disable() was called (a low-balance signal can arrive while a
   * settlement is still in flight on that very address; the in-flight
   * settlement is left to finish, but no NEW settlement will be handed
   * this address until it is explicitly re-enabled).
   */
  disable(address: string): void {
    this.available.delete(address);
    this.inUse.delete(address);
    this.disabled.add(address);
  }

  /**
   * Move a disabled address back to available. The only way an address
   * leaves the disabled state — release() deliberately does not do this
   * (see release's own comment).
   */
  enable(address: string): void {
    if (!this.disabled.has(address)) return;
    this.disabled.delete(address);
    this.available.add(address);
  }

  /** Counts only — for the telemetry/monitoring surface
   *  (docs/channel-pool-design.md §5), never exposes which specific
   *  addresses are in which state. */
  status(): ChannelPoolStatus {
    return {
      available: this.available.size,
      inUse: this.inUse.size,
      disabled: this.disabled.size,
    };
  }
}
