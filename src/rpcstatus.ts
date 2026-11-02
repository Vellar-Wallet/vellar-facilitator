// Recover the RPC's own answer when a submission fails.
//
// THE PROBLEM. `@x402/stellar` (checked in 2.20.0 and 2.21.0, the latest)
// discards the entire `sendTransaction` response and returns one constant:
//
//     const sendResult = await server.sendTransaction(txToSubmit);
//     if (sendResult.status !== "PENDING") {
//       return { success: false, transaction: "",
//                errorReason: "settle_exact_stellar_transaction_submission_failed", payer };
//     }
//
// Two causes needing OPPOSITE responses arrive identically. `TRY_AGAIN_LATER`
// means retry — nothing reached a ledger, nothing was spent. `ERROR` with
// `txBadSeq` means the payload is stale and retrying it is pointless. Measured
// 2026-08-11: 9 of 10 failures were the first, 1 was the second.
//
// WHAT THIS DOES. Wraps `rpc.Server.prototype.sendTransaction` — a plain
// prototype method on @stellar/stellar-sdk, which is OUR OWN direct dependency,
// not @x402/stellar's private surface — and records any non-PENDING result in
// AsyncLocalStorage scoped to the request that caused it. The settle route reads
// it and puts the real status in the error body.
//
// WHY A PATCH AT ALL. The scheme builds its RPC client per call
// (`getRpcClient()` -> `new rpc.Server(...)`), so there is no instance to hand
// it, no constructor hook, and no injection point. The prototype is the only
// place both call sites pass through.
//
// WHY THE SCOPING MATTERS MORE THAN THE CAPTURE. A module-level "last result"
// would leak across concurrent settles: request A's `TRY_AGAIN_LATER` would be
// reported on request B's failure. That is a WRONG diagnostic presented as a
// real one, which is worse than none — it would send a developer to retry a
// payload that is actually stale. AsyncLocalStorage gives each request its own
// slot. Asserted under concurrency in src/rpcstatus.test.ts.
//
// HOW THIS FAILS, and why that is survivable. If the SDK renames the method, or
// the scheme stops using `rpc.Server`, the capture silently stops and error
// bodies quietly lose their status. That is exactly the class of defect this
// codebase keeps finding, so it is guarded: rpcstatus.test.ts drives a
// non-PENDING response end to end and fails if the status does not arrive.
// A red test, not a silent gap.
//
// This is a WORKAROUND. The fix belongs upstream — see
// docs/upstream-issue-draft.md.

import { AsyncLocalStorage } from "node:async_hooks";
import { rpc } from "@stellar/stellar-sdk";

/** What the RPC actually said, when it was not PENDING. */
export interface CapturedRpcStatus {
  /** PENDING | DUPLICATE | TRY_AGAIN_LATER | ERROR */
  status: string;
  /** Decoded from errorResult XDR when the RPC supplied one. */
  errorCode?: string;
  latestLedger?: number;
}

const store = new AsyncLocalStorage<{ captured?: CapturedRpcStatus }>();

/**
 * Submission retry — TRY_AGAIN_LATER only, twice, six seconds apart.
 *
 * THE EVIDENCE (docs/diagnosis-settle-failures.md, measured): 9 of 10 observed
 * submission failures were TRY_AGAIN_LATER — the RPC declining to FORWARD the
 * transaction. No errorResult, no ledger entry, nothing spent; merchant
 * balances reconciled exactly to successes x price across every failed
 * attempt. The one terminal failure class (txBadSeq) arrives as ERROR and is
 * never retried here.
 *
 * WHY RESUBMITTING THE SAME ENVELOPE IS SAFE. `original.call(this, tx)` is
 * called again with the SAME `tx` object captured in this closure — never
 * rebuilt, never re-signed, same hash, same source account, same sequence
 * number. A network can only ever include one transaction per hash, so
 * resubmitting the identical envelope is safe BY CONSTRUCTION regardless of
 * whether the first attempt actually landed; it is "a rebuilt envelope with a
 * new sequence or a different channel-pool account" that would be unsafe,
 * and that case cannot occur here because nothing between attempts touches
 * `tx`.
 *
 * ITEM 4 (2026-11-02) — VERIFY, don't just argue. The point above was
 * previously an argument, not a check: TRY_AGAIN_LATER was read as proof of
 * "not forwarded", but the RPC reference itself leaves it undefined
 * (docs/diagnosis-settle-failures.md's own "NOT ESTABLISHED" line), and a
 * slow/lagging RPC node answering TRY_AGAIN_LATER for a transaction another
 * node already accepted was never ruled out. Before EACH resubmission this
 * now calls `getTransaction(hash)` first:
 *   - SUCCESS or FAILED -> it already landed. Stop retrying (resubmitting now
 *     would hit `txBadSeq`/a real duplicate for no reason) and return the
 *     REAL outcome instead of the stale TRY_AGAIN_LATER from the status that
 *     prompted this retry.
 *   - NOT_FOUND -> genuinely unconfirmed from this RPC's point of view; the
 *     identical-envelope argument above is what makes resubmitting it safe.
 *     (NOT_FOUND can also mean "past the RPC's retention window" — not
 *     reachable here, since this loop's entire lifetime is ~12s and nothing
 *     is that old yet. That case belongs to Item 3's reconciliation step,
 *     which runs much later and is where it is actually handled.)
 * A failure to even perform this check (getTransaction itself throwing) must
 * not block the retry it was meant to protect — see the try/catch around it
 * below. Losing the check degrades to the old argued-not-verified behaviour,
 * not to a stuck settlement.
 *
 * WHY SIX SECONDS. Adapted from Turnpike's measured lesson on the same RPC
 * fleet (Apache-2.0, credited): sub-ledger spacing re-samples the same
 * degraded state — their 750ms retries all landed inside one window and lost a
 * payment anyway. State changes at ledger close (~5s); 6s clears one.
 *
 * WHY TWO. Budget arithmetic: 2 x 6s + three submission round-trips ~ 15s
 * worst case — under the 30s facilitator-client timeout a seller holds open,
 * far inside signature expiry (current+12 ledgers ~ 60s in our examples;
 * upstream clients derive from maxTimeoutSeconds, typically 120s).
 *
 * WHY HERE. Upstream discards the sendTransaction response before any caller
 * can see it (#3125), so this wrapper is the only place that can distinguish
 * retryable from terminal. When upstream fixes #3125, this moves there.
 */
