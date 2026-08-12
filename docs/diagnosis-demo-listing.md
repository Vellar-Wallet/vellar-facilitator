# Diagnosis — why the demo listing is permanently unverified

**2026-08-12. Diagnosis and one safe change; the fix itself is blocked on a
question only the operator can answer.**

The flagship catalog entry — `vellar-seller-demo` — reads
`ownerVerified: false` on the hosted instance. It is the first thing anyone
evaluating this project looks at, and it makes the ownership-verification
feature look broken.

**It is not broken. The entry is correct and would verify if it were ever
re-checked.**

---

## What was checked

| Check | Result |
| --- | --- |
| `GET https://vellar-seller-demo.onrender.com/quote` | `402` |
| `GET …/quote/` (trailing slash, as stored) | `402` |
| `PAYMENT-REQUIRED` header present and decodable | yes |
| Challenge `resource.url` | `https://vellar-seller-demo.onrender.com/quote` |
| Challenge `accepts[].payTo` | `GBJX3E4GDO6IT5ZHWM5LVCXYCHN5L3HWZNKFHJMCR6JZJNBL3VVQL2RH` |
| Catalog's bound `payTo` | `GBJX3E4GDO6IT5ZHWM5LVCXYCHN5L3HWZNKFHJMCR6JZJNBL3VVQL2RH` |

The bound address and the advertised address are **identical**, the URL is
public https, and it answers 402 with a valid header. Every precondition for
ownership verification is met.

The trailing slash was the initial suspicion and is a red herring: the canonical
key strips it, and both spellings return 402 anyway.

## The actual cause

The trust block gives it away:

```json
{ "settlements": 0, "observedSettlements": 0, "statsSource": "persisted",
  "ownerVerified": false }
```

`statsSource: "persisted"` means the entry was restored from durable storage
during the libSQL/Turso migration, carrying its stored `ownerVerified: false`
with it. And a failed verification **re-runs only on the resource's next
settlement** (after a 15-minute cooldown).

The resource advertises `CDYCX4PE…` — the dead **X402TST** asset, whose issuer
secret no longer exists. Nobody can obtain a balance, so nobody can pay it, so
there is never a next settlement.

```
  badge is false
    ← re-check only fires on the next settlement
        ← no settlement is possible
            ← the advertised asset cannot be obtained by anyone
```

Each link is blocked by the one below. Nothing here is a defect in the
verification logic; the retry trigger is simply unreachable for an unpayable
resource.

## The fix

Make one payment possible, then make it. The advertised asset has to change to
something obtainable — the natural choice is canonical testnet USDC
(`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`, which resolves to
`USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, 7 decimals,
`auth_required: false` so trustlines are permissionless).

**Which path depends on one unanswered question: is the secret for
`GBJX3E4G…` still held?** The account exists and is funded (9999.99 XLM, 13.0
X402TST), but the key's whereabouts is not recorded anywhere in this repo.

| | If the secret is held | If it is lost |
| --- | --- | --- |
| Merchant | Keep `GBJX3E4G…` | Use a merchant you control |
| Trustline | Add one to USDC on that account | Provision the new merchant with one |
| Binding | Untouched — `payTo` is unchanged | Transfers by **displacement** on first settlement |
| Operator involvement | none | none |

The displacement path works here specifically because this binding was **never
verified**. Runbook §1 is only required to move an already-verified binding.

Then: redeploy the demo with the new `ASSET` (and `PAYTO`, if changed), pay it
once, and the badge flips to `true` on that settlement.

## What changed here

`render.yaml` now sets `PAYTO` and `ASSET` explicitly on `vellar-seller-demo`.
They were unset, so the deployed public service silently inherited
`examples/seller.mjs`'s built-in defaults — an edit to a source default would
have changed what a public service advertises, with nothing in the deployment
file to show it.

The values are the fix:

- **`ASSET`** is now canonical testnet USDC
  (`CBIELTK6…`), obtainable by anyone from the DEX with no faucet
  (`USE_USDC=1 node provision-testnet.mjs`). The resource becomes payable by
  strangers for the first time, which is what makes the badge reachable at all.
- **`PAYTO`** is a new merchant account holding a live USDC trustline. The
  secret was generated straight to disk and never printed; it is **not** needed
  at runtime — `seller.mjs` only ever uses the public address.

The old binding to `GBJX3E4G…` resolves itself. Because it was never verified,
the first settlement naming the new address **displaces** it automatically. No
operator step, no runbook §1.

## What is still outstanding

This repo's part is done. Two actions remain and neither can happen here:

1. **Deploy.** Render picks up `render.yaml` on push. Until it redeploys, the
   live demo still advertises the dead asset.
2. **Settle once against the hosted facilitator.** That is what creates the
   displacement, triggers re-verification, and flips the badge. Provision a
   payer with `USE_USDC=1`, point `buyer-classic.mjs` at
   `https://vellar-seller-demo.onrender.com/quote`, and pay once. Retry if it
   fails — roughly one settle in three does, and nothing is spent when it does.

Afterwards, confirm with:

```sh
curl -s https://vellar-facilitator.onrender.com/discovery/resources \
  | python3 -c 'import sys,json; [print(i["resource"], i["trust"]["ownerVerified"]) for i in json.load(sys.stdin)["items"]]'
```

The demo entry should read `True`. The three `localhost` entries will not — they
are unreachable by design and cannot be removed; the boot guard added alongside
this stops a fourth.
