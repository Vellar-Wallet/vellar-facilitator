# Proposal — an ecosystem-wide x402 transaction explorer

**Status: PROPOSAL. Not approved, not implemented, no code written.** Drafted
per request, after studying rail402's live explorer
(`explorer.rail402.dev`, source `tolgayayci/rail402/apps/explorer`) and
scoping the equivalent for us. Grounded against this repo's `main` — Fastify
(`src/server.ts`), `@libsql/client` (`src/store.ts`), the existing
`/supported` introspection endpoint, and the settle-time hook pattern already
proven in `src/bazaar.ts`.

**Scope, chosen explicitly.** This is the ecosystem-wide design — visibility
into x402 traffic across *any* Stellar facilitator, not just ours — because
that's the more useful product for anyone trying to understand x402 activity
on Stellar as a whole, not because another implementation happens to cover
that scope. A smaller version (our own settlements only) is a strict subset
of everything below (skip §2–§3, keep §1 and §5) if priorities change later;
nothing here forecloses it.

---

## 0. What rail402 actually built

Their explorer is a separate service (`apps/explorer`, ~15 source files) with
five layers:

1. **Live tail** (`ingest.ts`) — polls Soroban RPC `getEvents` every ~5s for
   `transfer` contract events, fetches each candidate transaction
   (`getTransaction`, `xdrFormat: "json"`), decodes the envelope.
2. **Classifier** (`classify.ts`) — a pure, structural pattern-match over the
   decoded XDR, no facilitator cooperation required:
   - `exact` := an `invoke_host_function` op invoking a SAC `transfer(from,
     to, amount)`, with a detached, **buyer-signed** address-credentialed
     auth entry, where the signer is distinct from the op/tx/fee source
     (proves the fee was sponsored — a hallmark of x402, not ordinary wallet
     activity).
   - `upto` := an invocation of a *known* settlement contract's `settle`
     function (the contract address itself is the marker).
   - Every row is labeled with a `confidence` tier — `x402-shaped`
     (structurally matches, attribution unknown), `verified-facilitator`, or
     the operator's own id — and confidence is never silently upgraded past
     what was actually observed.
3. **Attribution registry** (`registry.ts`) — facilitators are seeded
   (config) or self-announce (`POST /announce`), then periodically re-probed
   via their **own `/supported` endpoint** to learn their real signer set
   and any advertised `upto` contracts. A transaction's tx-source or
   fee-source is matched against this signer index to attribute it. Their
   own rule, stated in the code: *"an announcement is a lead, never a
   fact"* — only what's independently re-observed counts.
4. **Horizon backfill** (`horizon.ts`) — a second tier that walks each known
   facilitator's full account history via Horizon (which retains the whole
   chain epoch, unlike RPC's shorter retention window, and indexes fee-bump
   fee-sources as participants — so one walk covers an entire rotating
   channel-account pool), decoding `envelope_xdr` directly and running it
   through the same classifier.
5. **Enrichment** (`enrich.ts`, `catalog-sync.ts`) — joins `payTo` addresses
   to Bazaar catalog metadata (serviceName, resource, description).
   Advisory only; a miss or failure never blocks a payment row.

Storage is SQLite (`payments`, `cursors`, `facilitators`, `sellers`,
`backfill`, `horizon_cursors`). The API (Hono) is read-only: `/feed`,
`/tx/:hash`, `/sellers`, `/seller/:payTo`, `/asset/:contract`,
`/facilitators`, `/facilitator/:id`, `/stats`, `/ecosystem`,
`/ecosystem/timeseries`, `POST /announce`, `/health`, `/metrics`.

Everything here is **read-only observation of public chain data** — the
service holds no keys and moves no funds. That property carries over
directly to our version and is worth keeping as a stated invariant, not an
accident.

---

## 1. Why this doesn't map onto us 1:1 — and what does

