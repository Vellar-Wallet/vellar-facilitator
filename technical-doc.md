# Vellar Facilitator — Technical Document

SCF #45 RFP Track submission — "X402 Facilitator with Bazaar (Discovery)
Support." This document governs this repo (`vellar-facilitator`). It is
separate infrastructure from the Vellar wallet product; the two share x402
domain expertise, not code.

**Status: live on Stellar testnet, 578 tests passing. Production-hardened —
the channel pool (50 accounts; 50/50 under load), telemetry (11 Prometheus
metrics), the deploy runbook, and the RFP gap fixes are all shipped.
Pre-mainnet: the external security audit, semantic search, and the pubnet
deployment remain — see the checklist at the top of §9.**
The facilitator, Bazaar discovery, the MCP server, and the trust layer are
implemented, tested, and deployed at `https://vellar-facilitator.onrender.com`,
with on-chain settlements to show for it (§8). The pre-mainnet security review
is complete with every finding tracked to closure (`docs/security-audit.md`;
final statuses in `docs/closing-state.md`). One qualifier, stated here rather
than discovered later: the trust layer's *reputation* half (third-party
verification verdicts) is inert on the hosted deployment — every verdict
degrades to `unknown` until a verdict source is stood up (§6, §8) — while its
*ownership* half is live and enforced. This document describes the working
architecture and the path to mainnet that the SCF Build Award funds.

## Evidence at a Glance

Every load-bearing claim in this document, re-verified in one sweep on
2026-08-21, with the rows below the divider added and checked on 2026-09-04.
Each row names where to check it without trusting this table:

