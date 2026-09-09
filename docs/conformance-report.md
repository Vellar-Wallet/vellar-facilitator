# Conformance report — x402 `exact` and `upto` on Stellar

**Facilitator:** `https://vellar-facilitator.onrender.com`
**Report date:** 2026-09-03; e2e suite run added 2026-09-08
**Status:** partial — see [§6 Known gaps](#6-known-gaps). The e2e suite has now
been run against the live facilitator (§6.1): **C1 is satisfied on testnet**
with six Horizon-confirmed settlements, and **C4 is partial**. Pubnet (§6.2)
and semantic search (§6.3) remain unsatisfied and are named plainly below.

---

## 1. Overview

The RFP makes wire-level conformance a hard acceptance criterion, and preempts
internal test coverage as a substitute for it:

> "Correct settlement plus a non conformant wire format produces an unusable
> service, so acceptance is tested at the wire level. Reviewers will point stock
> SDK code at the deliverable rather than read a conformance claim."

It asks specifically for:

| # | RFP requirement | Status |
|---|---|---|
| C1 | An unmodified canonical client completing a payment end to end on both networks | ✅ **testnet** — 6 settled txs, §6.1. Pubnet: ⛔ §6.2 |
| C2 | `/supported` emitting the Stellar `extra` contract including `areFeesSponsored` | ✅ verified live, §3.1 |
| C3 | The spec `payload: {transaction}` format accepted verbatim | ✅ verified live, §3.2 / §5 |
| C4 | A passing run of the x402 repo's e2e suite for both networks | ⚠️ **partial** — 6/10 passed testnet, 4 unexecuted, pubnet unrun; §6.1 |
| C5 | A published settled transaction hash per network per scheme | ⚠️ **testnet only** — §4, §5. Pubnet: §6.2 |
| C6 | A non-null `reason` on every rejection | ✅ verified live, §3.3 |
| S1 | Bazaar search: "real ranking" with a stated evaluation approach (RFP §3.2) | ⚠️ **partial** — hybrid semantic search shipped (`969a56c`). Lexical + Voyage AI `voyage-code-3` embeddings, RRF fusion. Measured: semantic queries MRR 0.717, NDCG@3 0.789. Five of ten semantic queries miss first place. Eval corpus is one seller's demo (19 entries). Not claimed as met until retrieval quality holds across a diverse real-world corpus. See §6.3 |

This document is that artifact. Every claim in it is either a live response
captured from the running service, or a transaction hash independently
re-verified against Horizon at the time of writing — not quoted from an
internal document. Where something is not done, it says so and names the
blocker.

## 2. Facilitator under test

| | |
|---|---|
| Live URL | `https://vellar-facilitator.onrender.com` |
| Commit serving | `128b566` (from `GET /health`, 2026-09-03) — §3 captures were taken at `e4ec7f4` and re-checked after this deploy; see §6.4 |
| Networks advertised | `stellar:testnet` **only** — no `stellar:pubnet` |
| Schemes advertised | `exact`, `upto` |
| Extensions | `bazaar` |
| Channel pool | 50 accounts, 50 available at capture |
| Catalog size | 12 entries |
| Signers advertised | 51 (50 channel accounts + sponsor) |

> **Note on the commit under test.** The §3 captures below were taken against
> `e4ec7f4`, the then-deployed `main` build. PR #79 has since merged as
> `128b566` and deployed; the endpoint behaviour in §3 was re-verified against
> it and is unchanged. See §6.4.

## 3. Live wire-level checks (`exact`, testnet)

All captured 2026-09-03 against the live URL.

### 3.1 `GET /supported` — C2 ✅

> **Note (added 2026-09-09):** The hosted facilitator has since been updated to
> serve the Vellar-authored `upto` contract
> `CCZL7CTRS6GWEYXDYD54DZM3OUHQW2S2A4KSU75SH275P3SFZLL4YQAN` (wasm hash
> `92365d9e5effe046a1db5b959bd2357672aef3f4b2137653c8095a0764d1f6c8`, MIT
> licensed — see [`docs/upto-vellar-deployment.md`](./upto-vellar-deployment.md)).
> The `/supported` output below was captured during the conformance run and
> reflects the state at that time. A live call today returns the new contract id
> in `extra.uptoContract`; every other field below is unchanged.

```json
{
  "kinds": [
    { "x402Version": 2, "scheme": "exact", "network": "stellar:testnet",
      "extra": { "areFeesSponsored": true } },
    { "x402Version": 2, "scheme": "upto",  "network": "stellar:testnet",
      "extra": { "uptoContract": "CDHPA64M73TUTEM4MMHIWIXINBQXH7JJXFGZMGH22VJWFJFROMR6QV2S",
                 "areFeesSponsored": true } }
  ],
  "extensions": ["bazaar"],
  "signers": { "stellar:*": [ /* 51 addresses */ ] }
}
```

`areFeesSponsored: true` is present on both kinds, as the RFP requires. Only
`stellar:testnet` appears — this is the direct evidence for §6.2.

### 3.2 Discovery endpoints

`GET /discovery/resources?limit=2` → `pagination.total: 12`, real catalogued
resources with full `accepts` blocks carrying `extra.areFeesSponsored`.

`GET /discovery/search?query=quote&limit=2` → returns
`{ x402Version, resources, pagination, partialResults }`, with
`partialResults: true`. The spec's `partialResults` flag is implemented.

### 3.3 Rejection shape — C6 ✅

`POST /settle` with `{}`:

```json
{ "success": false, "transaction": "", "network": "stellar:testnet",
  "errorReason": "invalid_body", "error": "invalid_body",
  "detail": "paymentPayload and paymentRequirements are required" }
```

`POST /verify` with `{}`:

```json
{ "isValid": false, "invalidReason": "invalid_body",
  "error": "invalid_body",
  "detail": "paymentPayload and paymentRequirements are required" }
```

Both carry the x402-required fields (`success`/`transaction`/`network` on
settle, `isValid` on verify) **and** a non-null machine-readable reason. This is
G-13 in `closing-state.md`, confirmed live rather than by test.

## 4. `exact` scheme — testnet

**Settled transaction hash, re-verified against Horizon for this report:**

| | |
|---|---|
| Tx | [`1da6f9e6a90b78da898c99dfefba8821b5f632b72f584968fb057fd8a298e039`](https://stellar.expert/explorer/testnet/tx/1da6f9e6a90b78da898c99dfefba8821b5f632b72f584968fb057fd8a298e039) |
| `successful` | `true` |
| Ledger | 3898493 |
| Timestamp | 2026-07-31T15:30:34Z |
| Fee account | `GBUCR6H22CZC5OYHBJIEUS2JFZBOB63AHEGTCV6UEPMD2TMLKG2ZMIW4` (the facilitator sponsor) |
| Fee charged | 28,711 stroops |

The fee being charged to the facilitator's own sponsor account — not the buyer —
is the on-chain evidence for `areFeesSponsored: true`.

## 5. `upto` scheme — testnet

Full deployment record, including reproducible-build verification of the
contract wasm hash: [`docs/upto-deployment.md`](./upto-deployment.md).

**Re-verified against Horizon for this report:**

| Tx | successful | Ledger | Fee account |
|---|---|---|---|
| [`72c816a6…`](https://stellar.expert/explorer/testnet/tx/72c816a63ab9da21b1403ff5199e4f21b9947c0769c55312a8cf0dc7e6ecf3db) | `true` | 4250665 | `GBOC2UOB…` |
| [`be728773…`](https://stellar.expert/explorer/testnet/tx/be72877332bbd7f8d38511cccf00620fb20869cfedbc7530588ca856ac646d9a) | `true` | 4252896 | `GBUCR6H2…` |

Two further settlements (`f558307e…`, `12f0fa5c…`) are recorded in
`upto-deployment.md` with independent confirmation via
[`explorer.vellar.xyz`](https://explorer.vellar.xyz), a separately operated
service that classifies raw Stellar ledger data and does not read anything this
facilitator reports about itself.

### 5.1 Provenance — stated plainly

The `upto` Soroban contract in `contracts/upto-stellar/` is **vendored verbatim**
from [`tolgayayci/rail402`](https://github.com/tolgayayci/rail402) at commit
`ff504b85ac065369dc985759afe4164a4541d861` (Apache-2.0). See that directory's
`PROVENANCE.md`.

**It was not authored by this team.** What this team did:

- reviewed the source line by line before vendoring;
- built it independently and verified the wasm hash reproducibly
  (`c276b905981eab91704ce9b9046ebb4867b164dd7e4ba0e0ecda841527d398a9`), matching
  what the chain actually runs;
- deployed its own instance rather than trusting rail402's deployed one, because
  nothing tied that instance's on-chain hash to a reproducible build;
- re-ran the 17 upstream tests.

The RFP asks for the `upto` scheme to be **authored** and contributed upstream
via the x402 Technical Steering Committee. Vetting and independently rebuilding
someone else's contract is a materially different claim from authoring a spec,
and this report does not conflate them.

**Status: PR [#3428](https://github.com/x402-foundation/x402/pull/3428) open,
under TSC review** (filed 2026-09-08). *(was: "That has not been done.")*

What was filed is a **convergence document**, not a competing design:
`specs/schemes/upto/scheme_upto_stellar_interop.md`, 349 lines. It derives
MUST/SHOULD requirements from agreement across six implementations read in
source (rail402, #3134, #3098, Rialto, openx402, LumenGate) and names five
places they diverge as open questions for the TSC, without picking a winner.
Section 8 credits rail402 as the contract design author; what this team claims
is the reproducible-build verification and four live testnet settlements, not
authorship of the contract.

The head commit is [`eefd56d`](https://github.com/x402-foundation/x402/pull/3428/commits)
and is **GPG-signed and verified** (`verified: true`, `reason: valid` per the
GitHub API). The repo's `verified-commits-required` bot flagged the first,
unsigned push; the commit was re-signed and force-pushed. That check now passes.

Two things about how it was filed, stated because they bear on how much the
deliverable can be said to be met:

- **The filename is deliberately not `scheme_upto_stellar.md`.** That path is
  claimed by [#3134](https://github.com/x402-foundation/x402/pull/3134), and two
  PRs adding the same new file collide on merge. Filing there would have forced
  an either/or between documents this one describes as complementary.
- **No maintainer has replied yet.** We asked on #3134 (2026-09-08) where the
  work should land and offered to hand it over; the PR was filed before an
  answer, and states in its body that it will be closed and folded into either
  existing PR if the TSC prefers. Until a reviewer responds, "open" is the
  honest status, not "accepted".

Two upstream **issues** are also on record, both reproduced live rather than
inferred from reading source:

- [#3125](https://github.com/x402-foundation/x402/issues/3125) (2026-08-11):
  `settle` discards the RPC's submission status, so retryable and terminal
  failures are indistinguishable to callers. **Someone else is now fixing it**:
  [#3293](https://github.com/x402-foundation/x402/pull/3293) by `wakqasahmed`
  references it directly, so the issue produced a community fix rather than
  sitting unread.
- [#3158](https://github.com/x402-foundation/x402/issues/3158) (2026-08-14): the
  canonical client cannot sign for Soroban smart accounts, which makes an entire
  payer class (policy-governed agents, passkey wallets) unreachable.

One further upstream PR, in a different repository:

- [stellar/stellar-docs#2836](https://github.com/stellar/stellar-docs/pull/2836)
  (2026-09-08): **ready for review, signed, 0 reviews.** Adds Vellar to a new
  *Community facilitators* subsection of the x402 facilitators page, stating
  testnet-only and pre-production status inline. It proposes new structure in
  someone else's documentation rather than filling an existing list, so the PR
  offers to drop the change if maintainers would rather not carry a community
  section. Head commit `5d01b36`, GPG-signed and verified. Opened as a draft and
  marked ready the same day.

  This is **not** the x402 Foundation listing named as item 7 of the pre-mainnet
  checklist (`technical-doc.md` §9). That one targets `x402-foundation/x402` and
  stays gated on mainnet settlement. Two different repositories, two different
  listings; neither closes the other.

The upstream tally, stated plainly so it is not read as more than it is: **two
PRs open, both ready for review and both unreviewed, and two issues filed**, of
which one issue has attracted an independent fix. Nothing has been merged.

### 5.2 Known `upto` limitation

`upto` settlement is **not wired into the channel-account pool**
(`src/upto.ts`). It uses the sponsor account's sequence number directly, so
concurrent `upto` settlements can fail with `txBadSeq`. It is marked
EXPERIMENTAL in code, pending the upstream wire format stabilising
(x402-foundation/x402 PR #3134). `upto` should not be described as
production-ready.

## 6. Known gaps

### 6.1 The x402 e2e suite — RUN 2026-09-08 — C1 ✅ testnet, C4 ⚠️ partial

**The suite has now been run against the live facilitator.** Six scenarios
settled real payments end to end through
`https://vellar-facilitator.onrender.com`; four never executed because two
upstream server components fail to start in this environment. Both halves are
recorded below, and the four non-executing scenarios are **not** counted as
passes.

**Suite version:** `x402-foundation/x402` HEAD **`241df66`** ("Enforce
file-size and complexity limits with coverage thresholds", #3393). *(This
supersedes the `626df07` cited in earlier revisions of this section.)*

**Command:**

```bash
cd e2e
pnpm test --testnet --min --families=stellar --versions=2 --facilitators=vellar
```

#### C1 — unmodified canonical client, end to end — ✅ **testnet**

An unmodified stock `@x402/*` TypeScript client completed payment against the
live facilitator across three server frameworks and both HTTP client libraries.
Every hash below was re-verified against Horizon after the run — `successful:
true`, and `fee_account` equal to the facilitator's own sponsor
`GBUCR6H22CZC5OYHBJIEUS2JFZBOB63AHEGTCV6UEPMD2TMLKG2ZMIW4` rather than the
payer. That is `areFeesSponsored: true` demonstrated on-chain **by an external
suite this project does not control**, not by our own assertion.

| # | Client → Server → Route | Tx | Ledger |
|---|---|---|---|
| 1 | `fetch` → `express` → `/exact/stellar` | [`b6712023…3ca4`](https://stellar.expert/explorer/testnet/tx/b6712023355eaae20636da32a23909d0c74204ed0f6e46a6c6a10c06f4223ca4) | 4561546 |
| 2 | `axios` → `express` → `/exact/stellar/upfront` | [`55c3026d…132b`](https://stellar.expert/explorer/testnet/tx/55c3026db406de06d3e24e93ec3a3c57f87ac10bd9bbbc10ab60cb78fc79132b) | 4561549 |
| 5 | `fetch` → `hono` → `/exact/stellar/upfront` | [`ed32fe90…c670`](https://stellar.expert/explorer/testnet/tx/ed32fe90f4bb2d882919601f5b8706da6cf8420a9f91ee3f765223a9a6c8c670) | 4561559 |
| 6 | `axios` → `hono` → `/exact/stellar` | [`555d7538…a733`](https://stellar.expert/explorer/testnet/tx/555d7538c0c81e590a2a32a1c9039bea412dcca23d72baae82711b38856fa733) | 4561562 |
| 7 | `fetch` → `fastify` → `/exact/stellar/upfront` | [`22b97394…61c3`](https://stellar.expert/explorer/testnet/tx/22b97394a8bd99eeacf113cad9d13e390dd8b664cb163be9982e868ffed361c3) | 4561568 |
| 8 | `axios` → `fastify` → `/exact/stellar` | [`b401ff7b…8a4a`](https://stellar.expert/explorer/testnet/tx/b401ff7bc5c6c5774781588b4f16c2f4a4dff5ae235fa63c7129024d1eeb8a4a) | 4561571 |

All six charged `fee_charged: 23059` stroops to the sponsor, in consecutive
ledgers 4561546–4561571.

**The exact boundary of this claim:** testnet only, `exact` scheme only, over
`express` / `hono` / `fastify` with the `fetch` and `axios` clients. It does
**not** extend to pubnet (§6.2), to the `upto` scheme (which the upstream
Stellar catalog does not declare), or to the MCP transport (below).

#### C4 — a passing run of the e2e suite for both networks — ⚠️ **partial**

```
✅ Passed: 6    ❌ Failed: 4    📈 Total: 10    ⏱️ 3.25 min

Breakdown by server:
  typescript/http/express  ✅ 2 / ❌ 0 (100%)
  typescript/http/hono     ✅ 2 / ❌ 0 (100%)
  typescript/http/fastify  ✅ 2 / ❌ 0 (100%)
  typescript/http/next     ✅ 0 / ❌ 2 (0%)
  typescript/mcp           ✅ 0 / ❌ 2 (0%)
```

C4 is **not** claimed as satisfied, for two independent reasons:

1. **Four of ten scenarios never executed.** Tests 3, 4, 9 and 10 failed with
   `Error: Server failed to start` — `typescript/http/next` and
   `typescript/mcp` exit non-zero during startup. No payment was attempted and
   **no request reached the facilitator** on those four.
2. **The pubnet half was not run.** There is no pubnet deployment (§6.2), so
   the mainnet side of "both networks" remains unrun and unclaimed.

**Why the four failures are not attributable to this facilitator — with a
control.** The suite was first run against its own bundled reference
facilitator (`--facilitators=typescript`) as a negative control, on the same
machine, with the same accounts, in the same session. That baseline produced
the **identical** failure set: 6 passed, 4 failed, same two servers, same
`Server failed to start` error. A component that fails the same way against
the upstream reference implementation is an environment/upstream build problem,
not a Vellar defect. The `next` failure in particular matches the Next.js build
issue already recorded upstream.

This is stated as a control result rather than an assertion precisely because
"our thing failed but it isn't our fault" is the kind of claim that needs
evidence rather than confidence.

#### Reproducing this run

The proxy configuration used to target the hosted facilitator as an *external*
facilitator is committed in this repo at
[`e2e/facilitators/vellar/`](../e2e/facilitators/vellar/), with step-by-step
instructions in its `README.md`. Copy that directory into a clone of
`x402-foundation/x402` at `e2e/facilitators/external-proxies/local/vellar/`
and follow the README.

#### Corrections to the previous version of this section

The previous revision of §6.1 described a reproduction path that had never been
executed. Attempting it surfaced four errors, recorded here rather than quietly
fixed, because a set of instructions that has not been run is a claim and not
evidence:

1. **`FACILITATOR_URL` alone does not point the suite at an external
   facilitator.** The previous text said the live URL "can be used directly
   without writing a proxy." It cannot. `FACILITATOR_URL` tells the *resource
   server* which facilitator to call; it does not change which facilitator the
   harness starts. A first run with it set still launched the bundled
   `typescript` facilitator on port 4027 and tested against that. Per
   `e2e/facilitators/external-proxies/README.md`, external facilitators live in
   a proxy directory with a `test.config.json`, are "not selected by default",
   and "require explicit selection" via `--facilitators=<name>`. **Following the
   old instructions verbatim would have produced a green run that never
   contacted this facilitator** — a passing result that proved nothing. That is
   the failure mode `closing-state.md` §3.2 names, reached through a
   documentation error rather than a code one.
2. **`scripts/ci-select-families.ts` does not read `e2e/.env`.** It reads
   `process.env` only. The previous section quoted its "No protocol families
   have all required wallet secrets configured" output as empirical proof that
   the wallets were missing. That output was reproduced here with all three keys
   correctly present in `e2e/.env`; it resolved to `stellar` only after the
   variables were `export`ed. The message distinguishes "not exported" from "not
   available" not at all. The earlier conclusion happened to be true, but this
   check could not have established it.
3. **`pnpm install:all` inside `e2e/` is not sufficient.** The e2e workspace
   references `../typescript/packages/*`, and those packages need their own
   `pnpm install && pnpm build` in the parent `typescript/` directory first.
   Without it `@x402/express` does not resolve. `setup.sh` skips them because
   they carry no `install.sh`, `go.mod` or `pyproject.toml`.
4. **`pnpm build` in `typescript/` does not complete on a normal machine.**
   `@x402/evm` exhausts the JS heap (`ERR_WORKER_OUT_OF_MEMORY`) and aborts the
   turbo run before `@x402/stellar` is compiled. Turbo reported "18 successful,
   20 total" while every `dist/` directory was empty — tasks counted, nothing
   emitted. Build the needed subgraph instead:
   `npx turbo run build --filter=@x402/stellar...`, optionally with
   `NODE_OPTIONS=--max-old-space-size=8192`.

### 6.2 No pubnet (mainnet) deployment — C1, C4, C5 ⛔

The RFP treats both networks as committed deliverables, and requires a settled
hash **per network** per scheme. Testnet hashes do not substitute.

**Current state:** the live facilitator advertises `stellar:testnet` only
(§3.1). There is no pubnet deployment, and therefore no pubnet settled
transaction hash for either scheme. **No mainnet hash exists, and none is
claimed here.**

The code does support it: `src/config.ts:98` maps `STELLAR_NETWORK=pubnet` to
`stellar:pubnet`, with pubnet-specific fail-closed behaviour in the spend policy
(`src/config.ts:214`) and separate Horizon/RPC endpoints. What is missing is a
deployed instance and a funded mainnet sponsor account.

**Plan to close.** Deploy a second instance with `STELLAR_NETWORK=pubnet`, fund
its sponsor with XLM, provision channel accounts on pubnet, settle one real
`exact` payment, and record the hash here. Note that `docs/closing-state.md`
G-10 (the spend ceiling accounted at a ~22× over-estimate) is an open **pubnet
tuning** decision that should be resolved before a mainnet launch, not after.

### 6.3 Bazaar search ranking is hybrid; not yet claimed as met — RFP §3.2 ⚠️

**Hybrid semantic search shipped in `969a56c` (2026-09-08), and this item is
still not claimed as met.** Both halves of that sentence matter.

Embeddings exist: Voyage AI `voyage-code-3` (1024 dimensions), stored per entry,
fused with the lexical ranking below via Reciprocal Rank Fusion. Measured on the
ten semantic queries that share no vocabulary with any listing, MRR moved
0.264 → **0.717** and NDCG@3 0.263 → **0.789**, while the original ten
keyword-shaped queries were left unchanged at 0.950 / 0.963. That last part is
why hybrid was chosen over replacement.

It is not claimed as met because **five of the ten semantic queries still miss
first place** (all ten reach the top 3, so the right answers are retrieved but
not always ranked first), and the eval corpus is a single seller's demo of 19
entries. A retrieval quality number measured against one seller's catalog
describes that catalog, not the ranking.

*(This section previously read "lexical, not semantic ⛔" and asserted there
were no embeddings and no vector index. That was true when written and became
false on 2026-09-08. An earlier revision before that also understated the
lexical retriever and wrongly claimed there was no evaluation methodology.)*

**What is actually implemented** (`src/catalog.ts`, `scoreResource` and its
helpers):

| Stage | Detail |
| --- | --- |
| Tokenization | Query and field text split on the same path, so both sides normalise identically |
| Synonym expansion | **8 bidirectional groups**, expanded once per query rather than per entry. The map is *derived* from the group list rather than written twice, so a pair cannot drift in one direction |
| Stemming | A deliberately minimal **Porter-style stemmer, 6 suffix rules** (`tion`/`sion`, `ing`, `ly`, `ed`, `er`, plural `s` with an `ss` exemption). One rule fires per call. Applied to **both** sides — stemming the query against an unstemmed field breaks matches that previously worked |
| Field weighting | `serviceName` ×4, `tags` ×3, `description` ×2, resource URL ×1, plus the stringified `extensions.bazaar` blob for MCP entries |
| Trust ranking | `settlements × 2 + uniquePayers` — volume weighted double breadth. These are the same numbers `toItem()` surfaces as `trust`, so the ranking agrees with what the wire reports. An empty query ranks by this rather than by recency, and excludes entries with no settlements |
| Seller tags | Demo seller endpoints carry tags so keyword-shaped queries reach them |

Order matters and is enforced: expansion runs **before** stemming, because the
synonym map is keyed on whole words — stemming first would look up `convers`
and miss `conversion`.

**Evaluation methodology — it exists** ([`docs/search-eval.md`](./search-eval.md)):
**10 ground-truth queries, last measured 10/10**, each row naming the mechanism
it exercises so a regression identifies its own cause rather than only its
existence. Executed by `npm test` via `src/catalog.test.ts` → *"search quality
— synonyms, stemming, trust ranking"*, so a ranking regression fails the build.
Two properties beyond top-1 are covered by tests rather than the table: one
query must reach **two** distinct endpoints through two different mechanisms,
and an empty query must rank by trust rather than recency.

That document states its own limits, and they are real: the set is
**hand-authored against the demo catalog (8 endpoints on `vellar-seller-demo`)**,
so it measures one seller's demo. There is **no NDCG and no MRR** — top-1
correctness on a fixed set is a regression gate, not a quality metric.

The RFP names this its highest-weighted requirement and the one existing
catalogs most often leave unimplemented:

> "Search quality is a deliverable, not a detail: this means real ranking, and
> submissions must describe both their retrieval approach and how they will
> evaluate result quality over time. It is the hardest part of the scope and the
> part existing catalogs most often leave unimplemented."

**We are not claiming it is done.** Against that bar, what exists is a
deterministic, testable baseline with a regression gate: it returns sensible
results for keyword-shaped queries and degrades predictably for conceptual
ones. Before `969a56c`, a query sharing no literal or synonym token with any
listing returned **nothing at all**, not a weak ranking but an empty list. That
was the failure mode semantic retrieval exists to fix, and the vector half now
fixes it: all ten semantic queries return a relevant result. What remains is
where they rank.

**Pre-mainnet plan:**

- ~~Add semantic embeddings and a vector ranking.~~ **Done** in `969a56c`:
  Voyage AI `voyage-code-3`, 1024 dimensions, stored per catalog entry, fused
  with the lexical ranking by RRF. Cosine similarity over an in-memory cache
  rather than an HNSW index, which is adequate at this catalog size and keeps
  `search()` synchronous so a Voyage outage degrades ranking instead of hanging
  the endpoint.
- **Improve top-1 accuracy.** Five of ten semantic queries reach the top 3 but
  not first place. This is a reranking problem, not a retrieval one, so more
  embedding coverage will not fix it.
- Extend the eval harness beyond one seller's catalog and beyond top-1, with
  documented metrics (**NDCG** or **MRR**) and a published floor that gates the
  build — the shape `docs/search-eval.md` already has, at a scale that measures
  quality rather than only regression.
- Document the **quality-tracking process** so ranking regressions are caught
  before deployment, not after.
- **Target: complete before mainnet launch, not after.**

This is scoped as a pre-mainnet engineering commitment, not a post-launch
nice-to-have. It sits alongside §6.2 (no pubnet deployment) as work that must
land before a mainnet tag.

### 6.4 Deployed build predates this branch — ✅ CLOSED 2026-09-03

**Closed.** PR #79 merged to `main` as `128b566` and Render auto-deployed it.
`GET /health` now reports `"commit": "128b566"`, confirmed live on 2026-09-03.

The live instance therefore now carries the EXTENSION-RESPONSES header (RFP gap
#2), the MCP compound key (gap #3), the `verified_only` work (G-9), this
conformance report (gap #4), and the search-ranking commitment (gap #1).

Two notes on what that does and does not change:

- The §3 wire-level captures above were taken against `e4ec7f4` and were
  re-checked against `128b566` after the deploy: `/supported` still advertises
  `stellar:testnet` only, both schemes, `areFeesSponsored: true` on each; and
  `POST /settle {}` still returns `400` with **no** `extension-responses`
  header, which is the correct behaviour — the header is set only on paths that
  actually reach cataloging, never on an early exit.
- Nothing here changes §6.1 (e2e suite not run), §6.2 (no pubnet deployment) or
  §6.3 (lexical search). Those remain open.

## 7. Reproduction instructions

No assumed knowledge. Every step below was executed to produce this document.

### 7.1 Verify the live endpoints (no wallet needed, ~2 minutes)

The service is on a free tier and may cold-start; allow up to 60s on first call.

```bash
BASE=https://vellar-facilitator.onrender.com

# Which commit is serving, and is it healthy?
curl -sS --max-time 150 "$BASE/health" | python3 -m json.tool

# C2: does /supported carry areFeesSponsored, and which networks?
curl -sS "$BASE/supported" | python3 -m json.tool

# C6: is there a non-null reason on a rejection, with the x402 required fields?
curl -sS -X POST "$BASE/settle" -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool
curl -sS -X POST "$BASE/verify" -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool

# Discovery, including the partialResults flag
curl -sS "$BASE/discovery/resources?limit=2" | python3 -m json.tool
curl -sS "$BASE/discovery/search?query=quote&limit=2" | python3 -m json.tool
```

### 7.2 Verify the settled transactions independently

These read Horizon directly. They do not trust this repository or this
facilitator.

```bash
# exact, testnet
curl -sS https://horizon-testnet.stellar.org/transactions/1da6f9e6a90b78da898c99dfefba8821b5f632b72f584968fb057fd8a298e039 \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['successful'],d['ledger'],d['fee_account'],d['fee_charged'])"

# upto, testnet
curl -sS https://horizon-testnet.stellar.org/transactions/be72877332bbd7f8d38511cccf00620fb20869cfedbc7530588ca856ac646d9a \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['successful'],d['ledger'],d['fee_account'])"
```

A `fee_account` different from the payer is the sponsorship claim, on-chain.

### 7.3 Verify the `upto` contract build reproducibly

```bash
cd contracts/upto-stellar
stellar contract build          # rustc 1.96.0 / stellar-cli 26.1.0 / wasm32v1-none
shasum -a 256 target/wasm32v1-none/release/x402_upto_stellar.wasm
# expect c276b905981eab91704ce9b9046ebb4867b164dd7e4ba0e0ecda841527d398a9

stellar contract fetch --id CDHPA64M73TUTEM4MMHIWIXINBQXH7JJXFGZMGH22VJWFJFROMR6QV2S \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" --out-file fetched.wasm
shasum -a 256 fetched.wasm       # expect the same hash
```

### 7.4 Run the x402 e2e suite yourself (requires funded wallets)

```bash
git clone https://github.com/x402-foundation/x402.git
cd x402/e2e
pnpm install:all
cp .env-local .env
```

Fill in, per `e2e/README.md` → "Stellar Testnet":

1. Create three keypairs at <https://lab.stellar.org/account/create>, funding
   each with Friendbot.
2. Add a USDC trustline to the **client** and **server** accounts.
3. Fund the client with testnet USDC from <https://faucet.circle.com/>.

Set `SERVER_STELLAR_ADDRESS`, `CLIENT_STELLAR_PRIVATE_KEY`,
`FACILITATOR_STELLAR_PRIVATE_KEY`, then:

```bash
FACILITATOR_URL=https://vellar-facilitator.onrender.com \
  pnpm test --testnet --min --families=stellar --versions=2
```

Confirm your wallets are picked up before running the full suite:

```bash
npx tsx scripts/ci-select-families.ts   # should print: stellar
```
