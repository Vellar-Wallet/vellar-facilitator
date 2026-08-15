# Vellar Facilitator — Build Plan

> **HISTORICAL (as of 2026-08-15).** This was the build-phase tracker; the
> system described here has been built, audited, and operated since. Current
> truth lives in `README.md`, `technical-doc.md`, and `docs/closing-state.md`.
> Kept for provenance, not guidance.

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


## Phase 2 — Bazaar Discovery — DONE 2026-07-31, live-proven

_Built on the official `@x402/extensions/bazaar` data model and validators
(same build-vs-compose rule as Phase 1). Full loop live-verified on testnet:
seller declares → agent pays (policy-governed smart account) → THIS
facilitator settles (tx `a08dc6bf…`) → resource auto-catalogs → searchable.
See docs/decisions.md._

- [x] `GET /discovery/resources` (type, payTo, scheme, network, extensions,
      limit, offset filters; wire-conformant with the unmodified canonical
      `withBazaar` client — pinned by test)
- [x] `GET /discovery/search` — token-scored relevance ranking (serviceName >
      tags > description > URL/tool), cursor pagination with stale-cursor
      invalidation
- [x] Automatic catalog registration on SETTLED payments carrying the
      discovery extension (catalog-on-settle = spam guard; cataloging can
      never break settlement — pinned by test)
- [x] HTTP endpoints and MCP tools both cataloged as first-class resources
      (type filter distinguishes them)
- [x] Route-template safety validation via the official extractor (path
      traversal + URL injection both proven dropped; valid templates
      honored — 3 dedicated tests)
- [x] MCP discovery server (`src/mcp.ts`, stdio): `x402_list_resources` +
      `x402_search_resources`, backed by the canonical withBazaar client —
      probed live over raw JSON-RPC, found the live-cataloged resource
- [x] Catalog persistence: optional JSON file (`CATALOG_FILE`), corrupt-file
      safe; storage behind the class for a future DB swap
- [x] Tests: 32 total (catalog filters/pagination/search/cursor/persistence,
      ingestion through a real x402Facilitator, wire conformance)

## Phase 3 — Production Readiness

- [ ] Mainnet support live (config plumbing exists — `STELLAR_NETWORK=pubnet`
      — but is untested; do NOT flip before the security review)
- [ ] Public operational telemetry / status dashboard (99%+ uptime target)
- [ ] Security review completed before any production traffic
- [ ] Sequence-number management under concurrent/bursty settlement load
      (technical-doc.md §6) — load-tested, not just designed. Note:
      `ExactStellarScheme` supports a `feeBumpSigner` decoupling fees from
      sequence numbers — evaluate under load
- [x] Hosting DEPLOYED 2026-07-31: `https://vellar-facilitator.onrender.com`
      (render.yaml blueprint, dedicated funded sponsor `GBUCR6H2…`).
      Live-proven: settlement tx `1da6f9e6…` through the hosted instance,
      fees paid by its own sponsor, resource cataloged on the hosted Bazaar.
      Vellar-branded subdomain (facilitator.vellar.xyz) still pending —
      custom-domain CNAME, cosmetic
- [x] SDK helpers for sellers and buyers — covered by the OFFICIAL packages
      (`declareDiscoveryExtension`, `bazaarResourceServerExtension`,
      `withBazaar`), deliberately not duplicated; our guide documents them
      (build-vs-compose rule)
- [x] Developer guide (`docs/guide.md`) with two end-to-end integration
      examples (`examples/seller.mjs` + `examples/buyer.mjs`) — both
      live-verified on testnet 2026-07-31
- [ ] Upstream contribution: `scheme_upto_stellar.md`

## Phase 5 — Trust layer — BUILT 2026-08-01 (gate overridden user-directed, same day as design)

_Part of the cross-repo "Provenance-Gated Agent Spending + Trust-Scored
Bazaar" initiative — full design in
`vela-wallet/docs/design-provenance-gated-spending.md` (public). This repo's
slice only; the contracts + attestor worker live in the wallet monorepo.
Boundary rule unchanged: this repo consumes verification over its public
HTTP history API + public RPC — no cross-repo code dependency._

- [x] Settlement stats: `onAfterSettle` records per-resource settlement
      count, unique payers (deduped, capped 10k), last-settled → additive
      `trust` block on catalog items; persistence format migrated
      backwards-compatibly
- [x] Trust annotation at read time (deviation from the designed
      `onBeforeVerify` placement, deliberate: discovery responses are where
      agents consume trust, and read-time annotation caches per-asset (5min
      TTL) instead of paying a lookup per payment): verification-API status
      + live on-chain wasm-hash cross-check (TOCTOU downgrade on drift;
      uncertainty never downgrades; API outage ⇒ "unknown", never blocks)
- [x] Bazaar ranking: search reranks verified > unknown > unverified
      (stable within relevance bands); `verified_only=true` filter on
      list/search; MCP tools gain a `verified_only` param (client-side
      filter on the additive trust field — zero wire deviation from the
      canonical bazaar client)
- [x] Tests: 15 new (resolver verdicts/caching/TOCTOU/degrade, annotation
      precedence, filter/rerank, stats accumulation/dedupe/survival) — 47
      total green, typecheck clean

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