Their hardest problem — the classifier and the attribution registry — exists
because they're reconstructing facts about *other people's* facilitators
from the outside, with nothing but public ledger bytes. For **our own**
settlements, that problem doesn't exist: every fact (buyer, seller, amount,
resource, scheme, tx hash) is already known with certainty the instant
`/settle` returns, from data we produced ourselves. So the honest shape of
the build is two genuinely different pieces bolted together:

- **Our own settlements: zero uncertainty.** A settle-time hook, same shape
  as the existing fire-and-forget calls in `src/bazaar.ts:88-94`
  (`tryDisplace`, `reverify`), writes a row directly — no classification,
  no confidence tier, because there's nothing to infer.
- **Everyone else's traffic: rail402's actual hard problem.** This is where
  their ingest/classify/registry/backfill machinery is genuinely needed, and
  where their engineering (the fee-sponsorship heuristic, the muxed-account
  normalization, the `source_account`-string auth-entry gotcha, the
  zero-amount `upto` blind spot) is worth reusing conceptually rather than
  re-deriving from scratch.

Both pieces write into the same store and serve through the same API — the
split matters for build order and confidence labeling, not for the final
product.

---

## 2. Proposed architecture for us

### 2.1 Where it lives

**A new service**, not new routes bolted onto `vellar-facilitator`.
Reasoning: the ingest loop polls continuously and independently of any
request; a stuck or slow RPC in the explorer must never be able to touch
facilitator latency, uptime, or its Fastify event loop. Same isolation
principle already applied to hosting (`render.yaml`) — the facilitator's
SLA is the thing that must never regress. Proposed name/path:
`vellar-explorer` (own repo or an `apps/`-style subdirectory if this repo
becomes a monorepo — a decision this proposal doesn't make).

It reuses this repo's stack, not rail402's:

| Layer | rail402 | Us |
|---|---|---|
| HTTP | Hono | Fastify (`@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit` already proven here) |
| Storage | SQLite (better-sqlite3) | `@libsql/client` (Turso) — already the store dependency in `src/store.ts`, same durable/embedded-replica story we already operate |
| Stellar SDK | `@stellar/stellar-sdk` | Same package, already a dependency (`^16.0.1`) |
| Config | zod + fail-fast | Same pattern already used in `src/config.ts` |

### 2.2 Ingestion — live tail

Directly analogous to `ingest.ts`: poll `getEvents` for `transfer` topics,
fetch+classify candidate hashes, persist a resumable cursor. Same resumable,
contained-failure discipline this repo already applies to `/settle` (a
single bad transaction, or one RPC hiccup, must never stall the loop) —
this is the same shape as `withRpcStatusCapture` / `withSkewRetry`
error-containment, applied to a poll loop instead of a request.

### 2.3 Classification

Reuse rail402's structural rules (§0.2) as the starting spec — they're
public, verified live (their code claims "5/5 true positives, 0 false
positives over 18 testnet ledgers, 2026-08-13," worth re-verifying
ourselves rather than taking on faith, per this session's own verification
discipline). Our `upto` scheme is still in design (the openx402 draft review
is a separate open item) — the classifier's `upto` branch should be stubbed
until that scheme is finalized rather than speculatively built against a
contract shape that doesn't exist yet.

### 2.4 Attribution registry

We already have the introspection endpoint this depends on:
`GET /supported` (`src/server.ts:143`, `facilitator.getSupported()`) already
exists and already reports our signer set — the registry's probe target
requires **zero new work on the facilitator side**. Seed list starts small
and honest: ourselves, plus any facilitator whose `/supported` we can
actually probe (rail402, x402.org — both public). Self-serve `/announce`
can be deferred to a later phase; a hardcoded seed list is a fine v1.

### 2.5 Horizon backfill

Same tier-2 pattern, deferred to a later phase (§3) — it's the piece that
recovers history older than the RPC retention window, which matters far
less on a fresh, low-volume explorer than it does for rail402's
already-running one.

### 2.6 Enrichment

Joins straight into **our own** Bazaar catalog (`src/catalog.ts`) — this is
actually a stronger position than rail402's, whose enrichment depends on
*their* facilitator's catalog. Ours already carries `serviceName`,
`resource`, and now (per the Phase 5 trust layer) verification state — a
transaction settled through us can be enriched with **verified ownership
status**, something rail402's enrichment doesn't have at all. That's a real
differentiation angle, not just parity.

### 2.7 API surface (v1)

A minimal, honest subset of rail402's: `/feed`, `/tx/:hash`, `/stats`,
`/sellers`, `/facilitators`. Skip `/ecosystem` and `/ecosystem/timeseries`
(market-share framing) until there's more than one or two attributed
facilitators in the data — an "ecosystem" chart with one real data point and
a wall of "unattributed" is not a good look, and rail402 only earned that
view by running long enough to accumulate it.

---

## 3. Phased build, not one shot

| Phase | Scope | New uncertainty | Effort |
|---|---|---|---|
| **1** | Our own settlements only: settle-time hook → store → `/feed`, `/tx/:hash`, `/stats` | None — same certainty as our own `/settle` response | S–M |
| **2** | Live-tail ingestion + classifier + our own `/supported` as the sole registry entry, so *our* traffic gets independently corroborated (a check on Phase 1, not a replacement for it) | Classifier false-positive/negative risk, scoped to testnet | M |
| **3** | Full registry (seed rail402 + x402.org) + attribution + `/facilitators`, `/sellers` directory | Attribution correctness depends on `/supported` staying truthful — same trust-but-verify posture as the rest of this codebase | M |
| **4** | Horizon backfill, `/ecosystem` views, pubnet | Public RPC rate limits/cost on pubnet (rail402 measured this explicitly — see below) | M–L |

Phase 1 alone answers "people can see transactions done" for our own
traffic with near-zero risk and is worth shipping on its own regardless of
how far the later phases go.

---

## 4. Costs and risks, stated honestly

- **New hosting.** A second always-on (or scheduled-poll) service is a new
  line item — flagging this explicitly and early because of the render.yaml
  paid-tier incident earlier this session: **nothing here should be
  interpreted as authorization to provision or pay for anything.** Testnet
  RPC polling is light enough that a free-tier instance is plausible for
  Phases 1–3; pubnet (Phase 4) is where rail402 had to actively measure and
  choose an RPC provider (`gateway.fm` over `mainnet.sorobanrpc.com`, by
  burst-tolerance) and cap watched assets to avoid saturating `getEvents` —
  a cost/ops decision to make deliberately when we get there, not default
  into.
- **RPC load.** Testnet: rail402 measured ~1.6 transfer events/ledger,
  trivial. Pubnet: ~250/ledger post-protocol-23 (classic payments emit
  transfer events too) — unfiltered watching is not viable there; filtering
  to known SAC contracts (USDC/EURC) is required, same as rail402 does.
- **Storage growth.** Unbounded by default; `@libsql/client` handles this
  fine at rail402's observed scale, but no retention/pruning policy is
  proposed here — worth a decision before Phase 4, not before Phase 1.
- **Classification risk.** Structural matching can misclassify unusual
  transactions (rail402's own comments flag several hard-won edge cases:
  muxed accounts, the `source_account`-string auth form, zero-amount `upto`
  settles emitting no events at all). Confidence tiers exist precisely so a
  misclassification reads as "structurally x402-shaped, unattributed"
  rather than as a false claim about a specific facilitator — carrying that
  discipline over is non-negotiable, not optional polish.
- **No settlement-path risk.** Everything above is additive and read-only;
  nothing in this proposal touches `/verify`, `/settle`, or any code path
  that moves money. Same boundary this repo already holds for the trust
  layer and the rotation proposal.

---

## 5. What I'm not doing without sign-off

No code, no new service, no repo, no hosting decision. This is the design
for review — per this session's standing discipline, and explicitly per
your instruction to document only for now.

---

*Related: `docs/competitor-study-rail402.md` (source-level rail402 audit,
this explorer not yet covered there — worth folding this section in if that
dossier gets revisited), `docs/proposal-voluntary-rotation.md` (the other
currently-open proposal, same "design first, build later" discipline).*
