# vellar-facilitator

An x402 payment facilitator for Stellar with **Bazaar discovery** — verify and
settle HTTP-402 payments for any seller, and let agents find payable resources
without hardcoded integrations.

> **Status: working on testnet, pre-production.** The full loop is live-proven
> (see [`docs/decisions.md`](./docs/decisions.md) for transaction hashes): a
> policy-governed Soroban smart account paid a Bazaar-discoverable resource, this
> facilitator verified and settled it on-chain, and the resource became
> searchable automatically.
>
> **The pre-mainnet security review is complete** — see
> [`docs/closing-state.md`](./docs/closing-state.md) for every finding with its
> final status, and [`docs/security-audit.md`](./docs/security-audit.md) for the
> detail. Running it is documented in
> [`docs/operator-runbook.md`](./docs/operator-runbook.md).

## Two things to know before you evaluate the hosted instance

Both are properties of *this deployment*, not of the code, and both are more
surprising to find by experiment than to be told.

**1. First request after idle takes ~45 seconds, at any hour.** Render spins a
free service down after 15 minutes without traffic and the container is
replaced, not paused; measured cold start **44.76 seconds**. You pay it once —
the service then stays warm for 15 minutes past your last request.

The warm-window story, honestly: the original */5 keep-alive cron was retired
2026-08-15 on delivery measurement — GitHub's scheduler ran it at 18–52 minute
gaps against a 15-minute idle timeout, so it spent pool hours on a coin flip.
Since 2026-08-21 a narrower **best-effort keep-warm cron**
(`.github/workflows/keep-warm.yml`) pings every 10 minutes during reviewer
hours only (07:00–21:00 UTC, weekdays — the widest window that fits the
shared free-tier pool for two services with real margin, see the workflow's
own header for the math) — margin against the timeout, **not a
guarantee**, for exactly the measured reason above; outside those hours, and
whenever a ping slips, the cold start applies. **The instance remains on the
free tier** (a paid always-on move was approved and rescinded for budget the
same day; `render.yaml` carries the ready-to-apply config behind a loud billing
warning). So: still assume the ~45s cold start unless you are inside the
warmed window. History: [`using-it.md` § About the cold
start](./docs/using-it.md#about-the-cold-start--there-is-no-warm-window).

The catalog survives either way: it lives in libSQL/Turso rather than on the
container, so your listings and ownership bindings are there when it wakes.

**2. THE TRUST LAYER IS INERT HERE. Every verification badge reads `"unknown"`,
and `?verified_only=true` is refused with an explicit 400.** Not a bug and not
misconfiguration:

```json
"trust": { "verification": "unknown", "acceptsVerification": ["unknown"], … }
```

The verdicts come from a **verification API that is deployed nowhere**, and this
is a **deliberate deferral with a known dependency chain**, not an oversight or a
missing config value:

```
  trust badges  ←  a verdict source
                     ←  worker-service deployed        (needs a Docker host)
                          ←  ATTESTOR_SECRET_KEY       (needs an attestor)
                               ←  M5 multisig design   (unresolved)
```

Each link is blocked by the one below it, and the bottom one is a design decision
in the wallet repository, not a deployment task here. **Nothing about this is
switching on soon**, and it will not be switched on to produce testnet badges —
turning it on for a demo would mean standing up a Docker host and minting an
attestor key ahead of the multisig design that is supposed to govern it, which
inverts the thing the attestor exists for.

So `VERIFICATION_API_URL` is deliberately unset, and every verdict degrades to
`"unknown"` — the honest default, since the alternative is asserting a trust
level nothing backs. Tracked as **F4-ts**.

Two prerequisites are being done in the wallet repo regardless, because they are
defects in the API's design rather than in its deployment: **per-record
timestamps** (the current response has none, so "newest verdict" falls back to
array order) and **endpoint authentication** (it is unauthenticated, which would
make it a trust root anyone could impersonate). Neither produces a badge here;
both must be true before one would be worth trusting.

**What this does NOT mean.** Two different things in that block are called
"verified", and only one of them is inert:

| Field | State here | What it is |
| --- | --- | --- |
| `verification`, `acceptsVerification` | **inert — always `"unknown"`** | Third-party attestation of the *payee*, from the absent API |
| `ownerVerified` | **working, proven live** | Whether the resource's own 402 challenge names its bound `payTo` — fetched by this facilitator, no external service involved |

So ownership verification works and is enforced; *reputation* verification is
switched off. If you filter on `verified_only`, you are asking about the inert
one, and the API now says so instead of pretending: a 400 with
`verified_only_unavailable` and a pointer at `ownerVerified`.

That refusal replaced an older, worse behaviour: a silent `items: []` — a
correct-looking answer to a question this deployment cannot answer, which read
as "nothing here is verified" when the truth was "nothing is being checked".

## What it does

| Endpoint | Purpose |
| --- | --- |
| `POST /verify` | Verify a payment by re-simulation on Soroban RPC (runs the payer's `__check_auth`, including any on-chain spending policy) |
| `POST /settle` | Submit the payment on-chain, sponsoring the network fee — buyers hold only the payment asset, no XLM |
| `GET /supported` | Advertise scheme/network/extensions/signers to sellers, plus `catalogAssets` — the live set of assets the catalog actually holds, grouped by network |
| `GET /discovery/resources` | List cataloged x402 resources (filters: `type`, `payTo`, `scheme`, `network`, `extensions`, `asset`‡, `verified_only`†; `limit`/`offset`) |
| `GET /discovery/search` | Keyword search over the catalog — tokenized and relevance-scored, not semantic (`query`, same filters, cursor-paginated) |
| `GET /health` | Liveness, plus the deployed `commit`, `uptimeSeconds`, `catalogSize`, `catalogFrozen` when bindings are frozen, and `unverifiableEntries` when any seller advertises an address the facilitator cannot fetch |

† `verified_only` is **refused with a 400** (`verified_only_unavailable`) on
this deployment. The verdicts it filters on come from a service that is deployed
nowhere — see *Two things to know* above — so an empty list would describe the
deployment, not the resources. `ownerVerified` is the field that works.

‡ `asset` filters listings to those accepting a given SEP-41 asset (exact,
case-sensitive match on the contract address). Discovery only — the facilitator
stays asset-agnostic at settle time and runs no allowlist.
[`docs/asset-support.md`](./docs/asset-support.md) covers USDC and USDT0,
including USDT0's clawback/revocability flags and why that risk sits with the
seller rather than a non-custodial facilitator.

**Smart accounts welcome.** Policy-governed smart-account payments cost ~130k
stroops of simulation fee (the policy contract runs inside `__check_auth`);
hosted facilitators defaulting to a 50k ceiling reject them. This facilitator
defaults to **500,000** (`MAX_TX_FEE_STROOPS`) — the exact bug that motivated
this project, fixed from day one. That default is sized from evidence that
carries its provenance ([`docs/decision-fee-thresholds.md`](./docs/decision-fee-thresholds.md)):
the most expensive verified reading is **140,331** stroops simulated for a
freshly provisioned policy-governed wallet (28,711 is the worst hash-verifiable
charge on-chain), so 500,000 clears it by ~3.6x while bounding worst-case
sponsor drain per settle at 0.05 XLM.

**Bazaar catalogs itself.** When a payment settles and its payload carries the
official [`bazaar` discovery extension](https://www.npmjs.com/package/@x402/extensions),
the resource is upserted into the catalog automatically — no registration
step. Catalog-on-settle keeps unpaid spam out; route templates and service
metadata are validated/sanitized by the official extractor (catalog-poisoning
guard).

**Discovery responses carry a `trust` block.** Alongside the standard resource
fields, each entry reports `settlements`, `uniquePayers` and `lastSettled`, plus
`verification` / `acceptsVerification` / `ownerVerified`. Two things to know
before you build on it:

- **`observedSettlements` and `statsSource` disclose provenance.** `settlements`
  may include a base loaded from durable storage, which has no independent source
  of truth — a settlement count cannot be re-derived from the chain. `statsSource`
  reads `"persisted"` when any part of it was inherited rather than witnessed, and
  `observedSettlements` counts only what this process saw. **If you need a number
  you can rely on, use that one.**
- **If you are a seller, advertise your PUBLIC address.** The `resource.url` in
  your 402 is what gets cataloged and what ownership verification re-fetches. A
  `http://localhost:…` value (the default in `examples/seller.mjs`) can never be
  verified — it is not https and not reachable — so your entry is served
  permanently unverified. `PUBLIC_BASE_URL` is how the example declares its real
  address; `/health` reports `unverifiableEntries` when any entry is in this state.
- **Verification verdicts read `"unknown"` on this deployment and
  `?verified_only=true` is refused with a 400** — see *Two things to know* at the top.
  `ownerVerified` is the field that does work here.

## Integration limits

Worth knowing before you point a client at it:

| Limit | Value |
| --- | --- |
| Rate limit | 60 requests/min per IP (`/health` exempt) |
| Request body | 32 KiB, applied to every route |
| `/settle` refusals | `503 settlement_refused` with a `reason` — `sponsor_balance_low`, `spend_ceiling`, `rate_limited_payto`, `rate_limited_url`, `unbound_pool_exhausted`, `pool_exhausted` (`retryable: true` — see docs/channel-pool-design.md §4) |

Refusals are deliberately loud and carry a reason. Spend controls are **log-only
on testnet and enforced on pubnet**, so a testnet client will see them in logs
before it ever sees a 503.

**The catalog survives a restart.** It used to not: the container's filesystem
went with every spin-down, taking listings and ownership bindings. Since
2026-08-11 the catalog is in libSQL/Turso, verified live across a 42-second cold
start with the binding intact. An empty catalog now means an empty catalog, not a
restart — if yours is missing, something else is wrong.

The keep-alive workflow's full arc, honestly: disabled at first for workspace
pool-budget reasons, **re-enabled 2026-08-11** against measured headroom,
**retired 2026-08-15** when measurement showed GitHub's cron delivery (18–52
minute gaps) could never beat the 15-minute idle timeout — hours spent, warmth
not delivered — and **partially revived 2026-08-21** as `keep-warm.yml`: every
10 minutes, reviewer hours only, documented as best-effort margin rather than
a warm-window promise, since GitHub's delivery is the same scheduler that
failed the measurement. The durable catalog had already removed half the
reason to want it; the real fix remains a paid always-on instance, which is
budgeted-not-bought as of 2026-08-15 (`render.yaml` holds the one-line change
and its price).

**Resource-URL ownership is trust-on-first-use.** The first settlement for a
canonical URL (`origin + pathname`) binds it to that payment's `payTo`; later
settlements with a different `payTo` are refused from the catalog, though the
payment itself still settles. If you are a seller, be the first to settle for
your own URL. Changing that address afterwards currently needs an operator —
see runbook §1.

## Run

```sh
npm install
cp .env.example .env   # set SPONSOR_SECRET_KEY (funded testnet account)
npm run dev            # http://localhost:4100
```

One-time setup, if you will be pushing branches:

```sh
git config core.hooksPath .githooks   # refuses pushes to a merged PR's branch
```

Tests and typecheck:

```sh
npm test        # includes wire-shape tests driven by the unmodified
                # canonical HTTPFacilitatorClient + withBazaar client
npm run typecheck
```

These are in-process tests against the canonical client library. They are **not**
the x402-foundation e2e conformance suite, which needs three funded Stellar
accounts and has not been run yet.
[`docs/conformance-report.md`](./docs/conformance-report.md) is the honest
scorecard: what is verified live against the hosted instance, the settled
transaction hashes re-checked against Horizon, and the gaps still open —
the e2e suite, a pubnet deployment, and semantic search ranking.

## MCP discovery server (for AI agents)

`src/mcp.ts` exposes the catalog as MCP tools (`x402_list_resources`,
`x402_search_resources`) over stdio, backed by the same HTTP API via the
official `withBazaar` client. Point any MCP client at it:

```json
{
  "mcpServers": {
    "vellar-x402-discovery": {
      "command": "npx",
      "args": ["tsx", "src/mcp.ts"],
      "cwd": "/path/to/vellar-facilitator",
      "env": { "FACILITATOR_URL": "http://localhost:4100" }
    }
  }
}
```

## Using it

**[`docs/using-it.md`](./docs/using-it.md)** — how to point at a running
facilitator, split by role:

- **Merchants** — what to change in your resource server, what your 402 must
  declare, the five requirements for ownership verification, and what the silent
  unverified case looks like.
- **Buyers/agents** — what you need on your side (and what the sponsor covers, so
  you know what you do *not* need to hold), discovery, and paying.

Plus what will bite you on the hosted instance, and who this is ready for.
[`docs/guide.md`](./docs/guide.md) is the different thing: running a facilitator
locally and walking the loop with both example scripts.

## End-to-end examples

`examples/` contains the full loop, live-verified on testnet:

- **`seller.mjs`** — an Express API with one paid route that declares the
  bazaar discovery extension (price, input schema, output example).
- **`buyer-classic.mjs`** — a plain Stellar keypair pays it, built entirely on
  the **official** x402 client (`@x402/stellar/exact/client` +
  `@x402/core/client`). ~12 lines of payment logic: no hand-assembled
  transaction, no hand-signed auth entry, no second funded account, and the
  discovery extension is echoed for you.
- **`buyer.mjs`** — an agent pays it from a Vellar smart account with an
  ed25519 session key (V1 credentials), echoing the discovery extension so
  the facilitator catalogs the resource on settlement. Hand-rolled by
  necessity: the official client cannot sign for a smart account
  ([`docs/upstream-issue-smart-accounts.md`](./docs/upstream-issue-smart-accounts.md)).

See [`docs/guide.md`](./docs/guide.md) for the walkthrough.

## Architecture

Composes the official Coinbase x402 packages rather than reimplementing the
protocol: `x402Facilitator` (`@x402/core`) orchestrates; `ExactStellarScheme`
(`@x402/stellar`) implements Stellar verify/settle; `@x402/extensions/bazaar`
supplies the discovery data model, validation, and canonical client. This
repo adds the HTTP service, correct Stellar configuration, the Bazaar catalog
(storage, filtering, search, persistence), auto-cataloging ingestion, the MCP
server, and the test suite. Full spec: [`technical-doc.md`](./technical-doc.md).

## Relationship to Vellar

Separate infrastructure from the [Vellar wallet](https://github.com/Vellar-Wallet/vellar-dapp)
and [vellar-sdk](https://github.com/Vellar-Wallet/vellar-sdk) (the x402
**payer** side). Any x402 client can use this facilitator — Vellar wallets and
non-Vellar wallets alike. Shared expertise, not shared code.

## License

Apache-2.0
