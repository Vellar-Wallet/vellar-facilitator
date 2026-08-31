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
- [ ] Extend channel-account pool to UptoStellarScheme
      (src/upto.ts:219) — currently a documented limitation,
      see docs/channel-pool-design.md §8
- [ ] Channel-account balance monitoring job (src/channelPool.ts's
      disable()/enable() are fully implemented and exported but never
      called anywhere in production code today — found in the channel-pool
      security review). Without it, a channel account that drops toward
      the Stellar minimum reserve is never proactively pulled from
      rotation the way docs/channel-pool-design.md §5 describes; it stays
      `available` and keeps getting acquired until a settlement using it
      fails on-chain.
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
- [x] `upto` scheme BUILT and DEPLOYED 2026-08-21: endorsed rail402's contract
      after a line-by-line review and a six-implementation comparison across
      the SCF cohort (bleu/SDF-aligned, Rialto, LumenGate, openx402, Veridex),
      vendored verbatim at a pinned commit (`contracts/upto-stellar/`,
      Apache-2.0, credited — never rail402's own deployed instance, whose
      wasm hash is unverified), and deployed as OUR OWN build:
      contract `CDHPA64M73TUTEM4MMHIWIXINBQXH7JJXFGZMGH22VJWFJFROMR6QV2S`,
      wasm hash `c276b905981eab91704ce9b9046ebb4867b164dd7e4ba0e0ecda841527d398a9`
      — reproducible from source, verified against the fetched-back on-chain
      wasm (`docs/upto-deployment.md`). `/supported` advertises exact + upto
      on the hosted instance; live-proven with a partial settlement (actual
      250,000 under a signed 1,000,000 ceiling, tx `8b412ca6…`, Horizon-
      confirmed). Two review findings enforced in the scheme, not just
      documented: the settlement hook is refused (sponsor-facing hostile-
      callee surface), verify simulates at the ceiling. Client:
      `examples/upto-buyer.mjs`. Wire shape is EXPERIMENTAL pending
      x402-foundation/x402 PR #3134.
- [x] `upto` verified independently 2026-08-21: three hosted-instance
      settlements each show correctly on the separately-operated
      `explorer.vellar.xyz` (`scheme: upto`, `settled by: vellar`, the
      metered actual displayed, not the ceiling — full tx table in
      `docs/upto-deployment.md`). Found and fixed a real gap along the way:
      the explorer's own classifier only recognized the `exact`-scheme
      direct-transfer shape and never saw an `upto` settlement's contract
      invocation at all — root-caused by reading its `classify.ts`, fixed
      there to read the actual settled amount from the token's own emitted
      transfer event. Per the explorer's own attribution breakdown at time
      of writing, 6 of 4,799 indexed testnet payments carry a known
      facilitator, and all six are ours.
- [ ] Upstream contribution to PR #3134 — paused by user direction
      2026-08-21: independent-implementor review findings (signed-vs-
      unsigned hook, custody-window economics per LumenGate's measured
      escrow-vs-allowance benchmark, the auto-revoke tree-shape interop gap,
      rail402's nonce-TTL replay fix as a spec test vector) ready to draft
      whenever resumed

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

## Phase 6 — Voluntary rotation for verified bindings (proposed 2026-08-17)

_Added after the HISTORICAL freeze at the top of this file — this section is
live planning, not archive. Closes half of O-17
(`docs/closing-state.md`): a legitimate merchant who still holds their old
signing key gets an in-band path to rotate a verified binding. The other
half — the key is lost — has no in-band answer; confirmed independently by
auditing an alternative design in a competing implementation
(`docs/competitor-study-rail402.md` §2.1, corrected) as well as by our own
one-way latch. That half stays an operator procedure, tracked separately and
not yet written up as its own proposal._

Full design and implementation plan: `docs/proposal-voluntary-rotation.md`.

- [ ] `rotation_authorization` table + store methods (record / lookup /
      consume), alongside the existing `ownership` table
- [ ] `BazaarCatalog` in-memory tracking + the one-line bypass in
      `tryDisplace`, with mutation-guarded tests (expired, already-consumed,
      and wrong-owner markers must all still be refused)
- [ ] Settle-time hook in `bazaar.ts`, gated on the three-way match
      (authenticated `result.payer` == claimed `oldPayTo` == current
      `entry.ownerPayTo`) — the one place a shortcut becomes a
      vulnerability, so its own dedicated test
- [ ] `examples/rotate-classic.mjs` — proves the mechanism needs no new
      client code for a classic old-owner
- [ ] `operator-runbook.md` addition distinguishing this self-service path
      from §1, which stays the lost-key/emergency procedure

## Phase 7 — Ecosystem transaction explorer (proposed 2026-08-17)

_Public visibility into x402 settlements — "people can see transactions
done." Scoped ecosystem-wide (any Stellar facilitator's traffic, not just
ours); a comparable public explorer at `tolgayayci/rail402/apps/explorer`
was studied source-level for engineering reference (RPC event-polling,
attribution-from-signer-set, fee-sponsorship heuristics), but the
architecture and phasing below are our own. Full design, architecture
mapping onto this repo's stack, and cost/risk analysis:
`docs/proposal-ecosystem-explorer.md`. New service, own hosting — nothing
here authorizes provisioning or spend; that stays a separate decision._

- [ ] Phase 1 — our own settlements only: a settle-time hook (same
      fire-and-forget shape as `tryDisplace`/`reverify` in `bazaar.ts`)
      writes a row with zero classification uncertainty; `/feed`,
      `/tx/:hash`, `/stats` on a new service, `@libsql/client`-backed
- [ ] Phase 2 — live-tail ingestion (`getEvents` poll) + a structural
      classifier (exact/upto pattern match) on testnet, registered against
      our own `/supported` only, as an independent corroboration of Phase 1
- [ ] Phase 3 — full attribution registry (seed rail402, x402.org; re-probe
      `/supported` on an interval), `/facilitators`, `/sellers`, enrichment
      against our own Bazaar catalog (including verification status —
      rail402's enrichment has no equivalent)
- [ ] Phase 4 — Horizon backfill, `/ecosystem` + `/ecosystem/timeseries`,
      pubnet (RPC provider selection + SAC filtering required at pubnet
      volume, per rail402's measured `getEvents` load)
