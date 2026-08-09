# Decisions & findings — vellar-facilitator

Newest first. Same convention as the vela-wallet repo: record what was
decided or discovered, with enough evidence that a future reader can verify
it.

## 2026-08-09 — F11 resource-URL hijack: reproduced AND blocked on live testnet

The critical finding from the ownership investigation, demonstrated on-chain as a
controlled A/B: same accounts, same canonical URL, same payloads, only the code
differs.

Setup (self-contained, disposable testnet): issuer `GD2P22IM…` minting `F11TST`
via SAC `CBPYWRHT…`; classic payer `GAOP33R6…`; merchant A `GCKD7HEC…`
(legitimate) and merchant B `GAIDXTLQ…` (attacker payout); facilitator sponsor
`GBOC2UOB…`. Deliberately NOT the demo wallet — see the note below.

**PRE-FIX (`main`, port 4191) — HIJACKED.** Settle #1 to merchant A cataloged the
URL (tx `f7ea48f3070e9ad7…`). Settle #2 to merchant B on the SAME URL
(tx `d56dc927a7c7c019…`) produced exactly the three predicted effects:

- accepts grew to two entries — the attacker's payout served alongside the owner's
- description overwritten to "PAY HERE - cheapest"
- settlement stats carried forward (1 -> 2), so the attacker inherits the
  victim's accumulated credibility

**POST-FIX (`security/pubnet-blockers`, port 4192) — BLOCKED.** Identical
sequence. Settle #1 (tx `c16af8224c474901…`) cataloged normally. Settle #2
(tx `a909e4748c83f559…`) was **refused by the TOFU ownership binding**: accepts
still lists only merchant A, and the description is unchanged.

The control matters: settle #2 **succeeded on-chain in BOTH runs**
(`success: true`, real hash, fee 23,067 stroops paid by the sponsor in all four —
Horizon-confirmed). So "blocked" means the catalog rejected the hijack, not that
the payment failed. Without the pre-fix pass the post-fix result would have been
uninterpretable — "blocked" and "settlement broke for unrelated reasons" look
identical from the catalog alone.

Two things learned while getting there:

1. **The demo wallet (`CDPUL7TZ…`) currently refuses ALL payments.** Its
   verified-recipient policy is in the revoked state left over from the demo
   recording, so `__check_auth` fails with `Error(Contract, #1)` /
   `Error(Auth, InvalidAction)` for every recipient. Re-attesting needs the
   attestor key from the local Stellar keychain. Unrelated to F11, but it blocks
   `examples/` until re-attested.
2. **Classic-account auth entries must be signed via the SDK's `signAuthEntries`
   and NOT re-simulated afterwards** — re-simulation regenerates the auth nonce
   and invalidates the signature. Expiry must also stay inside the facilitator's
   tolerance (`+12` ledgers as in `examples/buyer.mjs`; `+100` is rejected as
   `invalid_exact_stellar_signature_expiration_too_far`).

## 2026-07-31 — DEPLOYED: hosted instance live and settling real payments

`https://vellar-facilitator.onrender.com` — deployed from the render.yaml
blueprint (sync `3ca4a41`), dedicated sponsor account `GBUCR6H2…` (created
and friendbot-funded the same day; NOT shared with the wallet backend's
sponsor — separate blast radius by design).

Proof against the HOSTED instance, not localhost:

- `/health`, `/supported` (advertising the exact scheme, sponsored fees,
  the bazaar extension, and the new sponsor), `/discovery/*` all verified
  over the public URL.
- The full seller→buyer loop ran with `FACILITATOR_URL` pointed at the
  hosted instance: policy-governed smart account paid, the hosted
  facilitator verified + settled — tx
  `1da6f9e6a90b78da898c99dfefba8821b5f632b72f584968fb057fd8a298e039`,
  Horizon-confirmed `successful: true` with **`fee_account = GBUCR6H2…`**
  (the hosted instance's own sponsor paid the fees — sponsorship verified
  empirically, not just configured).
- The hosted Bazaar auto-cataloged the resource; public
  `/discovery/search?query=motivational+quote` finds it.

Known free-tier limits (documented, deliberate for the demo stage): service
sleeps after ~15 min idle (~1 min cold start); no persistent disk, so the
JSON catalog resets on redeploy/restart — one settled payment re-populates
it. A paid disk or the DB swap (catalog storage is behind the BazaarCatalog
class) fixes both before any uptime commitment.

## 2026-07-31 — Bazaar discovery LIVE-PROVEN end to end (the RFP's highest-value deliverable)

The complete discovery loop ran against live testnet, all through THIS repo's
code plus the official packages:

1. **Seller** (`examples/seller.mjs`): Express + `x402ResourceServer` +
   `bazaarResourceServerExtension`, one paid route (`GET /quote`, 0.1 token)
   declaring the discovery extension via `declareDiscoveryExtension`. The
   402's `PAYMENT-REQUIRED` header carried the server-enriched extension
   (`method: GET` added by enrichment — verified by decoding the header).
2. **Buyer** (`examples/buyer.mjs`): the policy-governed smart account
   `CDPUL7TZ…` paid via its ed25519 agent key (V1 credentials), **echoing
   `required.extensions` into the payment payload** — the echo that feeds
   Bazaar.
3. **This facilitator** verified (policy ran in re-simulation) and settled
   on-chain: tx `a08dc6bffe17f21ed55548f6539e451feff8dd8b3ca2b602be7bfe51226af4b0`.
4. **Auto-catalog**: the settle hook extracted and cataloged the resource —
   `GET /discovery/resources` returned it with the full agent-usable call
   shape (method, queryParams, output example) AND the exact payment
   requirements; `GET /discovery/search?query=motivational+quote` ranked it
   first. Catalog persisted across the `CATALOG_FILE` round-trip.
5. **MCP**: `src/mcp.ts` probed live over raw stdio JSON-RPC — `tools/list`
   returned both tools; `tools/call x402_search_resources` found the
   live-cataloged resource through the MCP protocol.

Design decisions locked in by this build (details in code comments/tests):

- **Catalog-on-settle, not on-verify** — a resource enters the public
  catalog only after a real payment settled for it (spam/poisoning guard);
  cataloging failures can never affect settlement (hook swallows errors,
  pinned by test).
- **Official data model end to end** — `@x402/extensions/bazaar` supplies
  the types, validation (incl. the route-template poisoning guard, proven
  by tests for path-traversal and URL-injection payloads), and the
  canonical `withBazaar` client our wire-conformance tests use unmodified.
- **Search = deterministic token-scored ranking** (serviceName 4 > tags 3 >
  description 2 > URL/tool 1, exact-token hits double substring hits),
  cursor pagination with stale-cursor invalidation. No external search
  service; embedding-based ranking is a possible later upgrade, documented
  honestly as such.
- **Storage = in-memory + optional JSON file** behind the `BazaarCatalog`
  class; a database can replace the file without touching routes or
  ingestion. Single-instance honest; multi-instance needs the DB swap.

32 tests green, typecheck clean.

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
