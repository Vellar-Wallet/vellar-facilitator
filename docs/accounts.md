# Account inventory — what we depend on, and who holds the key

**The rule this file exists to enforce: every account this project depends on
gets a row here BEFORE anything is deployed against it.** Public keys only —
never a secret, never a hint of where inside a store a secret sits.

Why it exists, concretely: on 2026-08-14 the question "do we still control
`GBJX3E4G…`?" cost a morning of archaeology and the honest answer was *we don't
know* — which stalled the demo fix and forced the displacement path. Before
that, two demo asset issuers were burned without a record, each time leaving a
live public service advertising an asset nobody could ever obtain. All three
incidents are the same failure: an account was used without anyone writing down
what it was for and where its key went.

`custody` values: **held** (a named store), **external** (not ours, never was),
**burned** (destroyed on purpose — say when and why), **unknown** (the state
this file exists to abolish; anything `unknown` is a standing action item).

---

## Live — the service depends on these today

| Account | Role | Custody | Notes |
| --- | --- | --- | --- |
| `GBUCR6H22CZC5OYHBJIEUS2JFZBOB63AHEGTCV6UEPMD2TMLKG2ZMIW4` | **Hosted sponsor.** Signs fee-bumps for every settlement on `vellar-facilitator.onrender.com`; its XLM balance IS the service's availability (the balance guard refuses `/settle` below the hard floor) | **held** — Render env var `SPONSOR_SECRET_KEY` on the facilitator service | Testnet. Verified against live `/supported` 2026-08-14. Losing this key means redeploying with a new funded sponsor — an inconvenience, not a disaster, since it holds no user funds |
| `GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC` | **Demo merchant.** `vellar-seller-demo`'s `payTo`; receives the demo's USDC. Live USDC trustline | **held** — operator secret store (moved off the dev machine 2026-08-14) | Created 2026-08-13 to replace `GBJX3E4G…`. The seller only ever uses the public address; the secret has no runtime role |
| `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | **Testnet USDC issuer** (SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`) — the demo's payment asset | **external** — Circle (`home_domain centre.io`) | This is the point: the demo's asset issuer is **not ours to destroy**, which is what ends the burned-issuer pattern below. Balances come from the testnet DEX (`USE_USDC=1 node provision-testnet.mjs`) |

## Unresolved — action items wearing table rows

| Account | Role | Custody | Notes |
| --- | --- | --- | --- |
| `GBJX3E4GDO6IT5ZHWM5LVCXYCHN5L3HWZNKFHJMCR6JZJNBL3VVQL2RH` | **Former demo merchant.** Still the bound `payTo` of the hosted catalog's demo entry; holds 13 X402TST + ~10k XLM | **unknown** — no record of where its key went, and nobody has produced it | The account that motivated this file. If the key surfaces: record it here and it becomes a normal rotation. If it is confirmed gone: mark burned and the catalog binding can only move by displacement or runbook §1 |

## Burned — dead on purpose, recorded so nobody digs twice

| Account | Role | Custody | Notes |
| --- | --- | --- | --- |
| `GCS2VRHGJRLFCNM5Y74YJL63V2B3LYWYF5DZ4HHHZZUPWZYXMO4NIUOE` | **X402TST issuer** (SAC `CDYCX4PEXXTPIS67E7WPYM37UFCC5XW7QZX5LQ6UQBR65PQZWZ7HTBHR`) | **burned** — keypair generated in-process by a throwaway script, never persisted | Nobody can mint X402TST, ever. Any resource advertising this asset is permanently unpayable — this is what froze the demo listing (`diagnosis-demo-listing.md`) |
| `GBDZH5KZ…` / SAC `CBIN4HTP…` | The demo pair before that | **burned** — issuer destroyed during provisioning, noted 2026-08-10 in `seller.mjs`'s history | Same failure, one generation earlier. Two burned issuers in two months is why the live demo now uses an asset we cannot burn |

## Deliberately not tracked

- **Throwaway test accounts** printed by `provision-testnet.mjs` (issuer,
  merchant, payer, deployer, sim-source): per-run, testnet-only, and the script
  prints their secrets to the operator by design. Tracking them here would
  drown the accounts that matter. If one is ever promoted into a deployed
  service's config, it graduates to the Live table **first**.
- **The Vellar wallet WASM install** (`WALLET_WASM_HASH` in
  `provision-testnet.mjs`): a contract hash, not an account. Its rot mode is
  documented at the constant.

---

**Maintenance:** change a deployed service's env keys, create a demo account,
rotate or burn anything → update this file in the same PR. An entry here is
cheap; the archaeology it replaces was not.
