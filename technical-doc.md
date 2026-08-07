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
`MAX_TX_FEE_STROOPS` defaults to 2,000,000.** Measured live: a stacked
double-policy payment charges 53,535 stroops of fee — above the 50,000 ceiling
other facilitators sponsor, which is why that class of payment settles here and
not there.

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
- **Ranking + filter.** Search ranks verified results first (stably, within
  relevance bands); `verified_only=true` hard-filters, on both HTTP and the MCP
  tools.

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
- **Trust layer:** settlement stats, verification annotation with the live
  wasm-hash TOCTOU check, verified-first ranking, `verified_only` filter.
- **MCP discovery server** (stdio): `x402_list_resources`,
  `x402_search_resources`, `verified_only` support.
- **Developer guide + two runnable end-to-end examples** (seller + buyer).
  Both default to the hosted facilitator and a funded demo merchant, so they
  run with zero required configuration.
- **Deployed:** `https://vellar-facilitator.onrender.com`, dedicated funded
  sponsor account, `render.yaml` blueprint.

Hosted-demo caveats, stated plainly. The instance runs on a free tier that
sleeps when idle (~1 min cold start on first request). The Bazaar catalog is
the documented single-instance JSON file store on ephemeral disk — a restart
or redeploy clears it, so `/discovery/*` can legitimately return an empty
catalog until the next settled payment re-seeds it (running the bundled
examples end to end does this). Trust verdicts require `VERIFICATION_API_URL`
to be configured on the instance; unset, every result reads `unknown` — the
documented degrade mode (§6), not a fault. The DB-backed catalog and the real
uptime bar are precisely the funded milestone-1 work (§9).

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

## 9. Path to Mainnet (what the Build Award funds)

The testnet system exists; the grant funds productionization and mainnet
launch. Three milestones (final = mainnet, per SCF):

1. **Production hardening.** DB-backed Bazaar catalog (replacing the file store,
   multi-instance ready); operational telemetry + public status dashboard
   toward the 99%+ target; load-hardening + sequence-number management under
   concurrent settlement using the fee-bump path.
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
