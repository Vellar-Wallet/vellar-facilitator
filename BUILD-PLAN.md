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
