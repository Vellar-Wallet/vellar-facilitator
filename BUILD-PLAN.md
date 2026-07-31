# Vellar Facilitator — Build Plan

Single source of progress for this repo. See `technical-doc.md` for the full
spec this plan implements. An item is not done without tests, matching the
standard set in the Vellar wallet repo.

**Funding gate — overridden 2026-07-31 (user-directed):** the original plan
was to gate Phase 1+ behind RFP submission/acceptance to avoid unfunded
build time. Deliberately overridden: building a working prototype
strengthens the submission itself (RFP reviewers favor teams who show, not
just tell) and de-risks the delivery timeline if funded. Phase 0 and Phase 1
now proceed in parallel, not sequentially.

## Phase 0 — RFP Submission

- [x] Repo created: `Vellar-Wallet/vellar-facilitator` (private)
- [x] README + Apache-2.0 license
- [x] technical-doc.md drafted (architecture, RFP requirement mapping, flows)
- [x] Interest form: decentralization rationale finalized (no custody,
      independently verifiable, no exclusivity claim)
- [x] Interest form: user privacy / data-handling plan finalized
      (operational logs only, 30–90 day retention, no PII/tracking)
- [x] Interest form: maintenance commitment decided — 24 months, real and
      binding
- [x] Architecture diagram — text-based, core payment flow + Bazaar
      discovery flow
- [x] Solo vs. team framing addressed head-on
- [ ] Interest form submitted
- [ ] Invited to submit full Build form (per RFP timeline: interest form →
      invitation → full submission → reviewer evaluation)

## Phase 1 — Facilitator Core (verify + settle)

_Reframed 2026-07-31 after inspecting `@x402/stellar@2.20.0`: Coinbase's
official packages already implement the Stellar `exact` scheme facilitator
(`ExactStellarScheme`: re-simulation verify, sponsored settle, fee-ceiling
config, fee-bump signer for sequence management) and the protocol
orchestrator (`x402Facilitator` in `@x402/core`: scheme registration,
lifecycle hooks, /supported). Phase 1 is therefore COMPOSITION of official
packages with correct config — small — not reimplementation. The genuinely
novel build is Phase 2 (Bazaar), exactly as the RFP itself weights it._

- [x] Service scaffold: TypeScript + Fastify (matching vela-wallet service
      conventions), strict tsconfig, vitest — typecheck clean
- [x] `POST /verify` + `POST /settle`: wire-compatible with the canonical
      `HTTPFacilitatorClient` body shape (`{ x402Version, paymentPayload,
      paymentRequirements }`), delegating to `x402Facilitator` — malformed
      payloads produce a graceful invalid verdict, not a 500 (pinned by test)
- [x] `GET /supported`: exposes the registered stellar:testnet exact kind
      with `areFeesSponsored: true` and the sponsor's signer address
- [x] Fee-ceiling configuration: `MAX_TX_FEE_STROOPS` env, DEFAULT 2,000,000
      (vs. the package's 50,000 default) — clears the ~140k policy-governed
      payment cost; a config test pins that the default stays above 140k
- [x] Unit tests: 11 passing (config validation incl. fee-ceiling bounds;
      health/supported/verify/settle route behavior)
- [ ] LIVE smoke: this facilitator verifies + settles a real payment on
      testnet from the existing vela-wallet spike payer
      (`scripts/x402-spike/`) — the true end-to-end proof, reusing the
      already-proven payer side against OUR verify/settle instead of
      x402.org
- [ ] Policy-governed payment live-verified through this facilitator
      (the fee-ceiling regression case, proven for real, not just configured)
- [ ] Support both classic keypair and Soroban smart-account payers
      confirmed live (V1 credentials; V2 tracked as a known gap, see
      Non-Goals)
- [ ] Wire-level conformance: tested against an unmodified canonical x402
      client (`HTTPFacilitatorClient` from `@x402/core/http` pointed at
      this server)
- [ ] Testnet deployment, frictionless access

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
