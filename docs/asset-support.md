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

## Live payability check

Ownership verification answers "is this listing theirs"; this answers "can
they be paid right now". For each `accepts` entry, the facilitator checks
whether that entry's `payTo` currently holds what it would take to receive
the priced asset, so a buyer can be warned before a settlement that would
fail on-chain for a reason that has nothing to do with who owns the listing.

The check is per-`accepts`-entry, three-valued, and never collapses to a
single flag:

| Verdict | Meaning |
| --- | --- |
| `payable` | This specific accepts option can be paid right now. |
| `not_payable` | A classic account's trustline for this asset is missing or unauthorized. |
| `unknown` | The check could not be completed (Horizon/RPC timeout or error) — never read as proof of either side. |

`unknown` is never rendered as `not_payable`. A check this deployment could
not perform is not evidence that a merchant cannot be paid.

Surfaced on the wire as `trust.acceptsPayability`, index-aligned with
`accepts` — the same shape as `trust.acceptsVerification`:

```json
{
  "resource": "https://api.example.com/forecast",
  "accepts": [{ "scheme": "exact", "asset": "CBIELTK6…", "payTo": "GABC…" }],
  "trust": {
    "acceptsPayability": ["payable"]
  }
}
```

### How each payTo/asset shape is checked

- **A classic (`G…`) `payTo`, any asset.** Every asset in a payment
  requirement is a Stellar Asset Contract (SAC) id, never a raw classic
  asset — so the check first resolves the SAC to its classic identity via a
  read-only simulated `name()` call (every SAC exposes this per SEP-41; it
  returns `"CODE:ISSUER"`, or the literal string `"native"` for the
  native-asset SAC). The classic identity is then checked against Horizon's
  trustline data for that account: present and `is_authorized: true` →
  `payable`; absent, or present but unauthorized → `not_payable`.
- **Native XLM, a classic (`G…`) `payTo`.** No trustline concept applies —
  `payable` whenever the account exists on the ledger at all.
- **A contract (`C…`) `payTo`, any asset.** A contract holding a SAC balance
  needs no classic trustline at all — `payable` immediately, no Horizon call.
- **A non-SAC Soroban token** (the simulated `name()` call fails, or returns
  something not shaped like a SEP-41 asset name) **→ `unknown`**. The
  facilitator has no registry of token contracts to fall back on, matching
  this document's own "no allowlist" stance for the asset filter above.

A SAC's resolved classic identity is cached permanently per asset — it is a
structural fact about the contract (what asset does it wrap), not live state
that can go stale. The per-`(payTo, asset)` payability verdict itself is
cached with a TTL: 5 minutes for a resolved `payable`/`not_payable` verdict,
30 seconds for `unknown` — a failed check is not held anywhere near as long
as a real answer, so a transient Horizon blip clears quickly rather than
masking a real trustline for minutes.

### `payable_only` filter

`GET /discovery/resources` and `/discovery/search` both accept
`?payable_only=true`. Unlike `verified_only`, there is no deployment-level
"unavailable" state to refuse against here — Horizon and RPC endpoints are
always derived from the configured network, with no unconfigured case — so
`payable_only` is never refused with a 400. It prunes `not_payable` accepts
entries from each listing's `accepts` array (keeping `payable` and `unknown`
ones, with their verdict still visible) and drops a listing entirely only
when nothing payable or unknown remains. `pagination.total` is adjusted to
match, same discipline as `verified_only`.

## Mainnet roadmap

The following USDT0 integrations are scoped for the mainnet launch, not the
current testnet deployment.

### Channel pool trustlines

The 50 channel accounts that handle concurrent settlements currently hold only
USDC trustlines. Before USDT0 settlements can process on mainnet, each channel
account must open a USDT0 trustline. This is a one-time setup step at mainnet
launch.

### Clawback guard (trust signal)

USDT0 has `auth_clawback_enabled` set by Tether. A seller who accepts USDT0 and
has their balance clawed back before using it has no recourse. The facilitator
will surface a clawback warning in the Bazaar listing when a seller's
`payTo` address is accepting a clawback-enabled asset — giving buyers a visible
trust signal before paying.

This is **informational, not enforcement**. The facilitator remains
non-custodial and asset-agnostic at settle time.

### USDT0 payment path in WebMCP

The `vellar-webmcp` `pay_and_call` tool currently funds throwaway wallets with
USDC only. A USDT0 payment path — acquiring USDT0 via the Stellar DEX instead of
USDC — will allow agents to pay USDT0-only endpoints autonomously through
WebMCP.

### Cross-chain payer support

USDT0 maintains a unified supply across 26+ networks via LayerZero's OFT
standard. A payer on Ethereum, Base, or Arbitrum holds the same USDT0 that lands
on Stellar. Cross-chain payer support — where an agent originating on another
chain can pay a Vellar-listed endpoint that settles on Stellar — is a
longer-term integration dependent on mainnet deployment and LayerZero routing
being stable on Stellar.
