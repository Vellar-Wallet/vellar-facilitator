# Upstream issue — DRAFT, not filed

**Target:** `x402-foundation/x402` (the repo `@x402/stellar` points at).
**Confirmed against:** `@x402/stellar@2.21.0` — the latest release, not just our
pinned 2.20.0. Verified by unpacking the published tarball; the discard is
identical in both.

**Not opened.** It goes out under the repo owner's name, so it is here to be read
first.

---

## Title

`exact/stellar`: `settle` discards the RPC's `sendTransaction` response, making
retryable and terminal submission failures indistinguishable

## Body

### Summary

When submission fails, `ExactStellarScheme.settle` replaces the entire Soroban
RPC response with a single constant `errorReason`. The response distinguishes
failures that a caller should retry from failures that a caller must not retry,
and that distinction is lost before it reaches anyone.

### Where

`src/exact/facilitator/index.ts` (in the published build,
`dist/cjs/exact/facilitator/index.js:346-355` of 2.21.0):

```js
const sendResult = await server.sendTransaction(txToSubmit);
if (sendResult.status !== "PENDING") {
  return {
    success: false,
    network: payload.accepted.network,
    transaction: "",
    errorReason: "settle_exact_stellar_transaction_submission_failed",
    payer
  };
}
```

`sendResult` carries `status`, `errorResult` (a `TransactionResult` XDR naming
the ledger-level failure), `diagnosticEvents` and `latestLedger`. None of it
survives.

### Why it matters — two causes, opposite correct responses

Measured on testnet against `https://soroban-testnet.stellar.org`, by proxying
JSON-RPC and logging the response the library then discarded. **17 submissions,
10 failures:**

| `status` | Count | Correct caller response |
| --- | --- | --- |
| `TRY_AGAIN_LATER` | **9** | **Retry.** No `errorResult`, nothing reached a ledger, nothing was spent |
| `ERROR` → `txBadSeq` | 1 | **Do not retry.** The payload is stale; resubmitting it can never succeed |

Both arrive at the caller as the same string, so a facilitator operator cannot
tell a transient refusal from a dead payload, and neither can the merchant or
buyer downstream. In our deployment this presents as roughly one settle in three
failing for no visible reason, at a stable rate across sessions.

The `TRY_AGAIN_LATER` case is the sharp one: the status is *literally named*
"try again later", and the library converts it into a terminal failure.

Sample of the captured responses:

```
[tap] SUBMISSION NOT PENDING   status TRY_AGAIN_LATER   latestLedger 4085901
[tap] SUBMISSION NOT PENDING   status ERROR             errorResult {"code":"txBadSeq","feeCharged":"32755"}
[tap] SUBMISSION NOT PENDING   status TRY_AGAIN_LATER   latestLedger 4085938
```

The last of those is from a **freshly funded, never-used source account on its
first ever transaction**, which rules out sequence contention as an explanation
for the `TRY_AGAIN_LATER` cases.

### Suggested fix

Additive, non-breaking — pass through what the RPC already returned:

```js
if (sendResult.status !== "PENDING") {
  return {
    success: false,
    network: payload.accepted.network,
    transaction: "",
    errorReason: "settle_exact_stellar_transaction_submission_failed",
    payer,
    // NEW: preserve what the RPC actually said.
    rpcStatus: sendResult.status,
    ...(sendResult.errorResult ? { rpcErrorResult: sendResult.errorResult } : {}),
  };
}
```

Existing consumers are unaffected — `errorReason` keeps its current value and
meaning. A distinct `errorReason` per status would also work and would be more
expressive, but it is a behaviour change for anyone matching on the current
string, so the additive form seems the safer proposal.

### The same pattern, one call later — flagging, not claiming

We went looking for a second instance after finding the first, and there is one
immediately below. We have **not** measured this path; the code is quoted rather
than characterised, and the consequence below follows from reading it.

```js
async pollForTransaction(server, txHash, maxPollAttempts = 15, delayMs = 1e3) {
  for (let i = 0; i < maxPollAttempts; i++) {
    try {
      const txResult = await server.getTransaction(txHash);
      if (txResult.status === "SUCCESS") return { success: true };
      else if (txResult.status === "FAILED") return { success: false };
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } catch (error) { /* … */ }
  }
  return { success: false };          // poll exhausted
}
```

It returns a bare boolean, so `txResult.resultXdr` — the on-chain reason a
transaction reverted — is dropped. The sharper part is that **two different
outcomes both become `{ success: false }`**, and `settle` renders both as
`settle_exact_stellar_transaction_failed`:

1. **`status === "FAILED"`** — included in a ledger and reverted. Terminal, and
   the reason is in `resultXdr`.
2. **Poll exhaustion** — polling stopped after `maxPollAttempts`. The transaction
   may still be pending and may still succeed. That is not a failure, it is an
   unknown.

Those want opposite handling, and unlike the submission case this one has a
money-safety edge: `transaction` is populated with the hash, so a caller that
treats a timeout as terminal and re-pays may pay twice if the original lands.
Distinguishing them needs only the status, or a distinct `errorReason` for
exhaustion.

We raise it because it is the same habit rather than the same line —
information the RPC supplied, discarded before a caller can act on it. **We have
not observed this happening and are not claiming a rate for it.**

### We are happy to send the PR

The submission-path change is roughly four lines, additive, with no behaviour
change for existing consumers — `errorReason` keeps its current value. Say the
word and we will open it against `main`, with a test if you want one. We are
equally happy for you to take the suggestion and write it yourselves; the goal is
the information reaching callers, not the authorship.

### Environment

- `@x402/stellar@2.21.0` (also present in 2.20.0)
- Node 22 / 25, `@stellar/stellar-sdk` 14.x
- `stellar:testnet` via `https://soroban-testnet.stellar.org`

### Workaround, for anyone finding this issue first

We wrap `rpc.Server.prototype.sendTransaction` and record non-`PENDING` statuses
in `AsyncLocalStorage` scoped to the request, then attach the real status to our
own error body. It works, and it is a monkey-patch on a dependency's prototype —
which is why we would rather the information simply be returned.

---

## Notes for the reviewer (not part of the issue)

- **Tone is deliberate:** it reports a defect with evidence and a patch-shaped
  suggestion, and does not editorialise about the library. The one line that
  comes closest — *"the status is literally named 'try again later'"* — is
  kept because it is the crux, not a complaint.
- **What is claimed vs shown.** Shown: the code discards the response; the two
  statuses occur; a fresh account still got `TRY_AGAIN_LATER`. **Not claimed:**
  what causes `TRY_AGAIN_LATER`, or that retrying is definitively correct — the
  RPC reference lists the status without defining it. The issue asks for the
  information to be surfaced, which is true regardless of what the status means.
- **Rate framing.** "Roughly one in three" is described as our deployment's
  experience, not as a property of the network. The local reproduction was 10/17,
  and quoting either as a measurement of the RPC would overreach.
- **The PR is offered in the body**, not held back for them to ask, and worded to
  be indifferent to authorship so it does not read as a claim on the fix.
- **The second instance is framed as a habit, not a second bug report.** It makes
  the issue about a pattern — information the RPC supplied, discarded before a
  caller can act — which is more useful to a maintainer than one line number. The
  code is quoted verbatim so they can judge it themselves.
- **The strongest point in the report is the one we have measured least.** The
  poll-exhaustion double-pay risk is derived from reading the code, not observed.
  That asymmetry is stated in the issue rather than smoothed over.
