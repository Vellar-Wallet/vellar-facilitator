# Diagnosis — settle failing on a poll/expiry race

**2026-09-17. Diagnosis only; nothing about the failure path is changed by
this document.** Reproduced on mainnet, against a freshly redeployed
`vellar-facilitator` instance correctly configured for `stellar:pubnet`.

---

## Symptom

Three consecutive real mainnet `pay` attempts via `vellar-cli`, all against
the same seller demo (`vellar-seller-demo.onrender.com/quote`, price
1,000,000 base units / 0.1 USDC), all `verify`-clean, all failed at `settle`:

```
Not unlocked: HTTP 402
{"error":"x402_failed","stage":"settle","detail":"settle_exact_stellar_transaction_failed","errorMessage":"settle_exact_stellar_transaction_failed"}
```

One attempt ran **151.06 seconds** (`vellar_settle_duration_seconds_sum`,
`_count 1`, facilitator `/metrics`) before failing. No transaction hash was
ever returned to the client.

## What was ruled out first

- **Not a network-config mismatch.** The facilitator was independently
  confirmed reconfigured for mainnet (`STELLAR_NETWORK=pubnet`,
  `STELLAR_RPC_URL` pointed at `mainnet.sorobanrpc.com`) before these three
  attempts; `verify` succeeded on all three, which requires a correct mainnet
  RPC target.
- **Not a client-side balance/trustline problem.** The payer account
  (`GCNTW6FN...`) held `1.1040928` USDC (classic trustline) and the SAC
  `balance()` simulation for the same account independently confirmed
  `1.1040928` — the SAC correctly reads through to the classic balance.
- **Not a double-spend or partial charge.** Checked via Horizon after each
  attempt: payer balance, sequence number, and transaction history were
  byte-for-byte unchanged across all three attempts (sequence stayed at
  `276871501913784321` throughout). The seller's `payTo` account
  (`GD6TC7QY...`) showed no payment matching our amount/timing either.
  **Zero on-chain trace across all three attempts.**
- **Not a version mismatch.** Facilitator (`@x402/stellar@2.20.0`) vs. CLI
  (`@x402/stellar@2.22.0`) is a real discrepancy but not the cause here —
  ruled out once the network-config fix alone made `verify` start passing
  without any dependency changes.
- **`vellar_settle_total{outcome="success"}` reading `1` after one attempt is
  misleading, not evidence of a real settlement.** No corresponding on-chain
  activity exists for that reading. Not fully reconciled by this document —
  flagged as a possible secondary symptom of the same overhead/timing issue,
  not independently explained.

## The overhead chain

Reading `node_modules/@x402/stellar`'s vendored source (facilitator side,
`exact/facilitator/index.mjs`, and client side, `chunk-SOJRTSRS.mjs`) traces
the full path from payload construction to poll timeout:

1. **Client builds the transaction** (`ExactStellarScheme.createPaymentPayload`,
   `chunk-SOJRTSRS.mjs:44-83`). Computes:
   ```js
   const latestLedger = await rpcServer.getLatestLedger();
   const currentLedger = latestLedger.sequence;
   const estimatedLedgerSeconds = await getEstimatedLedgerCloseTimeSeconds(network);
   const maxLedger = currentLedger + Math.ceil(maxTimeoutSeconds / estimatedLedgerSeconds);
   // ...
   await tx.signAuthEntries({ address: sourcePublicKey, signAuthEntry: ..., expiration: maxLedger });
   ```
   **The auth-entry expiration clock starts here**, sized from
   `maxTimeoutSeconds` (a field the *seller* advertises in the 402 challenge —
   not a CLI flag, not client-overridable; confirmed by reading
   `packages/cli/src/commands/pay.ts`, whose only call is
   `client.createPaymentPayload(required)` with no options argument, and by
   reading `chunk-SOJRTSRS.mjs` itself, which accepts no expiration override
   parameter).
2. **Client → seller → facilitator `/verify` HTTP round-trip.** A full
   HTTP request, its own RPC simulation server-side.
3. **Facilitator's `/settle` handler calls `facilitator.settle(...)`,
   which itself starts with a *second, independent* re-verification** —
   confirmed by reading `exact/facilitator/index.mjs:117-122`:
   ```js
   async settle(payload, requirements) {
     const server = getRpcClient(requirements.network, this.rpcConfig);
     // ...
     const { response: verifyResult, simResponse } = await this._verify(payload, requirements);
   ```
   This is a full second `simulateTransaction` RPC call, distinct from
   step 2's `/verify` HTTP call.
4. **Rebuild, sign, fee-bump, sign again** (`index.mjs:155-209`) — the
   facilitator rebuilds the transaction against a channel account, signs it,
   wraps it in a fee-bump transaction (sponsor-signed), and signs that too.
5. **`sendTransaction`, with up to 2 retries at 6s apart** on
   `TRY_AGAIN_LATER` (`src/rpcstatus.ts`'s monkey-patch, `SUBMIT_RETRY_MAX=2`,
   `SUBMIT_RETRY_DELAY_MS=6000` — worst case adds 12s here alone).
6. **Only now does polling start** (`index.mjs:224-225`):
   ```js
   const maxPollAttempts = requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
   const confirmResult = await this.pollForTransaction(server, txHash, maxPollAttempts);
   ```

**Steps 2–5 are fixed, roughly constant overhead — largely independent of
`maxTimeoutSeconds` — that occurs entirely *after* the auth-expiration clock
in step 1 has already started, and entirely *before* the poll budget in
step 6 begins consuming its own window.**

## The units bug

