# Vellar Facilitator — Technical Document

Candidate SCF RFP Track submission (SCF #45, "X402 Facilitator with Bazaar
(Discovery) Support"). Governs this repo only. Not part of the Vellar wallet
product — see [vela-wallet's technical-doc.md §18](https://github.com/Vellar-Wallet/vellar-dapp/blob/main/technical-doc.md)
for the decision record on why this exists as a separate initiative.

Status: **pre-build.** Nothing described below is implemented yet. This
document exists to scope the work before writing code, and to give SCF
reviewers (and future collaborators) a single source of truth.

---

## 1. What This Is

An x402 protocol facilitator for Stellar: a hosted service that verifies and
settles HTTP-402 payments on behalf of resource servers (sellers), so sellers
never need to touch Soroban RPC, auth-entry construction, or fee sponsorship
directly. Paired with a Bazaar discovery layer so agents can find payable
resources without hardcoded integrations.

Three success outcomes, per the RFP:

1. A reliable facilitator on both Stellar testnet and mainnet.
2. Permissive open-source licensing (Apache-2.0, matching Vellar's other
   repos).
3. A functional Bazaar discovery system — the RFP's own "highest-value
   deliverable."

## 2. Why Vellar, Specifically

Vellar's wallet product (a separate repo, [vellar-dapp](https://github.com/Vellar-Wallet/vellar-dapp))
already built and live-tested the **payer side** of x402 on Stellar: a
Soroban smart account autonomously paying x402-protected resources under an
on-chain spending policy, settled through both the hosted Coinbase
facilitator and a self-hosted one. That work surfaced two concrete,
facilitator-side defects this RFP exists to fund a fix for — not
hypothetical risks, things we hit and diagnosed empirically:

**Fee-ceiling rejection under policy-governed payments.** A Soroban
smart-account payment gated by an on-chain spending policy runs that policy
inside `__check_auth`, which raises the simulation-derived resource fee well
above a plain transfer (~139,500 stroops vs ~22,000 in our testing). The
Coinbase-hosted facilitator's default `maxTransactionFeeStroops` (50,000)
rejects these as `invalid_exact_stellar_payload_fee_exceeds_maximum` — a
valid, policy-approved payment refused for being a smart account with
programmable spending controls. We reproduced this, confirmed it's a
facilitator constructor option (not a protocol limit), and settled the same
payment through a self-hosted facilitator with the ceiling raised. This
facilitator ships with that fixed from day one, not discovered in
production.

**V1 vs. V2 (CAP-0071-02) credential handling.** We confirmed empirically
that both deployed facilitators we tested (Coinbase's and OpenZeppelin's)
accept type-1 (`sorobanCredentialsAddress`) auth-entry credentials and
reject type-2 (address-bound). We also confirmed passkey-kit 0.14 cannot
emit type-1 credentials at all — a real gap blocking passkey-signed x402
payments across the ecosystem, not just for Vellar. This facilitator's
conformance work starts from an already-mapped compatibility matrix instead
of discovering it from scratch.

Full findings, with transaction hashes: `vela-wallet/docs/decisions.md`,
entries dated 2026-07-25 and 2026-07-26.

## 3. Relationship to the Vellar Wallet Product

This facilitator and the Vellar wallet are **related by shared x402
expertise, not shared code, release cycle, or ownership.**

| | Vellar wallet (vellar-dapp, vellar-sdk) | Vellar facilitator (this repo) |
|---|---|---|
| Role in x402 | Payer — signs and pays | Verify/settle — trusted third party |
| Who uses it | Vellar wallet users | Any seller/agent on Stellar, Vellar or not |
| Chain interaction | Signs auth entries | Re-simulates, submits, sponsors fees |
| Funding | Product revenue / SCF Build Award (separate) | This RFP, if awarded |
| Uptime obligation | Standard app SLAs | 99%+ target, public telemetry (RFP requirement) |

The facilitator's existence has no bearing on Vellar wallet functionality —
`wallet.x402.fetch()` in `vellar-sdk` already works against any compliant
facilitator, third-party or this one.

## 4. Core Payment Flow

Actors: a **buyer** (a wallet or autonomous agent), a **seller's** API/resource
server, this **facilitator**.

1. **Buyer hits a paid endpoint.** e.g. `GET api.example.com/premium-data`.
   Seller responds `402 Payment Required` with payment requirements: amount,
   asset (any SEP-41 token, USDC default), `payTo` address, network
   (`stellar:testnet` / `stellar:mainnet`).
2. **Buyer builds and signs a payment.** Constructs the SEP-41
   `transfer(from, to, amount)` as a Soroban auth entry, signed with either a
   classic keypair or a smart-account signer. Retries the request with a
   `PAYMENT-SIGNATURE` header carrying the signed payload.
3. **Seller calls this facilitator's `/verify`.** The seller never touches
   Soroban directly — it forwards the payload here. If the payer is a
   policy-governed smart account, `__check_auth` runs the policy contract
   during re-simulation, which is why `maxTransactionFeeStroops` must
   accommodate policy-sized fees (§2), not default to a plain-transfer
   ceiling.
4. **Facilitator re-simulates and returns a verdict.** Re-simulation (never
   trusting the signature blindly) is what makes verification trustworthy —
   a policy's on-chain logic runs for real. Under budget → valid. Over
   budget → the policy contract panics, `__check_auth` fails, `/verify`
   returns `isValid:false`.
5. **Seller calls `/settle`.** Facilitator submits to Soroban RPC, sponsoring
   the fee itself — buyers hold only the payment asset, no XLM required (a
   hard RFP requirement, and consistent with how Vellar's own wallet-service
   already sponsors submission for its users).
6. **Settlement confirms on-chain; seller unlocks the resource.**
   Facilitator returns the tx hash; seller serves the actual response.

## 5. Bazaar Discovery Flow

A separate, additive concern: instead of an agent needing to already know a
resource's URL, it can discover payable resources through this facilitator.

1. **Seller registers a resource implicitly.** When a seller's
   `PaymentPayload` carries the discovery extension, the facilitator
   auto-catalogs it as a side effect of normal x402 traffic — no separate
   registration step.
2. **An agent searches.** `GET /discovery/search?q=<natural language>` or
   `GET /discovery/resources?type=&payTo=&network=&extensions=&limit=&offset=`.
3. **Facilitator returns matches** — endpoint, price, asset, and whether the
   resource is a plain HTTP API or an MCP tool (both are first-class, per
   the RFP).
4. **Agent pays via §4.**

An **MCP discovery server** wraps this so an LLM tool-use loop can call
"find a Stellar resource that does X" as an MCP tool, not just raw HTTP.

## 6. Why Stellar Changes the Design

Not a port of an EVM-style facilitator. Specific Stellar/Soroban mechanics
that shape this facilitator, all encountered firsthand during the payer-side
work:

- **Auth entries, not pre-signed transactions.** The facilitator typically
  rebuilds the transaction around the buyer's signed auth entry rather than
  relaying a fully-formed signed tx — confirmed empirically (source/fee
  account on working settlements were the facilitator's own, never the
  buyer's).
- **Ledger-based expiration** (~60s / 12 ledgers default), not a
  block-number or wall-clock deadline — retry/timeout logic must account
  for this.
- **Two account types, one protocol.** Classic G-address keypairs (cheap to
  verify) and C-address smart accounts (can carry policy logic, but cost
  more resource fee — §2) must both work.
- **Trustlines** for classic accounts holding non-native SEP-41 assets — a
  buyer without a trustline to the seller's asset cannot receive it, a
  concept with no EVM analogue.
- **Sequence-number contention under bursty agent traffic.** A facilitator
  sponsoring and submitting many concurrent agent payments needs real
  sequence-number management — a different operational surface than a
  single-user wallet backend.

## 7. Planned Deliverables (Mapped to RFP Requirements)

**Build-vs-compose note (2026-07-31, verified against `@x402/stellar@2.20.0`
and `@x402/core@2.20.0`):** Coinbase's official packages already implement
the Stellar `exact` scheme facilitator core — `ExactStellarScheme`
(re-simulation verify, sponsored settle, `maxTransactionFeeStroops` config,
optional fee-bump signer decoupling fee payment from sequence management)
and `x402Facilitator` (scheme registration, verify/settle orchestration,
lifecycle hooks, `/supported`). The verify/settle layer of this project is
therefore a thin, correctly-configured composition of those packages — the
honest value-add there is configuration (the fee ceiling §2 documents),
operation (uptime, telemetry, hosting), and conformance testing. The
genuinely novel engineering in this project is the **Bazaar discovery
layer**, which exists nowhere in the official packages — consistent with the
RFP's own weighting of Bazaar as the highest-value deliverable.

**Facilitator (verify + settle):**
- x402 v2 spec implementation for Stellar via `@x402/stellar`
  (`ExactStellarScheme` composed through `x402Facilitator` — see
  build-vs-compose note above)
- Any SEP-41 token, USDC default
- Sponsored network fees
- Classic keypairs and Soroban smart accounts, both supported
- Fee-ceiling handling for policy-governed payments (§2 — ships fixed:
  default `MAX_TX_FEE_STROOPS=2,000,000` vs. the package default of 50,000)
- Frictionless testnet access; configurable mainnet pricing
- Replay resistance, strict payload verification
- 99%+ uptime target, public operational telemetry dashboard

**Bazaar discovery:**
- `GET /discovery/resources`, `GET /discovery/search` (§5)
- Automatic catalog registration from the discovery extension
- HTTP endpoints and MCP tools as first-class resources
- Route-template safety validation

**Additional:**
- MCP discovery server for agent integration
- Upstream contribution: `scheme_upto_stellar.md`
- SDK helpers for sellers and buyers
- Developer guide, two end-to-end integration examples
- Security review before production
- Regular community status updates

## 8. Open Questions (need resolution before/during build)

- **Decentralization rationale.** The facilitator is a semi-trusted
  verify/settle relay — inherent to x402's current design, not a Vellar
  choice. Draft position: it holds no user funds or private keys;
  verification is re-simulation-based and independently reproducible by
  anyone running the same open-source code; Vellar is not positioned as the
  only facilitator on Stellar, and the design should not assume single-point
  trust. Needs sign-off before the RFP submission goes in.
- **User privacy / data handling.** What gets logged (payment requirements
  served, verify/settle requests) vs. what must not be (no PII beyond
  what's already on-chain). Not yet decided.
- **Maintenance commitment.** The RFP implies a multi-year support window.
  This is a real, binding obligation for whoever operates the facilitator —
  needs an explicit, realistic commitment before submission, not an
  aspirational one.
- **Hosting.** Same pattern as `vellar-backend` (Render, or equivalent),
  under a Vellar-branded subdomain (e.g. `facilitator.vellar.xyz`) — exact
  choice not yet made.

## 9. Planned: Trust-Scored Bazaar (designed 2026-08-01)

The facilitator's privileged position — it sees every settlement — becomes
a reputation layer: per-resource settlement counts, unique payers, and
last-settled timestamps accumulate in the catalog (`onAfterSettle`), and
verify-time trust annotation checks the payment asset's
contract-verification status plus its live on-chain wasm hash
(`onBeforeVerify`, warn mode, never blocking). Bazaar search ranks on
these `trust` fields and gains a verified-only filter, including in the
MCP tools. Companion on-chain work (an AttestationRegistry contract and a
VerifiedRecipientPolicy that rejects unverified-contract interactions
inside `__check_auth`) lives in the Vellar wallet monorepo; this repo's
boundary stays HTTP status API + public RPC. Full cross-repo design:
`vela-wallet/docs/design-provenance-gated-spending.md`. Build is gated
behind the Vellar x Stellar Hackathon and the SCF RFP submission; tracked
as Phase 5 in BUILD-PLAN.md.

## 10. Non-Goals (for now)

- This is not a Vellar wallet feature and ships no changes to `vellar-sdk`
  or `vellar-dapp`.
- Not committing to passkey-signed (V2 credential) support until upstream
  facilitator PRs land — this facilitator can choose to support V1 first and
  add V2 when the ecosystem does, same constraint documented in
  `vela-wallet/technical-doc.md` §17.5.
- No claim of exclusivity — other Stellar facilitators existing and
  competing is a healthy, expected outcome, not a threat to this project.
