# Diagnosis — the 1-in-3 settle failures

**2026-08-11. Diagnosis only; nothing about the failure path is changed.**

Roughly one settle in three failed with
`settle_exact_stellar_transaction_submission_failed` and an empty `transaction`,
at a stable rate across two sessions (3/11, 3/9). We had a name and no cause,
because the cause was being discarded.

---

## Why the cause was invisible

`@x402/stellar` throws away the RPC's answer:

```js
const sendResult = await server.sendTransaction(txToSubmit);
if (sendResult.status !== "PENDING") {
  return { success: false, transaction: "",
           errorReason: "settle_exact_stellar_transaction_submission_failed", payer };
}
```

`sendResult` carries `status`, `errorResult` (a `TransactionResult` XDR naming
the exact ledger-level failure), `diagnosticEvents` and `latestLedger`. **All of
it is dropped and replaced with one constant string.** Every distinct cause
arrives at the operator looking identical.

So the fix was not to guess harder. `scripts/rpc-tap.mjs` forwards Soroban
JSON-RPC and logs the `sendTransaction` response verbatim, decoding `errorResult`
XDR. Nothing in production changed; the tap sits between a **local** facilitator
and the same public RPC.

*(It serves TLS with a throwaway self-signed cert, because `@stellar/stellar-sdk`
refuses an `http://` RPC endpoint outright. The cert was deleted after the run.)*

## What the network actually said

17 submissions, 10 failures:

| Status | Count | What it is |
| --- | --- | --- |
| **`TRY_AGAIN_LATER`** | **9** | RPC-level. No `errorResult`, no ledger entry, nothing spent |
| `ERROR` → `txBadSeq` | 1 | Sequence contention on a shared source account |

## What this rules in and out

**RULED OUT — the facilitator, and the scheme library's own logic.** The
transaction never enters a ledger. Neither our code nor the library's signing,
fee-bumping or policy handling is involved in the outcome; both merely relay a
refusal from the RPC.

**RULED OUT — sponsor sequence contention.** The sponsor signs the fee bump, not
the inner transaction's sequence. And `txBadSeq` names the *inner* source.

**RULED OUT — shared-source contention as the explanation.** This was the leading
hypothesis and it is wrong. It explains exactly one of ten failures. The decisive
test: five settles, each from **its own freshly funded, never-used account** — one
still failed with `TRY_AGAIN_LATER`. A virgin account's first-ever transaction
cannot have a sequence conflict.

**RULED IN — the RPC declining to forward the transaction**, for reasons it does
not state. `TRY_AGAIN_LATER` is 9 of 10 failures, carries no `errorResult`, and
happens to transactions that are individually valid.

**NOT ESTABLISHED — whether retrying is the sanctioned response.** The name
implies it and the absence of an `errorResult` supports it, but
[the RPC reference](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/sendTransaction)
lists `TRY_AGAIN_LATER` among the allowed values **without defining it**, and no
authoritative source was found describing when it occurs or what a client should
do. Recorded as unconfirmed rather than assumed — this is the same discipline
that retracted D-4.

## The finding underneath

**A status literally named "try again later" is being converted into a terminal
failure.** Whatever its precise trigger, the facilitator gives up on it, the
buyer sees a settlement that failed, and nothing conveys that a second attempt
would probably have worked.

That is a defect **regardless** of what causes the status — and it is the
library's behaviour, not ours.

## Options, none taken

| | Change | Cost | Risk |
| --- | --- | --- | --- |
| **A** | Retry `sendTransaction` on `TRY_AGAIN_LATER` with backoff, inside our settle path | Needs the status, which the library hides — so it means re-implementing submission or patching upstream | Retrying a submission is not free: if the first attempt did land, a retry risks a duplicate. `DUPLICATE` is a distinct status, which suggests the RPC handles it, but that is unverified |
| **B** | Surface the real status to the caller, do not retry | Small. Requires the same access to `sendResult` | None. Turns an opaque failure into an actionable one, and clients can retry on their own terms |
| **C** | Document "retry on this error" for buyers | Done — `using-it.md` | Leaves every client to rediscover it |
| **D** | Report upstream | Free | Not in our control |

**Recommended: B, then A only if the duplicate question is settled.** B is the
honest version of the problem — the information exists and is thrown away — and
it does not require deciding whether a retry is safe. C is already shipped, so
buyers are not blocked either way.

## Rate

The local reproduction failed 10 of 17 (59%), against ~33% in production. Both
runs were back-to-back settles, so the local rate being higher is consistent with
load-related refusal, but this is one afternoon on one RPC and the numbers are
not a measurement of anything stable. **Do not quote 59% as a property of the
network.**
