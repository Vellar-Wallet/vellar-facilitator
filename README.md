# vellar-facilitator

An x402 payment facilitator for Stellar with **Bazaar discovery** — verify and
settle HTTP-402 payments for any seller, and let agents find payable resources
without hardcoded integrations.

> **Status: working on testnet, pre-production.** The full loop is live-proven
> (see `docs/decisions.md` for transaction hashes): a policy-governed Soroban
> smart account paid a Bazaar-discoverable resource, this facilitator verified
> and settled it on-chain, and the resource became searchable automatically.
> Mainnet use is gated on the security review (BUILD-PLAN Phase 3).

## What it does

| Endpoint | Purpose |
| --- | --- |
| `POST /verify` | Verify a payment by re-simulation on Soroban RPC (runs the payer's `__check_auth`, including any on-chain spending policy) |
| `POST /settle` | Submit the payment on-chain, sponsoring the network fee — buyers hold only the payment asset, no XLM |
| `GET /supported` | Advertise scheme/network/extensions/signers to sellers |
| `GET /discovery/resources` | List cataloged x402 resources (filters: `type`, `payTo`, `scheme`, `network`, `extensions`; paginated) |
| `GET /discovery/search` | Natural-language search over the catalog (`query`, cursor-paginated) |
| `GET /health` | Liveness |

**Smart accounts welcome.** Policy-governed smart-account payments cost ~140k
stroops of simulation fee (the policy contract runs inside `__check_auth`);
hosted facilitators defaulting to a 50k ceiling reject them. This facilitator
defaults to 2,000,000 (`MAX_TX_FEE_STROOPS`) — the exact bug that motivated
this project, fixed from day one.

**Bazaar catalogs itself.** When a payment settles and its payload carries the
official [`bazaar` discovery extension](https://www.npmjs.com/package/@x402/extensions),
the resource is upserted into the catalog automatically — no registration
step. Catalog-on-settle keeps unpaid spam out; route templates and service
metadata are validated/sanitized by the official extractor (catalog-poisoning
guard).

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
