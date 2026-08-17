# Vellar Facilitator — Technical Document

SCF #45 RFP Track submission — "X402 Facilitator with Bazaar (Discovery)
Support." This document governs this repo (`vellar-facilitator`). It is
separate infrastructure from the Vellar wallet product; the two share x402
domain expertise, not code.

**Status: built and live on testnet.** The facilitator, Bazaar discovery, the
MCP server, and the provenance/trust layer are implemented, tested, and
deployed at `https://vellar-facilitator.onrender.com`, with on-chain
settlements to show for it (§8). This document describes the working
architecture and the path to mainnet that the SCF Build Award funds.

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

An **MCP discovery server** wraps this so an LLM tool-use loop can call
`x402_search_resources` / `x402_list_resources` as MCP tools, not just raw HTTP.
Both are wire-compatible with the canonical `@x402/extensions` bazaar client.

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
- **Sequence-number contention under bursty agent traffic.** A facilitator
  sponsoring and submitting many concurrent payments needs real sequence-number
  management; the composed scheme supports a fee-bump signer that decouples fee
  payment from sequence numbers. Load-hardening this path is a funded
  deliverable.

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
  auth entries. Wire-conformance tested against unmodified canonical clients.
- **Bazaar:** `/discovery/resources`, `/discovery/search`, auto-cataloging on
  settle, route-template safety guard, catalog persistence.
- **Trust layer:** settlement stats with provenance disclosure
  (`statsSource`, `observedSettlements`), TOFU ownership binding with
  origin-fetch verification and displacement, `ownershipState` tri-state on the
  wire, verification annotation with the live wasm-hash TOCTOU check,
  verified-first ranking, honest `verified_only` refusal when unanswerable.
- **MCP discovery server** (stdio): `x402_list_resources`,
  `x402_search_resources`, seller text fenced against prompt injection with a
  per-block nonce (format shared with the Vellar payer-side MCP server).
- **Developer guide + three runnable end-to-end examples** (seller, classic
  buyer on the official x402 client at ~12 lines of payment logic, smart-account
  buyer). One command provisions a merchant, a funded payer, and — with
  `USE_USDC=1` — canonical testnet USDC acquired from the DEX with no faucet.
  The seller refuses at boot to write unverifiable entries into shared state,
  and the hosted demo resource is itself payable in USDC by any stranger.
- **Deployed:** `https://vellar-facilitator.onrender.com`, dedicated funded
  sponsor account, `render.yaml` blueprint.

Hosted-demo caveats, stated plainly. **The catalog is durable** — libSQL/Turso
since 2026-08-11, verified across a real spin-down with ownership bindings
intact; an empty catalog means an empty catalog, not a restart. The free tier
sleeps when idle (~45 s cold start, measured; no reliable warm window — the
keepalive cron measurably cannot beat the idle timeout and is retired to
manual). An always-on move is specified and priced in `render.yaml`, pending
budget. Roughly 1 settle in 3 fails at the testnet RPC with
nothing spent (`TRY_AGAIN_LATER`, diagnosed in
`docs/diagnosis-settle-failures.md`); clients must retry, and error bodies
carry the real RPC status. Third-party trust verdicts require
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
  `f9b743c5c7bceb0a…` (ledger 4106526), later `cda3cbaa9b4025e7…` (ledger
  4137813) against the hosted instance, merchant balances reconciling exactly
  to price × settlements across every attempt, including failed ones.
- Two upstream defects in `@x402/stellar` found, reproduced, and filed:
  x402-foundation/x402 #3125 (settle discards the RPC's submission status) and
  #3158 (the client scheme cannot sign for a Soroban smart account).

## 9. Path to Mainnet (what the Build Award funds)

The testnet system exists; the grant funds productionization and mainnet
launch. Three milestones (final = mainnet, per SCF):

1. **Production hardening.** ~~DB-backed Bazaar catalog~~ — **delivered ahead
   of funding** (libSQL/Turso, live since 2026-08-11, restart-verified).
   Remaining: operational telemetry + public status dashboard toward the 99%+
   target; load-hardening + sequence-number management under concurrent
   settlement using the fee-bump path (channel accounts); **voluntary
   rotation for verified bindings** — proposed design at
   `docs/proposal-voluntary-rotation.md`, not yet implemented; **a public
   transaction explorer** — proposed design at
   `docs/proposal-ecosystem-explorer.md` (own settlements first, then
   ecosystem-wide attribution across any Stellar facilitator), not yet
   implemented.
2. **Upstream + provenance.** `scheme_upto_stellar.md` (the "upto" metered
   scheme spec + implementation) contributed upstream; V2 (CAP-0071-02)
   credential support so passkey-signed x402 payments settle; the provenance
   attestor and agent-key mint/revoke UX productionized.
3. **Mainnet launch.** Facilitator + its three provenance contracts (attestation
   registry, verified-recipient policy, spending-limit policy) deployed to
   pubnet after a security audit (SCF audit credits) with findings remediated;
   proven uptime; mainnet USDC / multi-asset support; professional user testing.

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
