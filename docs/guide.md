# Developer guide — selling and buying through the Vellar facilitator

This walks the full x402 + Bazaar loop on Stellar testnet, exactly as
live-verified (settlement tx `a08dc6bf…`, see `docs/decisions.md`). Two
roles, two scripts, both in `examples/`.

> **This page assumes you are running the facilitator yourself, locally.** If you
> want to point an existing endpoint or client at one that is already running,
> read [`using-it.md`](./using-it.md) — organised by role (merchant / buyer),
> covering ownership verification and the hosted instance's rough edges.

## Prerequisites

- Node ≥ 20, `npm install` in both the repo root and `examples/`
- A funded testnet **sponsor** account (facilitator fee payer) — fund any new
  keypair at [friendbot](https://friendbot.stellar.org)
- A **payment asset**, a **merchant** account holding a trustline to it, and a
  funded **payer**. One command produces all three:

  ```sh
  cd examples && node provision-testnet.mjs
  ```

  There is no built-in test token and no faucet — the facilitator settles in
  whatever SEP-41 asset you name, so you bring your own. The demo seller's
  `X402TST` **cannot be acquired by anyone**: its issuer secret no longer
  exists. See [`using-it.md` § First: bring your own payment
  asset](./using-it.md#first-bring-your-own-payment-asset).

- A **payer signer**: a plain classic keypair (`buyer-classic.mjs`) or a Vellar
  smart account with an ed25519 session key (`buyer.mjs`, the "agent with a
  budget" pattern). Both are proven against this facilitator.

## 1. Start the facilitator

```sh
SPONSOR_SECRET_KEY=S... PORT=4100 CATALOG_DB_URL=file:./data/catalog.db npm start
```

Sanity: `curl localhost:4100/health`, then `curl localhost:4100/supported` —
you should see the `stellar:testnet` exact kind, `areFeesSponsored: true`,
and `extensions: ["bazaar"]`.

## 2. Sell something (seller.mjs)

A paid route needs two things: payment requirements, and (optionally but
recommended) a **bazaar discovery declaration** so agents can find it.

```js
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";

const coreServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL }))
  .register("stellar:testnet", new ExactStellarScheme())
  .registerExtension(bazaarResourceServerExtension);   // enriches declarations

const routes = {
  "GET /quote": {
    accepts: {
      scheme: "exact",
      payTo: MERCHANT_G_ADDRESS,
      network: "stellar:testnet",
      price: { asset: SEP41_CONTRACT_ID, amount: "1000000" },
      maxTimeoutSeconds: 120,
    },
    description: "Motivational quote of the day (paid)",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { topic: "perseverance" },
      inputSchema: { properties: { topic: { type: "string" } } },
      output: { example: { quote: "..." } },
    }),
  },
};
```

Run it:

```sh
cd examples
FACILITATOR_URL=http://localhost:4100 PAYTO=G... ASSET=C... PRICE_ATOMIC=1000000 node seller.mjs
```

`PAYTO` and `ASSET` are the values printed by `provision-testnet.mjs`. The
seller refuses to boot unless `PAYTO` is funded and holds a trustline to
`ASSET` — without it, payments verify and then fail at settlement with an error
that reads like a spend control refusing them.

An unpaid `GET /quote` returns `402` with a `PAYMENT-REQUIRED` header that
carries both the payment requirements and the (server-enriched) discovery
extension.

## 3. Buy it (buyer.mjs)

The buyer flow, condensed:

1. `GET` the resource → decode the `PAYMENT-REQUIRED` header.
2. Build the SEP-41 `transfer(from = your account, to = payTo, amount)`.
3. Sign the payer's auth entry (the examples sign with an ed25519 session
   key as V1 address credentials — the pattern proven against this
   facilitator; see `buyer.mjs` for the exact signing code).
4. **Echo `required.extensions` into the payment payload** — this is what
   lets the facilitator catalog the resource for discovery.
5. Retry with `PAYMENT-SIGNATURE: base64(paymentPayload)` → `200` + the
   content + the on-chain settlement hash.

```sh
cd examples

# Classic keypair — the smaller path, no extra dependencies.
RESOURCE_URL=http://127.0.0.1:4031/quote \
PAYER_SECRET=S... SIM_SOURCE_ACCOUNT=G... \
node buyer-classic.mjs

# Or a Vellar smart account, for an on-chain enforced budget.
RESOURCE_URL=http://127.0.0.1:4031/quote \
WALLET_CONTRACT_ID=C... AGENT_SECRET=S... SIM_SOURCE_ACCOUNT=G... \
node buyer.mjs
```

`SIM_SOURCE_ACCOUNT` must be a **different** account from the payer. The
facilitator rebuilds the transaction with itself as the source, so yours is used
only to simulate — but simulating from the payer yields source-account
credentials, which the scheme rejects
(`invalid_exact_stellar_payload_unsupported_credential_type`).

Expect to retry: roughly one settle in three fails on testnet with an empty
`transaction`. Nothing is spent when that happens.

## 4. Discover it

After one settled payment, the resource is in the catalog:

```sh
curl "localhost:4100/discovery/resources"                       # list + filters
curl "localhost:4100/discovery/search?query=motivational+quote" # ranked search
```

Each entry carries everything an agent needs to call AND pay for the
resource: URL, method, input schema, output example, and the exact payment
requirements (asset, amount, payTo, network).

Programmatic access uses the official client — no custom SDK needed:

```js
import { HTTPFacilitatorClient } from "@x402/core/http";
import { withBazaar } from "@x402/extensions/bazaar";

const bazaar = withBazaar(new HTTPFacilitatorClient({ url: FACILITATOR_URL })).extensions.bazaar;
const { items } = await bazaar.listResources({ network: "stellar:testnet" });
const { resources } = await bazaar.search({ query: "weather data" });
```

For AI agents, the MCP server (`src/mcp.ts`) exposes the same two operations
as MCP tools — see the README for client config.

> **Do not filter on `verified_only` here.** It returns an empty list on the
> hosted instance, and will on yours too unless you run your own verification
> API. The `verification` / `acceptsVerification` badges it filters on come from
> an external attestation service that is **deployed nowhere** (the wallet repo's
> worker-service, blocked on its M5 attestor), so every verdict degrades to
> `"unknown"` — the honest default rather than an asserted trust level nothing
> backs.
>
> **`ownerVerified` is the different field, and it does work.** It says whether
> the resource's own 402 challenge names the `payTo` the catalog has bound for it
> — checked by the facilitator itself, no external service involved. If you want
> a signal that a listing is not a squat, that is the one to read.

## Notes and sharp edges

- **Catalog-on-settle.** A resource enters the catalog only after a real
  payment settles for it. Verify-only traffic doesn't catalog (spam guard).
- **Catalog writes are one-way.** The entry is keyed by URL and there is no
  self-service removal. That is harmless here, because this page runs its own
  facilitator against a local database you can delete. It is **not** harmless if
  you point `FACILITATOR_URL` at the shared hosted instance while your seller is
  still on `localhost`: that leaves a permanently unverifiable public entry. See
  [`using-it.md` § Your first settlement writes to a shared
  catalog](./using-it.md#your-first-settlement-writes-to-a-shared-catalog-permanently).
- **Smart-account fees.** If your payer is policy-governed, the verify-time
  simulation runs the policy and the fee estimate lands well above a plain
  transfer. This facilitator's ceiling accommodates it by default; other
  facilitators may reject the same payment with `fee_exceeds_maximum`.
- **Ledger-based expiry.** Auth-entry signatures expire in ledgers (~5s
  each), not wall-clock time. The examples set current + 12; don't cache
  signed payloads.
- **Trustlines.** A classic merchant account must hold a trustline to the
  payment asset or settlement fails on-chain.
