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
> [`docs/security-audit.md`](./docs/security-audit.md) for every finding, its
> status, and the go/no-go. Mainnet is now gated on two *deployment* facts rather
> than on code: a persistent disk (the free tier has none, so catalog ownership
> bindings do not survive a restart) and a funded pubnet sponsor account. Running
> it is documented in [`docs/operator-runbook.md`](./docs/operator-runbook.md).

## What it does

| Endpoint | Purpose |
| --- | --- |
| `POST /verify` | Verify a payment by re-simulation on Soroban RPC (runs the payer's `__check_auth`, including any on-chain spending policy) |
| `POST /settle` | Submit the payment on-chain, sponsoring the network fee — buyers hold only the payment asset, no XLM |
| `GET /supported` | Advertise scheme/network/extensions/signers to sellers |
| `GET /discovery/resources` | List cataloged x402 resources (filters: `type`, `payTo`, `scheme`, `network`, `extensions`, `verified_only`; `limit`/`offset`) |
| `GET /discovery/search` | Keyword search over the catalog — tokenized and relevance-scored, not semantic (`query`, same filters, cursor-paginated) |
| `GET /health` | Liveness, plus `catalogFrozen` when the catalog has stopped accepting new bindings |

**Smart accounts welcome.** Policy-governed smart-account payments cost ~130k
stroops of simulation fee (the policy contract runs inside `__check_auth`);
hosted facilitators defaulting to a 50k ceiling reject them. This facilitator
defaults to **500,000** (`MAX_TX_FEE_STROOPS`) — the exact bug that motivated
this project, fixed from day one. That default is sized from measured on-chain
data, not guessed: the worst real settlement observed on this sponsor's history
charged **127,808** stroops, so 500,000 clears it by ~3.9x while bounding
worst-case sponsor drain per settle at 0.05 XLM.

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
  may include a base loaded from `CATALOG_FILE`, which has no independent source
  of truth; `observedSettlements` counts only what this process witnessed. If you
  need a number you can rely on, use that one.
- **Verification verdicts read `"unknown"` unless `VERIFICATION_API_URL` is set**,
  and `?verified_only=true` then returns an empty list. That is the honest
  default, not a fault — see F4-ts in the audit for why it is deliberately
  unconfigured.

## Integration limits

Worth knowing before you point a client at it:

| Limit | Value |
| --- | --- |
| Rate limit | 60 requests/min per IP (`/health` exempt) |
| Request body | 32 KiB, applied to every route |
| `/settle` refusals | `503 settlement_refused` with a `reason` — `sponsor_balance_low`, `spend_ceiling`, `rate_limited_payto`, `rate_limited_url`, `unbound_pool_exhausted` |

Refusals are deliberately loud and carry a reason. Spend controls are **log-only
on testnet and enforced on pubnet**, so a testnet client will see them in logs
before it ever sees a 503.

**On the hosted instance, the catalog is only as durable as the container.**
Render spins a free service down after 15 minutes without traffic, and spin-down
destroys the filesystem holding the catalog — so an idle period empties it and
resets URL ownership bindings. A keep-alive keeps it warm between deploys
(`.github/workflows/keepalive.yml`); durable storage is scoped in
[`docs/milestone-durable-catalog.md`](./docs/milestone-durable-catalog.md). Your
listing returns automatically on your next settled payment either way.

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

Tests and typecheck:

```sh
npm test        # includes wire-conformance tests using the unmodified
                # canonical HTTPFacilitatorClient + withBazaar client
npm run typecheck
```

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

## End-to-end examples

`examples/` contains the full loop, live-verified on testnet:

- **`seller.mjs`** — an Express API with one paid route that declares the
  bazaar discovery extension (price, input schema, output example).
- **`buyer.mjs`** — an agent pays it from a Vellar smart account with an
  ed25519 session key (V1 credentials), echoing the discovery extension so
  the facilitator catalogs the resource on settlement.

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
