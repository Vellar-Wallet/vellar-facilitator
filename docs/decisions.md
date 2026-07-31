# Decisions & findings — vellar-facilitator

Newest first. Same convention as the vela-wallet repo: record what was
decided or discovered, with enough evidence that a future reader can verify
it.

## 2026-07-31 — LIVE smoke PASS: this facilitator verifies + settles real policy-governed payments on testnet

The facilitator core (commit `d90c9ce`) was proven end to end against live
Stellar testnet, reusing the already-proven payer from
`vela-wallet/scripts/x402-spike/` (the same wallet/policy/agent state that
validated the payer side on 2026-07-26) — pointed at THIS facilitator
(`http://localhost:4100`) instead of x402.org.

Setup: policy-governed smart account `CDPUL7TZ…` (spending-limit policy
`CCHFLVE7…`, cap 5.0 tokens / 3600s rolling window), ed25519 agent signer,
custom SEP-41 token `CBIN4HTP…`, merchant `GAN5MFH3…`, spike resource server
with `FACILITATOR_URL` pointed at us. Facilitator sponsor: the same funded
testnet account the spike used (`GAJS3G2D…`), fee ceiling at the repo
default `MAX_TX_FEE_STROOPS=2,000,000`.

| Case | Amount vs cap | Result |
| ---- | ---- | ---- |
| Under budget | 0.1 / 5.0 | ✅ `/verify` accepted → `/settle` submitted, sponsored, **SUCCESS on-chain** — tx `a48818609704818b6e81c6c67c2e89bbace37d49b17819bf684eb6ad1da1d5a0`, payer = the C-address, resource unlocked (HTTP 200) |
| Over budget | 6.0 / 5.0 | ✅ `/verify` returned `isValid:false, invalidReason:"invalid_exact_stellar_payload_simulation_failed"` (the policy panics inside `__check_auth` during re-simulation), resource stayed 402, **nothing settled** |

Two things this proves beyond "it runs":

1. **The fee-ceiling fix works in anger, not just in config.** A
   policy-governed payment costs ~140k stroops of simulation-derived
   resource fee; the hosted x402.org facilitator's 50,000 default rejects it
   (`fee_exceeds_maximum` — the 2026-07-26 finding that motivated this
   project). The identical payment settled through us because the default
   ceiling here is 2,000,000.
2. **Smart-account (C-address) payers with on-chain budget enforcement work
   through this facilitator unchanged** — verify-by-re-simulation runs the
   policy for real, approving under-cap and rejecting over-cap, with no
   facilitator-side special-casing.

Evidence trail: facilitator request log showed the full `/supported` →
`/verify` → `/settle` sequence; settlement confirmed `SUCCESS` via Soroban
RPC by the payer script's own poll. The direct over-budget `/verify` probe
was made with a throwaway copy of the spike payer pointed at localhost
(created and deleted in the same step — spike code stays untouched).

Boundary honestly stated: this was a single-payer, single-merchant local
smoke on testnet — it validates correctness of the composed pipeline, not
concurrency, uptime, or bursty sequence-number behavior (those stay Phase 3
work).

## 2026-07-31 — Build-vs-compose: verify/settle is composition of official packages

Inspecting `@x402/stellar@2.20.0` + `@x402/core@2.20.0` before writing code:
Coinbase's official packages already implement the Stellar `exact` scheme
facilitator (`ExactStellarScheme`: re-simulation verify, sponsored settle,
`maxTransactionFeeStroops`, optional fee-bump signer) and the protocol
orchestrator (`x402Facilitator`: registration, hooks, `/supported`). The
facilitator core here is therefore a thin, correctly-configured composition
— the honest value-add is configuration (the fee ceiling), operation
(uptime/telemetry/hosting), conformance testing, and the Bazaar discovery
layer, which exists nowhere in the official packages. Docs (technical-doc.md
§7, BUILD-PLAN) were corrected the same day to say so.