`pollForTransaction`'s real signature (`index.mjs:407`):
```js
async pollForTransaction(server, txHash, maxPollAttempts = 15, delayMs = 1e3) {
```
`delayMs` defaults to `1000`. The call site (`index.mjs:224-225`) passes only
three arguments:
```js
const maxPollAttempts = requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
const confirmResult = await this.pollForTransaction(server, txHash, maxPollAttempts);
```
**`requirements.maxTimeoutSeconds` — a value in seconds — is passed directly
as `maxPollAttempts`, an attempt *count*.** `delayMs` is never overridden, so
it silently keeps its `1000`ms default. The two units only coincide
numerically (attempts × 1000ms ≈ seconds) because `delayMs`'s default happens
to be exactly 1000 — an accident of the default, not a deliberate unit
conversion. At `maxTimeoutSeconds: 120`, this produces a poll loop of up to
120 attempts × 1000ms ≈ **120 seconds of polling**, which is a plausible
looking but load-bearing coincidence, not a designed behavior.

## The timing race

Putting the overhead chain and the units bug together:

- **Auth-entry expiration clock**: starts at step 1 (client build time),
  runs for `maxLedger` ledgers ≈ `maxTimeoutSeconds` seconds of real time
  (at Stellar's ~5s ledger close).
- **Poll budget**: starts at step 6, *after* steps 2–5's fixed overhead has
  already elapsed, and (per the units bug) also totals approximately
  `maxTimeoutSeconds` seconds.

**Both windows are sized to the same `maxTimeoutSeconds` value, but the poll
window starts later than the expiration window — by exactly however long
steps 2–5 take.** Our one measured full-duration attempt totaled 151.06
seconds against a `maxTimeoutSeconds: 120` budget — already 31 seconds past
the nominal window before the request even completed, consistent with the
poll loop running until genuine exhaustion, well after the auth entry could
plausibly still be valid. Steps 2–5's overhead (a second RPC simulation, two
signings, a fee-bump, submission, up to 12s of retry) is a very plausible
source of 15–30+ seconds of fixed cost eaten out of a shared, non-reset
budget.

This is consistent with all observed evidence: `verify` (a separate, single
HTTP call before `/settle` is ever invoked) consistently succeeds; `settle`
consistently fails with `settle_exact_stellar_transaction_failed` — the
generic code covering both a genuine on-chain `FAILED` and poll exhaustion,
per `docs/upstream-issue-draft.md`'s own flagged-but-unmeasured concern; and
no successful settlement has ever left an on-chain trace in this session,
consistent with the auth entry expiring before or during the facilitator's
attempt to include the transaction, rather than a transaction that reached a
ledger and reverted.

## Why lowering `maxTimeoutSeconds` makes this worse, not better

A shorter `maxTimeoutSeconds` (e.g. 30) shrinks *both* windows
proportionally — but steps 2–5's overhead is roughly fixed regardless of
`maxTimeoutSeconds`. At `120`, fixed overhead is a smaller fraction of the
shared budget; at `30`, the same fixed overhead could consume all or more of
it, leaving little or no real polling time before a now-*also*-shorter
auth-entry expiration. This was considered and rejected before any change
was made.

## Correct fix, and why it isn't available at the client layer today

The principled fix is either:
1. **Give the auth entry more headroom than the poll window needs**, so the
   expiration clock (step 1) has enough runway to survive steps 2–5's
   overhead plus a full poll window. Not achievable as a CLI flag or a
   per-call override today: `ExactStellarScheme.createPaymentPayload`
   (`chunk-SOJRTSRS.mjs`) derives `maxLedger` solely from
   `requirements.maxTimeoutSeconds` (a value read from the seller's own 402
   challenge, per the x402 spec) and `estimatedLedgerSeconds`; it accepts no
   options parameter for an independent expiration override, and
   `packages/cli/src/commands/pay.ts`'s only call site
   (`client.createPaymentPayload(required)`) passes none. Changing this
   would mean patching the vendored client library.
2. **Fix `pollForTransaction`'s call site** so `maxPollAttempts`/`delayMs`
   are derived correctly from `maxTimeoutSeconds` (e.g.
   `pollForTransaction(server, txHash, Math.ceil(maxTimeoutSeconds / (delayMs/1000)), delayMs)`,
   or restructure to a wall-clock deadline rather than an attempt count) —
   this at least makes the poll window match its documented seconds
   semantics, though it does not by itself fix the *later-start* half of the
   race (steps 2–5 still run before polling begins).

Both are changes to the vendored `@x402/stellar` library, not to this repo.

## Interim: raise the seller's advertised `maxTimeoutSeconds`

Until either upstream fix lands, the only lever available in this repo is
the seller's advertised `maxTimeoutSeconds` — raising it gives both the
auth-entry expiration and the poll budget more absolute runway, so that
steps 2–5's roughly-fixed overhead becomes a smaller fraction of the shared
window rather than a larger one. `examples/seller.mjs` currently advertises
`maxTimeoutSeconds: 120` in all 19 requirement blocks. Raising to `300`
leaves ~150–285s of runway after 15–30s of fixed overhead, versus 90–105s of
runway at `120` — meaningfully more margin against the same fixed cost. This
does not fix the underlying units bug or the later-start race; it only
widens the shared window enough that observed overhead is less likely to
exhaust it. It should be treated as a stopgap, not a resolution — the actual
fix belongs upstream, alongside the submission-status defect already filed
at `docs/upstream-issue-draft.md` (https://github.com/x402-foundation/x402/issues/3125).

## Recommendation

Same posture as `docs/diagnosis-settle-failures.md`'s own "Options, none
taken" table: document and report upstream before changing behavior
unilaterally. This document exists to make that report possible with
evidence, not as the fix itself.