| Claim | Verified | Check it yourself |
| --- | --- | --- |
| The full loop works today from a clean run | `./demo.sh` during the sweep settled tx `c5ad0d7b…7f93` (ledger 4249010) and auto-cataloged the resource | `./demo.sh` — one command, no secrets, friendbot-funded |
| Payments settle on-chain; the sponsor pays the fee | tx `1da6f9e6…e039` Horizon-confirmed successful, `fee_account` = this facilitator's sponsor | hashes in §8, stellar.expert or Horizon |
| Provenance gating works both ways | tx `8bde387b…6faf` settled while attested; the identical payment post-revoke was rejected inside `__check_auth` | §8 |
| Canonical testnet USDC end to end, no faucet | tx `f9b743c5…8c98` (ledger 4106526) and `cda3cbaa…50ea` (ledger 4137813) | §8 |
| Hosted instance live; catalog survives restart | `/health` answered in 42.8 s from cold (the documented ~45 s), non-empty catalog at 19 s uptime | `curl https://vellar-facilitator.onrender.com/health` |
| `verified_only` refuses honestly rather than serving a misleading empty list | live `400 verified_only_unavailable` with the reason and a pointer to the field that does work | `curl '…/discovery/resources?verified_only=true'` |
| Tests and types | 578 passed, 4 skipped; `tsc --noEmit` clean | `npm test`, `npm run typecheck` |
| Pre-mainnet security review complete | every finding carries a final status | `docs/security-audit.md`, `docs/closing-state.md` |
| Reliability is measured, not asserted | the scheduled settle probe is green on its cron (five runs/day observed), each run settling real payments with a no-retry control arm beside the retry | the repo's Actions tab, `settle-probe.yml` |
| Agents can use it | the MCP server lists `x402_list_resources` / `x402_search_resources` against the hosted instance | `npx tsx src/mcp.ts` |
| `upto` settles for the metered actual, not the signed ceiling, and an independent service says so | three settlements against the hosted instance — actual/ceiling pairs 555000/1500000, 312000/800000, 417000/1200000 — each shows on `explorer.vellar.xyz` with `scheme: upto` and `settled by: vellar`, verified by neither this repo nor its author | `curl https://vellar-explorer.onrender.com/payments/<hash>`, or the feed at `explorer.vellar.xyz` |
| *— shipped since the 2026-08-21 sweep, verified 2026-09-04 —* | | |
| Concurrency is solved, with a negative control | channel pool: **50/50** settled, **0** `txBadSeq`, p95 **11,956 ms**. Single-signer control on the same run: **1/50**, **48** `txBadSeq` | `git log 6f5de85`, raw data in `load-test-results-2026-08-31T11-15-47-630Z.json` |
| Operational telemetry is live | 11 named `vellar_*` metrics on a public `/metrics`, forwarded to Grafana Cloud | `git log 97107b1`, `curl -s https://vellar-facilitator.onrender.com/metrics \| grep -c '^# HELP vellar_'` → 11 |
| An operator can stand up a new instance from nothing | `docs/deploy-runbook.md` — 445 lines, all 25 `config.ts` environment variables, provisioning, verification, and the operational gaps stated plainly | `git log 9c9bad3` |
| A seller learns whether their listing was cataloged | `EXTENSION-RESPONSES` on `/settle`, carried out of the error-swallowing hook via the same `AsyncLocalStorage` capture the channel pool uses | `git log c771c0d` |
| Two MCP tools on one server URL no longer collide | MCP resources keyed on the spec's `(resource.url, input.toolName)` tuple, U+001F separated | `git log c771c0d` |
| Discovery is asset-aware, settlement stays asset-agnostic | `/discovery/resources?asset=<SAC>` filters; `/supported` carries `catalogAssets`, derived live from the catalog | `git log dfa0aa9`, `curl -s https://vellar-facilitator.onrender.com/supported \| python3 -m json.tool` |
| Agents can reach the Bazaar from inside a web page | 6 WebMCP tools — 3 core plus 3 generated live from the Bazaar catalog | [`vellar-webmcp.onrender.com`](https://vellar-webmcp.onrender.com), [`Vellar-Wallet/vellar-webmcp`](https://github.com/Vellar-Wallet/vellar-webmcp) |

The table is an index; the sections behind it carry the methodology.

## 1. What This Is

An x402 protocol facilitator for Stellar: a hosted service that verifies and
settles HTTP-402 payments on behalf of resource servers (sellers), so sellers
never touch Soroban RPC, auth-entry construction, or fee sponsorship directly.
Paired with a **Bazaar discovery layer** so agents can find payable resources
without hardcoded integrations, and a **trust layer** that ranks discovery
results by real settlement data and on-chain source-verification status.

The RFP's three success outcomes, and where each stands:

1. A reliable facilitator on Stellar testnet and mainnet — **testnet live;
   mainnet is the funded final milestone.**
2. Permissive open-source licensing — **done (Apache-2.0), repo public.**
3. A functional Bazaar discovery system, the RFP's highest-value deliverable —
   **built and live-proven** (§5, §8).

## 2. Why Vellar, Specifically

Vellar's wallet product (a separate repo) built and live-tested the **payer**
side of x402 on Stellar first: a Soroban smart account autonomously paying
x402-protected resources under an on-chain spending policy, settled through
both the hosted Coinbase facilitator and a self-hosted one. That work surfaced
two concrete, facilitator-side defects — not hypothetical risks, things we hit
and diagnosed empirically, with transaction hashes:

**Fee-ceiling rejection under policy-governed payments.** A Soroban
smart-account payment gated by an on-chain spending policy runs that policy
inside `__check_auth`, which raises the simulation-derived resource fee well
above a plain transfer (~139,500 stroops vs ~22,000 in our testing). The
Coinbase-hosted facilitator's default `maxTransactionFeeStroops` (50,000)
rejects these as `invalid_exact_stellar_payload_fee_exceeds_maximum` — a valid,
policy-approved payment refused for being a smart account with programmable
spending controls. We reproduced it, confirmed it is a facilitator constructor
option (not a protocol limit), and settled the same payment through a
facilitator with the ceiling raised. **This facilitator ships with that fixed:
`MAX_TX_FEE_STROOPS` defaults to 500,000** — sized from evidence rather than
picked (a fresh policy-governed wallet simulates at 140,331 stroops; the worst
hash-verifiable on-chain charge is 28,711 — see
`docs/decision-fee-thresholds.md`), clearing the policy-payment class by ~3.6x
while bounding worst-case sponsor drain per settle at 0.05 XLM. Payments above
the 50,000 ceiling other facilitators sponsor settle here and not there.

**V1 vs. V2 (CAP-0071-02) credential handling.** We confirmed empirically that
both deployed facilitators we tested accept type-1 (`sorobanCredentialsAddress`)
auth-entry credentials and reject type-2 (address-bound). We also confirmed
passkey-kit 0.14 cannot emit type-1 credentials — a real gap blocking
passkey-signed x402 payments across the ecosystem, not just for Vellar. This
facilitator's conformance work starts from an already-mapped compatibility
matrix, and closing the V2 gap (so passkey-signed payments settle) is a funded
deliverable of this proposal.

## 3. Relationship to the Vellar Wallet Product

Related by shared x402 expertise, not shared code, release cycle, or ownership.

| | Vellar wallet (payer side) | Vellar facilitator (this repo) |
| --- | --- | --- |
| Role in x402 | Signs and pays | Verify/settle — trusted relay |
| Who uses it | Vellar wallet users | Any seller/agent on Stellar, Vellar or not |
| Chain interaction | Signs auth entries | Re-simulates, submits, sponsors fees |
| Uptime obligation | Standard app SLAs | 99%+ target, public telemetry |

The facilitator's existence has no bearing on Vellar wallet functionality — the
wallet's x402 client already works against any compliant facilitator,
third-party or this one. Equally, this facilitator serves any x402 client, not
only Vellar wallets.

## 4. Core Payment Flow

Actors: a buyer (a wallet or autonomous agent), a seller's resource server,
this facilitator.

1. **Buyer hits a paid endpoint.** Seller responds `402 Payment Required` with
   payment requirements: amount, asset (any SEP-41 token, USDC default),
   `payTo` address, network (`stellar:testnet` / `stellar:mainnet`).
2. **Buyer builds and signs a payment.** Constructs the SEP-41
   `transfer(from, to, amount)` as a Soroban auth entry, signed with a classic
   keypair or a smart-account signer, and retries with a `PAYMENT-SIGNATURE`
   header carrying the signed payload.
3. **Seller calls `/verify`.** The seller never touches Soroban directly. If
   the payer is a policy-governed smart account, `__check_auth` runs the policy
   contract during re-simulation — which is why the fee ceiling must accommodate
   policy-sized fees (§2).
4. **Facilitator re-simulates and returns a verdict.** Re-simulation, never
   trusting the signature blindly, is what makes verification trustworthy: a
   policy's on-chain logic runs for real. Under budget → valid. Over budget →
   the policy panics, `__check_auth` fails, `/verify` returns `isValid:false`.
5. **Seller calls `/settle`.** Facilitator submits to Soroban RPC, sponsoring
   the fee from its own account — buyers hold only the payment asset, no XLM.
6. **Settlement confirms on-chain; seller unlocks the resource.** Facilitator
   returns the tx hash; seller serves the response.

## 5. Bazaar Discovery Flow

Instead of an agent needing a resource's URL in advance, it discovers payable
resources through this facilitator.

1. **Sellers register implicitly.** When a settled payment carries the official
   `bazaar` discovery extension, the facilitator auto-catalogs the resource — a
   side effect of normal traffic, no separate registration step.
   Catalog-on-settle keeps unpaid spam out; route templates and service
   metadata are validated/sanitized (catalog-poisoning guard).
2. **An agent searches.** `GET /discovery/search?query=<natural language>` or
   `GET /discovery/resources?type=&payTo=&network=&extensions=&limit=&offset=`.
3. **Facilitator returns matches** — endpoint, how to call it, price, asset,
   and whether the resource is an HTTP API or an MCP tool (both first-class).
4. **Agent pays via §4.**

The VS Code extension (`VellarWallet.vellar-x402`) generates this
discovery metadata automatically as part of the injected boilerplate,
so any endpoint gated through the extension self-lists in the Bazaar
on first payment without any additional developer action.

An **MCP discovery server** wraps this so an LLM tool-use loop can call
`x402_search_resources` / `x402_list_resources` as MCP tools, not just raw HTTP.
Both are wire-compatible with the canonical `@x402/extensions` bazaar client.

### 5.1 Search ranking — lexical today, semantic before mainnet

**Stated plainly, because this is the part of the scope most often overclaimed.**
Ranking today is **lexical**: weighted token/substring matching over
`serviceName` (4), `tags` (3), `description` (2) and the resource URL (1), plus
the stringified `extensions.bazaar` blob for MCP entries (`scoreResource`,
`src/catalog.ts`). Results are computed in memory at read time. There are **no
embeddings, no vector index, and no documented evaluation methodology** — the
store has no vector column, no vector extension and no full-text index.

That baseline is deterministic and testable, and it answers keyword-shaped
queries well. It is **not** the semantic ranking the RFP asks to be graded on,
and it is not described here as if it were:

> "Search quality is a deliverable, not a detail: this means real ranking, and
> submissions must describe both their retrieval approach and how they will
> evaluate result quality over time."

**Pre-mainnet commitment — the next major engineering investment, not a
post-launch nice-to-have:**

- Semantic embeddings (`text-embedding-3-small` or equivalent) replacing the
  lexical scorer.
- A vector index — in-memory HNSW rebuilt at boot from stored embeddings, or
  Turso's native vector extension if available. Both are greenfield: no schema,
  dependency or model runtime for this exists today.
- An eval harness over a fixed query set, reporting **NDCG** or **MRR**.
- A documented quality-tracking process, so a ranking regression is caught
  before it deploys.

Sequenced **before** a mainnet tag, alongside the pubnet deployment itself. Full
status and the reviewer-facing framing: `docs/conformance-report.md` §6.3. This
is item 3 in the pre-mainnet checklist (§9 — Before mainnet).

## 6. Trust Layer

The facilitator sees every settlement, so it can rank discovery results by
ground truth rather than self-reported data:

- **Settlement stats.** Per-resource settlement count, unique payers, and
  last-settled timestamp accumulate on every successful settle.
- **Verification annotation.** At read time, each result's payment asset is
  checked against Vellar's contract-verification status API plus a live
  on-chain wasm-hash cross-check that catches contracts upgraded since
  verification (a time-of-check/time-of-use guard). Verdict: verified /
  unverified / unknown. A verification-API outage degrades to "unknown" and
  never blocks discovery.
- **Ownership verification (the anti-squat layer).** The first settlement for a
  canonical URL binds it to that payment's `payTo` (trust-on-first-use); the
  facilitator then fetches the resource's own 402 challenge over a hardened,
  DNS-pinned, SSRF-guarded prober and confirms the challenge names the bound
  address. A claimant who proves ownership displaces an unverified binding; a
  once-proven binding is permanently non-displaceable (the takeover guard).
  **Planned, not yet built:** a self-service rotation path for a merchant who
  still holds their old signing key (design: `docs/proposal-voluntary-rotation.md`
  — a marker settlement through the existing verify/settle path, requiring no
  new signing code for classic accounts and reusing the same smart-account
  workaround already used elsewhere in this repo). The permanence above stays
  absolute for the case where the key is lost — that case has no safe in-band
  answer, confirmed independently against an alternative design in a
  competing implementation, and remains an operator procedure. The wire
  reports the full state honestly: `ownerVerified` (currently confirmed),
  `ownershipState` (`unverified` / `proven-unconfirmed` / `verified`), and
  `statsSource` disclosing whether settlement counts were witnessed by the
  running process or inherited from storage. No other Stellar x402
  implementation, shipped or proposed, verifies listing ownership at the origin.
- **Under evaluation, not yet committed: SEP-1 domain verification as an
  additive second tier.** A seller who controls a domain can publish the
  Stellar-standard `/.well-known/stellar.toml` naming their `payTo`; a
  periodically re-checked (not latched) TOML tier would let a listing's
  verification follow a legitimate key rotation without an operator — a
  standards-based instance of the rotation anchor weighed in
  `docs/decision-verified-binding-rotation.md`. One competing implementation
  has built this pattern; whether it actually self-heals on a real rotation is
  unconfirmed, and confirming that is precisely what the evaluation must do
  before this becomes a commitment. If adopted it supplements, never replaces,
  the zero-setup 402-challenge verification above: SEP-1 requires a custom
  domain most demo and hackathon sellers do not have, and a listing clearing
  both checks is strictly more trustworthy than one clearing either alone.
- **Ranking + filter.** Search ranks verified results first (stably, within
  relevance bands). `verified_only=true` hard-filters — and on a deployment
  with no verdict source configured it is **refused with an explicit
  `400 verified_only_unavailable`** rather than answered with a silent empty
  list; the MCP tools annotate the equivalent condition as data for the model.

Companion on-chain enforcement (an attestation registry and a
verified-recipient policy that rejects unverified-contract interactions inside
`__check_auth`) lives in the Vellar wallet monorepo and is consumed here only
over the public verification HTTP API and public RPC — no cross-repo code
dependency. **Honesty bar: verified means reproducible, attributable source
provenance, NOT audited, benign, or safe.**

## 7. Why Stellar Changes the Design

Not a port of an EVM-style facilitator. Stellar/Soroban mechanics that shape
it, all encountered firsthand:

- **Auth entries, not pre-signed transactions.** The facilitator rebuilds the
  transaction around the buyer's signed auth entry rather than relaying a
  fully-formed signed tx — confirmed empirically (source/fee account on working
  settlements were the facilitator's own, never the buyer's).
- **Ledger-based expiration** (~60s / 12 ledgers), not a block number or
  wall-clock deadline — retry/timeout logic must account for it.
- **Two account types, one protocol.** Classic G-address keypairs (cheap to
  verify) and C-address smart accounts (can carry policy logic, costing more
  resource fee — §2) both work.
- **Trustlines** for classic accounts holding non-native SEP-41 assets — a
  concept with no EVM analogue.
- **Sequence-number contention under bursty agent traffic.** Stellar
  serializes transactions per source account, which caps one account near one
  transaction per ledger. The composed scheme supports a fee-bump signer that
  decouples fee payment from sequence numbers — but fee-bump alone raises
  throughput by nothing, since the sequence still comes from the inner source
  account. The throughput mechanism is a pool of channel accounts supplying
  independent sequence lanes. **That pool is built and live** — 50 accounts,
  shipped in `6f5de85`; see §8 for the measured before/after.

## 8. What's Built (verified on testnet)

Build-vs-compose: verified against `@x402/stellar@2.20.0` and
`@x402/core@2.20.0`, Coinbase's official packages already implement the Stellar
exact-scheme facilitator core — `ExactStellarScheme` (re-simulation verify,
sponsored settle, `maxTransactionFeeStroops`, optional fee-bump signer) and
`x402Facilitator` (scheme registration, verify/settle orchestration, lifecycle
hooks, `/supported`). The verify/settle layer here is therefore a thin,
correctly-configured composition of those packages — the value-add is
configuration (the fee ceiling), operation (uptime, telemetry, hosting), and
conformance testing. The genuinely novel engineering is **Bazaar discovery and
the trust layer**, which exist nowhere in the official packages — matching the
RFP's own weighting of Bazaar as the highest-value deliverable.

Implemented, tested, and live:

- **Facilitator:** `/verify`, `/settle`, `/supported`. Any SEP-41 token (USDC
  default), classic keypairs and Soroban smart accounts, sponsored fees, raised
  fee ceiling for policy-governed payments, replay resistance via ledger-bounded
  auth entries. **Conformance against the x402-foundation canonical client suite
  has not yet been run** — the wire shape is verified live endpoint by endpoint
  (`/supported` carries `areFeesSponsored`; every rejection carries a non-null
  machine-readable reason), but the canonical-client run and the x402 repo's own
  e2e suite are outstanding. See `docs/conformance-report.md` for the current
  status, the known gaps, and the plan to close them before mainnet.
- **Sponsor defense (audit finding F12):** the audit showed sponsor drain is
  *not* self-limiting — a self-dealer minting their own SEP-41 token settles
  self→self at zero cost to themselves while the sponsor pays every network
  fee. Shipped response: four spend budgets (per-URL, per-payTo, an
  unbound-merchant pool, and a global rolling XLM ceiling as the fail-closed
  backstop) plus a polling balance guard with floors, thresholds sized from the
  measured worst-case simulation fee rather than picked. Log-only on testnet,
  enforced on pubnet; a refused `/settle` returns `503 settlement_refused`
  with a machine-readable reason. Operational hardening alongside it: 60
  req/min per-IP rate limit and a 32 KiB body cap on every route.
- **Reliability engine:** a boot-time sponsor preflight that refuses to start
  unfunded and prints the exact fix; a ledger-skew retry scoped to the single
  rejection code that retrying can help (`src/retry.ts` — pattern adapted,
  with credit, from Turnpike's Apache-2.0 implementation and their published
  measurement of the load-balanced testnet RPC's node divergence); and a
  `TRY_AGAIN_LATER`
  submission retry (2 × 6 s, terminal statuses untouched) whose safety
  argument and observable falsifier are documented in `src/rpcstatus.ts`. A
  scheduled CI settle probe runs a concurrent no-retry control arm beside the
  retrying facilitator, so the improvement is measured against a true baseline
  instead of asserted.
- **Throughput — the 50-account channel pool** (`6f5de85`, design in
  `docs/channel-pool-design.md`). Stellar serialises per source account, so a
  single-signer facilitator is capped near one settlement per ledger (§7). The
  pool gives each concurrent settlement its own sequence lane. **Measured, with
  a negative control rather than an assertion** — 50 true-simultaneous
  settlements, same accounts, same run:

  | | Run 1 — single signer (control) | Run 2 — channel pool |
  | --- | --- | --- |
  | Succeeded | **1 / 50** | **50 / 50** |
  | `txBadSeq` | **48** | **0** |
  | p95 latency | 16,998 ms | **11,956 ms** |

  Raw data: `load-test-results-2026-08-31T11-15-47-630Z.json`. Run 1 is what
  makes Run 2 mean anything: the failure mode was reproduced first, then fixed.
  A real double-acquisition bug surfaced during this work — each `/settle`
  consumed two pool slots, silently halving capacity — and was closed
  structurally with an `AsyncLocalStorage`-scoped capture rather than a second
  manual `acquire()` (`src/facilitator.ts`). `/health` reports pool state live.
- **Operational telemetry** (`97107b1`, `f53b11c`, `e4ec7f4`): 11 named
  `vellar_*` Prometheus metrics (settle/verify counters, settle-duration
  histogram, the three pool gauges, catalog size, rate-limit rejections, uptime,
  reverify backlog) on a public `GET /metrics`, scraped by a Grafana Alloy
  service and forwarded to a Grafana Cloud dashboard. Setup and the public
  dashboard URL: `docs/grafana-dashboard-setup.md`.
- **Bazaar:** `/discovery/resources`, `/discovery/search`, auto-cataloging on
  settle, route-template safety guard, catalog persistence.
- **`EXTENSION-RESPONSES` on `/settle`** (`c771c0d`): a seller learns whether
  their listing was actually cataloged, and if not, why. Cataloging runs inside
  an `onAfterSettle` hook that deliberately swallows its own errors so it can
  never affect a payment, so the outcome is carried out to the route through the
  same `AsyncLocalStorage` capture pattern the channel pool and RPC-status
  capture already use. Reasons are a fixed enum, never interpolated text; the
  header is absent on every path where cataloging never ran.
- **MCP tools keyed as first-class resources** (`c771c0d`): an MCP server
  exposes many tools at one URL, so keying on the URL alone silently merged
  every tool on a server into one catalog entry. MCP resources are now keyed on
  the spec's `(resource.url, input.toolName)` tuple, separated by U+001F — a
  separator a seller cannot smuggle, since `new URL()` percent-encodes it and it
  is stripped from `toolName`. Non-MCP keys are byte-identical to before, so no
  stored listing migrates.
- **Asset-aware discovery** (`dfa0aa9`, `c7aedd8`): `GET
  /discovery/resources?asset=<SAC>` filters listings by accepted asset, and
  `GET /supported` carries `catalogAssets` — the live set of assets across the
  catalog, grouped by network, derived per request so a new asset appears with
  no config change. **The facilitator stays asset-agnostic at settle time**: this
  is discovery only, and the deliberate decision not to run an asset allowlist
  (`docs/security-audit.md`, F2) is unchanged. `docs/asset-support.md` documents
  USDC and USDT0, including USDT0's `auth_revocable` / `auth_clawback_enabled`
  flags — verified against mainnet Horizon on 2026-09-04 — and why that clawback
  risk sits with the seller rather than with a non-custodial facilitator.
- **WebMCP tools** ([`Vellar-Wallet/vellar-webmcp`](https://github.com/Vellar-Wallet/vellar-webmcp),
  live at [`vellar-webmcp.onrender.com`](https://vellar-webmcp.onrender.com)):
  browser-native tools exposing this facilitator's Bazaar to an agent running in
  the page. **6 WebMCP tools are registered at runtime:** 3 core tools
  (`search_vellar_bazaar`, `pay_and_call`, `check_vellar_earnings`) plus 3
  dynamic tools generated from the live Bazaar catalog (`call_uuid`,
  `call_quote`, `call_timestamp` — one per verified or proven-unconfirmed
  listing).

  The dynamic tools are not hardcoded. They are registered client-side on page
  load by querying `/discovery/resources` and filtering for listings with real
  settlement history, so as more endpoints earn verified status in the Bazaar,
  new WebMCP tools appear automatically without any code change. That is the
  Bazaar's discovery guarantee turned into agent-callable surface: the trust
  layer decides which listings qualify, and the tool list follows.

  Confirmed via `document.modelContext.getTools()` returning 6 tools in a live
  Chrome session with the WebMCP flag enabled. Submitted to the WebMCP Challenge
  hackathon (2026-09-03). Separate repo; it consumes this facilitator's public
  HTTP API and shares no code with it.
- **Trust layer:** settlement stats with provenance disclosure
  (`statsSource`, `observedSettlements`), TOFU ownership binding with
  origin-fetch verification and displacement, `ownershipState` tri-state on the
  wire, verification annotation with the live wasm-hash TOCTOU check,
  verified-first ranking, honest `verified_only` refusal when unanswerable.
- **MCP discovery server** (stdio): `x402_list_resources`,
  `x402_search_resources`. One design point deserves emphasis, because it
  addresses what is arguably the least-examined attack surface in this field:
  a discovery service that faithfully stores and serves seller-authored text
  is a delivery mechanism for prompt injection against every agent that
  trusts its catalog — the attack targets the facilitator's *users through*
  the facilitator, and conventional service hardening does nothing to stop
  it. Here, untrusted seller text is fenced with a per-block nonce before it
  enters an agent's context (format shared with the Vellar payer-side MCP
  server), so listing content can never occupy an instruction position.
  Shipped, not proposed.
- **Developer guide + three runnable end-to-end examples** (seller, classic
  buyer on the official x402 client at ~12 lines of payment logic, smart-account
  buyer). One command provisions a merchant, a funded payer, and — with
  `USE_USDC=1` — canonical testnet USDC acquired from the DEX with no faucet.
  The seller refuses at boot to write unverifiable entries into shared state,
  and the hosted demo resource is itself payable in USDC by any stranger.
  `demo.sh` walks a clean clone to a settled transaction hash in one command,
  with preflight checks that each name the real failure they prevent.
- **VS Code extension**
  ([`VellarWallet.vellar-x402`](https://marketplace.visualstudio.com/items?itemName=VellarWallet.vellar-x402),
  v0.1.3, MIT, live on the VS Code Marketplace): one command adds a working x402
  payment gate to any Express, Fastify, or Next.js App Router
  endpoint — type-checked against real `@x402/*` packages, injection
  verified across three framework fixture projects. Generated
  boilerplate includes the Bazaar discovery extension fields
  (`description`, `serviceName`, `tags`) so the endpoint
  auto-catalogs in the Bazaar on its first settled payment. The
  developer's payout address flows from a VS Code setting into the
  generated `PAYMENT_CONFIG.payToAddress` — no placeholder, no
  manual wiring. This closes the seller onboarding gap: the wallet
  is the x402 payer, this facilitator is verify/settle, the
  extension is how a developer becomes a seller in under a minute.
- **Test suite and security review:** 578 tests (`vitest run`), including
  mutation-named guards and the wire-conformance suites above; a completed
  pre-mainnet security review with every finding tracked to closure
  (`docs/security-audit.md`, `docs/closing-state.md`) — the F12 sponsor-drain
  finding and its shipped defense above are one product of it.
- **Deployed:** `https://vellar-facilitator.onrender.com`, dedicated funded
  sponsor account, `render.yaml` blueprint.

**Security posture: four trust boundaries, each with shipped controls.** Every
facilitator in this design space has these four boundaries; what differs is
whether the controls at each one are built or promised. Here, every row is
code in this repo today:

| Boundary | Adversary | Shipped controls |
| --- | --- | --- |
| Buyer/agent → facilitator | Hostile payer; fee drain via expensive `__check_auth`; replay | Re-simulation verify (the payer's policy runs for real); ledger-bounded auth entries; evidence-sized fee ceiling; four spend budgets + balance guard (F12); 60 req/min rate limit; 32 KiB body cap |
| Seller metadata → catalog | Listing/price spoofing, catalog poisoning, URL squatting | Catalog-on-settle only (no free write path exists); validation/sanitization via the official extractor; TOFU ownership binding with displacement rules; SSRF-hardened, DNS-pinned ownership prober |
| Catalog/search → agent | Prompt injection through listing text the facilitator faithfully serves | Seller-authored text is nonce-fenced before it reaches an agent's context (see the MCP bullet above) |
| Facilitator → Stellar RPC | Lost or ambiguous responses; degraded, load-balanced nodes | Real submission status captured per request (upstream discards it — #3125); retry only the one status that provably was not forwarded, terminal statuses untouched; ledger-skew retry at verify/settle |

The completed security review walks these boundaries
(`docs/security-audit.md`); `docs/closing-state.md` holds each finding's
final status.

Hosted-demo caveats, stated plainly. **The catalog is durable** — libSQL/Turso
since 2026-08-11, verified across a real spin-down with ownership bindings
intact; an empty catalog means an empty catalog, not a restart. The free tier
sleeps when idle (~45 s cold start, measured; a best-effort keep-warm cron
pings every 10 minutes during 07:00–21:00 UTC weekdays — margin against the
idle timeout, not a guarantee, since GitHub's scheduler measurably slips). An
always-on move is specified and priced in `render.yaml`, pending budget. Under burst access the testnet RPC declined to forward roughly 1
settle in 3, with nothing spent (`TRY_AGAIN_LATER`, diagnosed in
`docs/diagnosis-settle-failures.md`); the facilitator now retries that status
itself (§8, Reliability engine), error bodies still carry the real RPC status
when a settle ultimately fails, and the scheduled settle probe — its no-retry
control arm running beside the retry — is the instrument measuring the
post-retry failure rate rather than asserting one. Third-party trust verdicts require
`VERIFICATION_API_URL`; unset, every verdict reads `unknown` — the documented
degrade mode (§6), not a fault — and `verified_only` refuses loudly rather
than serving a misleading empty list.

Proof (Stellar testnet):

- Payment settled through the hosted facilitator: tx
  `1da6f9e6a90b78da898c99dfefba8821b5f632b72f584968fb057fd8a298e039` — fees paid
  by the facilitator's own sponsor (Horizon-confirmed), resource auto-cataloged
  and searchable at the time of settlement (see the catalog-persistence caveat
  above).
- Provenance-gated payment settled: tx
  `8bde387b82f8ba03484d0d6eb5838923e61ede6b7db483c97981b2fe7c5a6faf`. The full
  loop is proven: with the contract attested the agent payment settles; after
  revoke the identical payment is rejected inside `__check_auth` and no funds
  move.
- Canonical testnet USDC end to end, no faucet: provisioning buys USDC on the
  DEX from friendbot XLM, and a full x402 payment settles in it — tx
  `f9b743c5c7bceb0a6cf381c983bfd307db1b5f3877b5ad11db5fb04617de8c98` (ledger
  4106526), later
  `cda3cbaa9b4025e7413a20bb85c981beb64a862c931e18a7213b51fe689d50ea` (ledger
  4137813) against the hosted instance, merchant balances reconciling exactly
  to price × settlements across every attempt, including failed ones.
- Two upstream defects in `@x402/stellar` found, reproduced, and filed:
  x402-foundation/x402 #3125 (settle discards the RPC's submission status) and
  #3158 (the client scheme cannot sign for a Soroban smart account).

## 9. Path to Mainnet (what the Build Award funds)

### Before mainnet

Everything below must be complete before the mainnet tag. The list is
**sequenced** — each item depends on the previous being stable — and **one of
the seven is complete today** (item 2). What *is* complete alongside it is the
production-hardening work that precedes the list (§8, and the delivered items
struck through in milestone 1 below).

| # | Item | Status | Notes |
| --- | --- | --- | --- |
| 1 | External security audit | ⏳ Not started | Longest lead time — start first. Firms covering Stellar/Soroban: OtterSec, Halborn, Cure53, Trail of Bits. |
| 2 | Channel-account balance monitoring | ✅ Done | Automated via `src/channelMonitor.ts` (commit `c88d79f`). Disables on low balance, auto-enables on recovery, fail-open with a 5-failure staleness limit. |
| 3 | Semantic search (embeddings + eval harness) | ⏳ Not started | The RFP's highest-weighted requirement. Full plan in §5.1; status in `docs/conformance-report.md` §6.3. |
| 4 | Pubnet deployment + live settlement test | ⏳ Not started | A real `exact`-scheme settled tx hash on pubnet. Closes `docs/conformance-report.md` §6.2. |
| 5 | `upto` channel-pool integration | ⏳ Blocked | Concurrent `upto` settlements can `txBadSeq` — the scheme shares the sponsor's sequence instead of taking a pool lane. Blocked on the upstream wire format (x402-foundation/x402 #3134). `src/upto.ts`. |
| 6 | USDT0 mainnet trustlines | ⏳ Not started | Only where a *seller* accepts USDT0 — their `payTo` needs the trustline. Channel accounts need none (they hold no payment asset; §8, `docs/channel-pool-design.md` §5). `docs/asset-support.md`. |
| 7 | x402 Foundation listing | ⏳ Not started | A docs PR to x402-foundation/x402, after mainnet settlement is confirmed live. |

**Items 1–4 are hard blockers** — mainnet cannot ship without them. **Items 5–7
matter but can follow** the initial mainnet launch: 5 is upstream-blocked and
affects only `upto` concurrency (`exact` is unaffected), 6 applies only if a
seller chooses USDT0, and 7 is a post-launch announcement.

The three milestones below are the *funding* structure — what the Build Award
buys. The checklist above is the *status* answer: where this system is now, and
what stands between it and mainnet.

---

The testnet system exists; the grant funds productionization and mainnet
launch. Three milestones (final = mainnet, per SCF):

1. **Production hardening.** ~~DB-backed Bazaar catalog~~ — **delivered ahead
   of funding** (libSQL/Turso, live since 2026-08-11, restart-verified).
   ~~Operational telemetry + public status dashboard~~ — **delivered**
   (11 named Prometheus metrics, Grafana Cloud dashboard; §8).
   ~~Load-hardening + sequence-number management under concurrent settlement~~
   — **delivered** (the 50-account channel pool; §8).
   ~~Operator deployment documentation~~ — **delivered**
   (`docs/deploy-runbook.md`, `9c9bad3`: prerequisites, all 25 environment
   variables read out of `config.ts`, sponsor and channel-account provisioning,
   post-deploy verification, and the operational gaps stated plainly).
   Remaining: **a live
   trustline/payability check on every discovery entry** — read-time
   confirmation that the listed `payTo` currently holds a trustline for the
   priced asset, so a buyer is warned before attempting a settlement that
   would fail on-chain (ownership verification answers "is this listing
   theirs"; this answers "can they be paid right now"); **voluntary
   rotation for verified bindings** — proposed design at
   `docs/proposal-voluntary-rotation.md`, not yet implemented. **A public
   transaction explorer is live** at
   [`explorer.vellar.xyz`](https://explorer.vellar.xyz) — a separate repo
   (`Vellar-Wallet/vellar-explorer`), independently built and operated,
   classifying real settlements straight off the Stellar ledger rather than
   from anything this facilitator reports about itself. Own-settlement
   attribution is live today; the ecosystem-wide, any-facilitator scope from
   `docs/proposal-ecosystem-explorer.md` remains future work.
2. **Upstream + provenance.** The `upto` metered scheme for Stellar is
   **built and deployed**, ahead of this milestone's original schedule.
   `upto` lets a buyer authorize a spending ceiling and pay only for what is
   actually consumed — the billing model real API businesses run on
   (per-token, per-byte, per-compute) and the most-cited gap in the RFP's own
   framing. Rather than design one from scratch, an open-source Stellar
   `upto` contract was reviewed line-by-line against a six-implementation
   comparison across the wider SCF cohort, endorsed, and **deployed as our
   own build from pinned, reviewed source** — never a third party's running
   instance, whose wasm hash we have not independently verified:

   | | |
   | --- | --- |
   | Contract (testnet) | `CDHPA64M73TUTEM4MMHIWIXINBQXH7JJXFGZMGH22VJWFJFROMR6QV2S` |
   | Wasm hash | `c276b905981eab91704ce9b9046ebb4867b164dd7e4ba0e0ecda841527d398a9` — reproducible from source, steps in `docs/upto-deployment.md` |
   | Contract properties | no admin key, no upgrade path, no custody — the bounded-draw shape (authorize a ceiling, draw exactly the actual amount, never move the remainder), so "never holds funds" is structural, not an atomicity claim |

   `/supported` on the hosted instance advertises both `exact` and `upto`
   today. **Verified independently, not just by this repo**: three
   settlements against the hosted instance — actual amounts 555000, 312000,
   and 417000 stroops against signed ceilings of 1500000, 800000, and
   1200000 — each shows on the separately-operated
   [`explorer.vellar.xyz`](https://explorer.vellar.xyz) with `scheme: upto`
   and `settled by: vellar`, the metered actual displayed rather than the
   ceiling. An upstream contribution to x402-foundation/x402 PR #3134 (open,
   competing with #3098) — carrying the review findings on hook safety,
   custody-window economics, and a nonce-TTL replay fix found during the
   review — is identified and ready to write, currently paused by choice
   rather than blocked on anything. Also in this milestone: V2 (CAP-0071-02)
   credential support so passkey-signed x402 payments settle; the provenance
   attestor and agent-key mint/revoke UX productionized.
3. **Mainnet launch.** Facilitator + its three provenance contracts (attestation
   registry, verified-recipient policy, spending-limit policy) deployed to
   pubnet after an external security audit (SCF audit credits) with findings
   remediated — a second, independent review on top of the already-completed
   pre-mainnet review (§8), not the first look;
   proven uptime; mainnet USDC / multi-asset support; professional user testing.

   The conformance report (`docs/conformance-report.md`) identifies two further
   hard acceptance criteria that are **not** satisfied today: running the
   x402-foundation e2e suite against the live facilitator (§6.1 — it needs three
   funded Stellar accounts, and the blocker is environment, not code), and
   obtaining a settled transaction hash on pubnet for the `exact` scheme (§6.2 —
   the facilitator currently advertises `stellar:testnet` only). Both close as
   part of this pubnet deployment step, and both are named in the checklist at
   the top of this section.

Mainnet-specific engineering: pubnet RPC + real USDC SAC configuration
(network plumbing exists via `STELLAR_NETWORK=pubnet`, currently untested),
mainnet fee/pricing configuration, sponsor-account funding and monitoring, and
the higher uptime/observability bar production traffic demands.

## 10. Operating Commitments

- **Decentralization.** The facilitator is a semi-trusted verify/settle relay,
  inherent to x402's current design. It holds no user funds or private keys; a
  compromised facilitator can refuse or misreport a payment but cannot steal
  funds. Verification is re-simulation-based and independently reproducible by
  anyone running the same open-source code. No exclusivity claim — competing
  Stellar facilitators are a healthy outcome, not a threat.
- **Privacy.** Operational logs only (requests, errors, latency) for a bounded
  retention window; no PII, no buyer-identity tracking. Wallet addresses and
  amounts are already public on-chain once settled.
- **Maintenance.** Spec conformance as `@x402/stellar` and the x402 protocol
  evolve, uptime/telemetry, security patching, and regular community status
  updates through the award window and beyond.

## 11. Non-Goals

- Not a Vellar wallet feature; ships no changes to the wallet SDK or app.
- No claim of exclusivity — see §10.