// Env-tunable ONLY for the probe's control arm (SUBMIT_RETRY_MAX=0 boots a
// facilitator with pre-retry behaviour, so the A/B runs both arms on the same
// crons and infrastructure). Production default unchanged; clamped 0-2 so the
// knob cannot widen the budget, only close it.
const SUBMIT_RETRY_MAX = Math.min(2, Math.max(0, Number(process.env.SUBMIT_RETRY_MAX ?? 2) || 0));
const SUBMIT_RETRY_DELAY_MS = 6_000;

let delayFn = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** TEST SEAM — replace the inter-attempt delay so retry tests run in ms. */
export function __setRpcRetryDelayForTest(fn?: (ms: number) => Promise<void>): void {
  delayFn = fn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
}

/**
 * Run `fn` with a fresh capture slot and return BOTH its value and whatever the
 * RPC reported inside it.
 *
 * Returning the status is not a convenience — it is what makes the API safe. An
 * earlier version exposed a separate `capturedRpcStatus()` reader, and the
 * obvious call site (right after `await withRpcStatusCapture(...)`) is OUTSIDE
 * the AsyncLocalStorage scope, so it silently returned undefined and the whole
 * mechanism did nothing in production. The guard test caught it. The shape below
 * makes that mistake unexpressible: you cannot read the status anywhere it is
 * not valid.
 */
export async function withRpcStatusCapture<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; rpcStatus: CapturedRpcStatus | undefined }> {
  return store.run({}, async () => {
    const value = await fn();
    return { value, rpcStatus: store.getStore()?.captured };
  });
}

/** The status recorded so far in the CURRENT scope. Valid only inside
 *  `withRpcStatusCapture`; undefined everywhere else, by design. */
export function capturedRpcStatus(): CapturedRpcStatus | undefined {
  return store.getStore()?.captured;
}

