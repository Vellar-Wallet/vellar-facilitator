// Ledger-skew retry — the one verify/settle rejection worth retrying.
//
// The public testnet RPC is load-balanced across nodes whose ledger heights
// diverge (Turnpike measured up to 3 ledgers on this fleet; @x402/stellar
// tolerates 2). When the client's "current ledger" read lands on a node ahead
// of the facilitator's, a perfectly valid payment is rejected as expiring "too
// far" in the future. Retrying re-samples the height — the check still runs in
// full, in the package, on every attempt; nothing is relaxed.
//
// Pattern adapted from Turnpike (Apache-2.0, credited), including their
// measured lesson: sub-ledger spacing is useless — their 750ms retries all
// landed inside one degraded window and still lost a payment. The delay must
// outlast a ledger close (~5s). This failure is LATENT here, confirmed present
// in our pinned upstream (facilitator/index.js:681) but never measured at our
// volume — the settle probe is the instrument that will.
//
// Budget note: this retry and the submission retry in rpcstatus.ts can stack
// on one settle. Worst case ~1 skew retry (6s) + 2 submission retries (12s)
// + round-trips stays under the 30s facilitator-client timeout, which is why
// SKEW_RETRY_MAX is 1 here rather than Turnpike's 2 — they have no submission
// retry to share the budget with.

export const LEDGER_SKEW_REASON = "invalid_exact_stellar_signature_expiration_too_far";
// Env-tunable only for the probe's control arm — see rpcstatus.ts. Clamped 0-1.
export const SKEW_RETRY_MAX = Math.min(1, Math.max(0, Number(process.env.SKEW_RETRY_MAX ?? 1) || 0));
export const SKEW_RETRY_DELAY_MS = 6_000;

let delayFn = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** TEST SEAM — replace the delay so tests run in milliseconds. */
export function __setSkewRetryDelayForTest(fn?: (ms: number) => Promise<void>): void {
  delayFn = fn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
}

/**
 * Run `op`, retrying only when `reasonOf(result)` is the ledger-skew code.
 * Returns the last result either way; a genuine rejection exits immediately.
 */
export async function withSkewRetry<T>(
  op: () => Promise<T>,
  reasonOf: (result: T) => string | undefined,
  log: (msg: string) => void,
): Promise<T> {
  let result = await op();
  for (let attempt = 1; attempt <= SKEW_RETRY_MAX && reasonOf(result) === LEDGER_SKEW_REASON; attempt++) {
    log(
      `[retry] ${LEDGER_SKEW_REASON} — RPC ledger-height skew, retry ${attempt}/${SKEW_RETRY_MAX} ` +
        `after ${SKEW_RETRY_DELAY_MS}ms (re-samples the ledger; relaxes nothing)`,
    );
    await delayFn(SKEW_RETRY_DELAY_MS);
    result = await op();
  }
  return result;
}
