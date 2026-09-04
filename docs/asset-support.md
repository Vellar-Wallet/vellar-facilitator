# Asset Support

The Vellar Facilitator is **asset-agnostic at settle time** — it does not enforce
which assets are valid, and it maintains no allowlist. Any SEP-41 token a seller
declares in their payment requirements will settle. That is a deliberate design
decision, recorded in [`docs/security-audit.md`](./security-audit.md) (F2): an
asset allowlist was evaluated and judged unnecessary given the ownership binding.

What the Bazaar catalog surfaces is therefore **descriptive, not prescriptive**:
it reports which assets sellers have actually chosen to accept, derived from real
settlement history. Nothing on this page is an endorsement of an asset, and
nothing here restricts one.

## USDC

The primary payment asset on both networks, and the default in this repo's own
examples and in `@x402/stellar`.

| | |
|---|---|
| Testnet SAC | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| Mainnet SAC | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| Decimals | 7 |

USDC does not have clawback or revocability enabled.

## USDT0

USDT0 is Tether's LayerZero OFT-standard stablecoin on Stellar mainnet. It
maintains a unified supply backed 1:1 by USDT on Ethereum, so USDT can move
across networks without fragmenting supply.

| | |
|---|---|
| Mainnet SAC | `CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF` |
| Classic asset | `USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q` |
| Testnet | **Not available** — USDT0 is mainnet only |

> **IMPORTANT — clawback and revocability.**
>
> USDT0 sets `auth_revocable` and `auth_clawback_enabled`. This means Tether (the
> issuer) can revoke a trustline or claw back a balance from any account holding
> USDT0.
>
> Note: the issuer account `GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q`
> has no `home_domain` set, so there is no on-chain SEP-1 `stellar.toml` linking
> this account to Tether. The attribution to Tether rests on off-chain reputation
> and the LayerZero/USDT0 documentation, not on-chain proof.
>
> The Vellar Facilitator is **non-custodial**: payments flow directly from the
> payer to the seller's `payTo` address, and the facilitator's sponsor key is
> used only to pay the network fee (it is passed solely as `feeBumpSigner` and is
> never a settlement source account — see `src/facilitator.ts`). The facilitator
> never holds USDT0, or any other asset, on anyone's behalf.
>
> **The clawback risk therefore sits entirely with the seller, not with Vellar.**
> Sellers should understand this property before accepting USDT0 as payment.
>
> USDC does not carry this risk.

Verified against Stellar mainnet Horizon on 2026-09-04:

- `auth_revocable`: **true**
- `auth_clawback_enabled`: **true**
- `auth_required`: **false**
- Contract `CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF` confirmed as
  a genuine SAC (`contractExecutableStellarAsset`, not custom wasm),
  cryptographically bound to
  `USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q` via on-ledger
  `AssetInfo` decoding.

## Querying by asset

`GET /discovery/resources` accepts an optional `asset` query param that keeps
only listings with at least one `accepts` entry for that exact asset:

```
GET /discovery/resources?asset=CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF
```

Returns only listings that accept USDT0 as payment.

Details worth knowing:

- **Exact, case-sensitive** string match. Stellar contract addresses are base32
  and case-sensitive; a lowercased address matches nothing.
- **Combines with the other filters as AND**, not a union — `?asset=X&network=Y`
  returns only listings satisfying both conditions.
  <br>One subtlety, matching how the existing `payTo` / `scheme` / `network`
  filters already behave: each filter is applied independently across a
  listing's `accepts` array, so the two conditions may be satisfied by
  *different* accepts entries. A listing accepting USDC-on-testnet and
  USDT0-on-pubnet matches `?asset=<USDT0>&network=stellar:testnet`. If you need
  a single accepts entry satisfying both, intersect client-side — the response
  carries the full `accepts` array for exactly that purpose.
- **Validated at the route.** An empty value, one containing whitespace or
  control characters, or one longer than 56 characters is refused with
  `400 {"error": "invalid_asset"}`. A well-formed-looking 56-character string
  that is not a real asset is accepted and simply matches nothing — the
  facilitator has no registry of legitimate assets to check against, and
  pretending otherwise would imply an allowlist that does not exist.
- **Not available on `/discovery/search`**, which is deliberately out of scope.

`GET /supported` returns `catalogAssets` — the live set of assets present in the
catalog, grouped by network:

```json
{
  "kinds": [ /* … x402 spec fields, unchanged … */ ],
  "extensions": ["bazaar"],
  "signers": { "stellar:*": [ /* … */ ] },
  "catalogAssets": {
    "stellar:testnet": ["CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"],
    "stellar:pubnet": []
  }
}
```

Both network keys are always present, even when empty, so a client can read
`catalogAssets["stellar:pubnet"]` without a presence check. The set is derived at
request time from the catalog itself — a new asset appears automatically once a
real settlement catalogs a listing that accepts it, with no config change and no
deploy.
