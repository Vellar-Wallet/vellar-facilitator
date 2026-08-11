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
    const result = await original.call(this, tx);
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