function decodeErrorCode(sendResult: Record<string, unknown>): string | undefined {
  // The SDK may hand back either a decoded object or raw XDR depending on
  // version; try the decoded shape first and fall back to the string.
  const er = sendResult.errorResult as { result?: () => { switch?: () => { name?: string } } } | undefined;
  try {
    const name = er?.result?.()?.switch?.()?.name;
    if (typeof name === "string") return name;
  } catch {
    /* not the decoded shape */
  }
  const raw = sendResult.errorResultXdr;
  if (typeof raw === "string") {
    try {
      const { xdr } = require("@stellar/stellar-sdk") as typeof import("@stellar/stellar-sdk");
      return xdr.TransactionResult.fromXDR(raw, "base64").result().switch().name;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * ITEM 4's actual check. Called from inside the retry loop, right before a
 * resubmission, with `this` the SAME `rpc.Server` instance the real
 * `sendTransaction` call is a method on — `getTransaction` is just another
 * method on it, no second client, no new endpoint.
 *
 * Returns a `sendTransaction`-SHAPED result when the transaction already
 * landed, so the caller can use it exactly like a real submission response.
 * Specifically: `{ status: "PENDING", hash }` when SUCCESS/FAILED, because
 * that is what makes @x402/stellar's OWN subsequent `pollForTransaction`
 * call (.../facilitator/index.js:356-358, which polls `sendResult.hash`
 * right back through `getTransaction`) immediately see the real landed
 * outcome and report it correctly — no need to re-derive or fake a success/
 * failure result ourselves, just hand the library the hash it already knows
 * how to resolve.
 *
 * Returns `undefined` for NOT_FOUND (genuinely unconfirmed — proceed with
 * the resubmission) and for any failure to even perform the check (a
 * diagnostic must never block the retry it exists to protect).
 */
async function checkAlreadyLanded(
  server: unknown,
  tx: unknown,
  log: (msg: string) => void,
): Promise<Record<string, unknown> | undefined> {
  try {
    const hashable = tx as { hash?: () => Buffer } | undefined;
    if (typeof hashable?.hash !== "function") return undefined;
    const hash = hashable.hash().toString("hex");
    const getTx = (server as { getTransaction?: (h: string) => Promise<{ status?: string }> })
      ?.getTransaction;
    if (typeof getTx !== "function") return undefined;
    const txResult = await getTx.call(server, hash);
    if (txResult?.status === "SUCCESS" || txResult?.status === "FAILED") {
      log(
        `[rpcstatus] TRY_AGAIN_LATER retry skipped: getTransaction(${hash.slice(0, 12)}…) already ` +
          `reports ${txResult.status} — a prior attempt landed despite the status. Handing the real ` +
          `hash back instead of resubmitting.`,
      );
      return { status: "PENDING", hash };
    }
    // NOT_FOUND (or anything else unrecognised): genuinely unconfirmed from
    // this RPC's point of view, or past its retention window — neither is
    // reachable meaningfully within this loop's ~12s lifetime (see this
    // function's own doc comment above the retry loop). Proceed with the
    // resubmission exactly as before Item 4 existed.
    return undefined;
  } catch (err) {
    log(
      `[rpcstatus] getTransaction check before retry failed (${String(
        (err as Error)?.message ?? err,
      )}) — proceeding with the resubmission as before Item 4 existed`,
    );
    return undefined;
  }
}

let installed = false;

/**
 * Install the patch. Idempotent, and LOUD — a monkey-patch nobody knows about is
 * the next person's mystery, so it announces itself with what it wraps and why.
 */
export function installRpcStatusCapture(log: (msg: string) => void = console.warn): void {
  if (installed) return;
  const proto = rpc.Server.prototype as unknown as {
    sendTransaction: (tx: unknown) => Promise<Record<string, unknown>>;
  };
  const original = proto.sendTransaction;
  if (typeof original !== "function") {
    log(
      "[rpcstatus] NOT INSTALLED: rpc.Server.prototype.sendTransaction is not a function. " +
        "Submission failures will carry no RPC status — see src/rpcstatus.ts.",
    );
    return;
  }
  proto.sendTransaction = async function patched(this: unknown, tx: unknown) {
    let result = await original.call(this, tx);

    for (let attempt = 1; attempt <= SUBMIT_RETRY_MAX && result?.status === "TRY_AGAIN_LATER"; attempt++) {
      log(
        `[rpcstatus] submission TRY_AGAIN_LATER (not forwarded, nothing spent) — ` +
          `retry ${attempt}/${SUBMIT_RETRY_MAX} after ${SUBMIT_RETRY_DELAY_MS}ms`,
      );
      await delayFn(SUBMIT_RETRY_DELAY_MS);

      // ITEM 4 — verify before resubmitting, not just argue. See this
      // function's own doc comment above for the full reasoning. A failure
      // to even perform this check must not block the retry it exists to
      // protect, so it degrades to the pre-Item-4 behaviour on any throw.
      const landed = await checkAlreadyLanded(this, tx, log);
      if (landed) {
        result = landed;
        break;
      }

      result = await original.call(this, tx);
      if (result?.status === "DUPLICATE") {
        // The retry safety argument's falsifier — see the block comment above.
        log(
          "[rpcstatus] RETRY RETURNED DUPLICATE: the TRY_AGAIN_LATER attempt WAS forwarded. " +
            "This contradicts docs/diagnosis-settle-failures.md and is the observation that " +
            "decides whether this retry is safe. Record it. Passing through unchanged.",
        );
        break;
      }
    }

    try {
      const status = result?.status;
      if (typeof status === "string" && status !== "PENDING") {
        const slot = store.getStore();
        if (slot) {
          const errorCode = decodeErrorCode(result);
          const latestLedger = result.latestLedger;
          const captured: CapturedRpcStatus = { status };
          if (errorCode !== undefined) captured.errorCode = errorCode;
          if (typeof latestLedger === "number") captured.latestLedger = latestLedger;
          slot.captured = captured;
        }
      }
    } catch {
      // Diagnostics must never break a settlement. A failure to record is a lost
      // diagnostic, not a lost payment.
    }
    return result;
  };
  installed = true;
  log(
    "[rpcstatus] MONKEY-PATCH INSTALLED: rpc.Server.prototype.sendTransaction is wrapped to record " +
      "non-PENDING statuses (TRY_AGAIN_LATER, ERROR, DUPLICATE) per request. Reason: @x402/stellar " +
      "replaces the RPC's response with a single constant, so retryable and terminal failures are " +
      "indistinguishable to callers. This is a WORKAROUND; the fix belongs upstream. Guarded by " +
      "src/rpcstatus.test.ts — if that test goes red, this capture has stopped working.",
  );
}

/** TEST ONLY — undo the patch so a test can assert the uninstalled behaviour. */
export function __resetRpcStatusCaptureForTest(originalRestore?: () => void): void {
  installed = false;
  originalRestore?.();
}
