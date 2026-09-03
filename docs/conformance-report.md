# Conformance report — x402 `exact` and `upto` on Stellar

**Facilitator:** `https://vellar-facilitator.onrender.com`
**Report date:** 2026-09-03
**Status:** partial — see [§6 Known gaps](#6-known-gaps). Two of the RFP's
conformance line items are **not yet satisfied** and are named plainly below.

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
| C1 | An unmodified canonical client completing a payment end to end on both networks | ⛔ **not done** — see §6.1 |
| C2 | `/supported` emitting the Stellar `extra` contract including `areFeesSponsored` | ✅ verified live, §3.1 |
| C3 | The spec `payload: {transaction}` format accepted verbatim | ✅ verified live, §3.2 / §5 |
| C4 | A passing run of the x402 repo's e2e suite for both networks | ⛔ **not done** — see §6.1 |
| C5 | A published settled transaction hash per network per scheme | ⚠️ **testnet only** — §4, §5. Pubnet: §6.2 |
| C6 | A non-null `reason` on every rejection | ✅ verified live, §3.3 |

This document is that artifact. Every claim in it is either a live response
captured from the running service, or a transaction hash independently
re-verified against Horizon at the time of writing — not quoted from an
internal document. Where something is not done, it says so and names the
blocker.

## 2. Facilitator under test

| | |
|---|---|
| Live URL | `https://vellar-facilitator.onrender.com` |
| Commit serving | `e4ec7f4` (from `GET /health`) |
| Networks advertised | `stellar:testnet` **only** — no `stellar:pubnet` |
| Schemes advertised | `exact`, `upto` |
| Extensions | `bazaar` |
| Channel pool | 50 accounts, 50 available at capture |
| Catalog size | 12 entries |
| Signers advertised | 51 (50 channel accounts + sponsor) |

> **Note on the commit under test.** `e4ec7f4` is the deployed `main` build. It
> predates the fixes on `fix/rfp-gap-report-1-2-3` (EXTENSION-RESPONSES header,
> MCP compound key). Those are **not** exercised by this report; the results
> below describe what a reviewer hitting the live URL sees today.

## 3. Live wire-level checks (`exact`, testnet)

All captured 2026-09-03 against the live URL.

### 3.1 `GET /supported` — C2 ✅

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

The RFP asks for the `upto` scheme to be **authored** as
`scheme_upto_stellar.md` and contributed upstream via the x402 Technical
Steering Committee. **That has not been done.** Vetting and independently
rebuilding someone else's contract is a materially different claim from
authoring the spec, and this report does not conflate them. Upstreaming through
the TSC is the next step and remains outstanding.

### 5.2 Known `upto` limitation

`upto` settlement is **not wired into the channel-account pool**
(`src/upto.ts`). It uses the sponsor account's sequence number directly, so
concurrent `upto` settlements can fail with `txBadSeq`. It is marked
EXPERIMENTAL in code, pending the upstream wire format stabilising
(x402-foundation/x402 PR #3134). `upto` should not be described as
production-ready.

## 6. Known gaps

### 6.1 The x402 e2e suite has not been run — C1, C4 ⛔

**Suite location and command, confirmed:**

- Repo: `https://github.com/x402-foundation/x402` (HEAD `626df07` at the time of writing)
- Suite: `e2e/`, entrypoint `e2e/test.ts`, run with `pnpm test` from `e2e/`
- Stellar catalog: `e2e/config/mechanisms_stellar.json`, declaring routes
  `/exact/stellar` and `/exact/stellar/upfront` (scheme `exact`, `sdks:
  ["typescript"]`, extension `bazaar`), with `testnet` (`stellar:testnet`) and
  `mainnet` (`stellar:pubnet`) both defined
- Targeting an external facilitator: the resource server reads `FACILITATOR_URL`
  from the environment (`e2e/src/server-env.ts:70`), so the live URL can be used
  directly without writing a proxy

**Why it was not run.** The suite requires three funded Stellar testnet accounts
— client, server, facilitator — declared `required: true` in the catalog:

```
SERVER_STELLAR_ADDRESS
CLIENT_STELLAR_PRIVATE_KEY
FACILITATOR_STELLAR_PRIVATE_KEY
```

Per `e2e/README.md`, the client and server accounts additionally need a **USDC
trustline** and **testnet USDC from the Circle faucet**; the facilitator account
needs XLM only.

This repository holds only `SPONSOR_SECRET_KEY`. The harness gate was run to
confirm the blocker empirically rather than assume it:

```
$ npx tsx scripts/ci-select-families.ts
No protocol families have all required wallet secrets configured.
Set variables in e2e/.env or export them in your shell.
```

**This is an environment gap, not a defect in the facilitator** — but it is
also not evidence of conformance, and it is the single most load-bearing item
the RFP asks for. It cannot be closed by any amount of internal testing.

**Plan to close.** Provision three dedicated Stellar testnet accounts, add USDC
trustlines to client and server, fund the client from the Circle faucet, then:

```bash
cd e2e && cp .env-local .env    # fill in the three STELLAR keys
FACILITATOR_URL=https://vellar-facilitator.onrender.com \
  pnpm test --testnet --min --families=stellar --versions=2
```

Capture the full output verbatim into §3 of this document.

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

### 6.3 Deployed build predates this branch

The live instance serves `e4ec7f4`. The EXTENSION-RESPONSES header (RFP gap #2)
and MCP compound key (gap #3) are on `fix/rfp-gap-report-1-2-3` and are not
reflected in the live results above. Re-run this report after that branch
deploys.

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
