# Vellar Facilitator — Build Plan

Single source of progress for this repo. See `technical-doc.md` for the full
spec this plan implements. An item is not done without tests, matching the
standard set in the Vellar wallet repo.

**Funding gate:** this entire initiative is a candidate SCF RFP Track
submission (SCF #45). Phase 0 must complete — and the RFP must be submitted
and, ideally, accepted — before committing to Phase 2+ as a real delivery
timeline. Building ahead of funding confirmation is a deliberate choice to
make if you want a stronger submission, not a requirement.

## Phase 0 — RFP Submission

- [x] Repo created: `Vellar-Wallet/vellar-facilitator` (private)
- [x] README + Apache-2.0 license
- [x] technical-doc.md drafted (architecture, RFP requirement mapping, flows)
- [ ] Interest form: decentralization rationale finalized (draft in
      technical-doc.md §8, needs sign-off)
- [ ] Interest form: user privacy / data-handling plan finalized (not yet
      drafted)
- [ ] Interest form: maintenance commitment decided — a real, binding
      number, not aspirational (technical-doc.md §8)
- [ ] Architecture diagram (RFP's Core Requirements explicitly ask for one;
      §4–§6 of technical-doc.md can be diagrammed directly)
- [ ] Interest form submitted
- [ ] Invited to submit full Build form (per RFP timeline: interest form →
      invitation → full submission → reviewer evaluation)

## Phase 1 — Facilitator Core (verify + settle)

_Do not start until Phase 0's submission is in and, ideally, invited — avoid
sinking build time before funding signal._

- [ ] Service scaffold: choose stack (Node/TS to match the rest of Vellar's
      services, or per `@x402/stellar`'s own conventions), health check,
      structured logging (reuse `@vellar/service-kit` patterns from
      vela-wallet if it makes sense to depend on it, or reimplement minimal)
- [ ] `POST /verify`: accept a PaymentPayload, re-simulate via Soroban RPC,
      return `{ isValid, invalidReason?, payer }`
- [ ] `POST /settle`: submit the transaction, sponsor the network fee,
      return the tx hash and on-chain result
- [ ] Fee-ceiling configuration: `maxTransactionFeeStroops` set high enough
      for policy-governed smart-account payments (technical-doc.md §2) —
      the specific bug this project exists to not repeat
- [ ] Support both classic keypair and Soroban smart-account payers (V1
      credentials first; V2 tracked as a known gap, see Non-Goals)
- [ ] Any SEP-41 token; USDC as the documented default
- [ ] Replay resistance / strict payload verification
- [ ] Testnet deployment, frictionless access
- [ ] Wire-level conformance: tested against at least one unmodified
      canonical x402 client (not just this project's own test harness)
- [ ] Unit + integration tests for verify/settle, including the fee-ceiling
      and credential-type cases specifically (regression coverage for the
      bugs that motivated this project)

## Phase 2 — Bazaar Discovery

- [ ] `GET /discovery/resources` (type, payTo, network, extensions, limit,
      offset filters)
- [ ] `GET /discovery/search` (natural-language query, cursor pagination)
- [ ] Automatic catalog registration when a PaymentPayload carries the
      discovery extension
- [ ] HTTP endpoints and MCP tools both cataloged as first-class resources
- [ ] Route-template safety validation
- [ ] MCP discovery server (agent-facing)
- [ ] Tests: catalog registration, search relevance/pagination, safety
      validation edge cases

## Phase 3 — Production Readiness

- [ ] Mainnet support, configurable pricing
- [ ] Public operational telemetry / status dashboard (99%+ uptime target)
- [ ] Security review completed before any production traffic
- [ ] Sequence-number management under concurrent/bursty settlement load
      (technical-doc.md §6) — load-tested, not just designed
- [ ] Hosting decided and deployed under a Vellar-branded subdomain
- [ ] SDK helpers for sellers and buyers, published
- [ ] Developer guide with two end-to-end integration examples
- [ ] Upstream contribution: `scheme_upto_stellar.md`

## Phase 4 — Ongoing (post-launch)

- [ ] Regular community status updates (RFP requirement, cadence TBD)
- [ ] Spec conformance maintained as `@x402/stellar` and the x402 protocol
      evolve
- [ ] V2 (CAP-0071-02) credential support added once upstream
      passkey-signing support lands (tracked jointly with
      `vela-wallet/technical-doc.md` §17.5 — this is the same upstream gap)

## Standing rules

- This repo does not depend on `vellar-sdk` or `vellar-dapp` code, and
  changes here never require changes there. Shared understanding, not
  shared code (see technical-doc.md §3).
- Record deviations and findings the same way the wallet repo does: a
  `docs/decisions.md` in this repo, once there's anything to record.
- No claims beyond what's actually tested and running — this project exists
  because a hosted facilitator overclaimed compatibility it didn't have
  (technical-doc.md §2); do not repeat that mistake here.
