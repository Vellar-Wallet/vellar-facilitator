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

The secret for `GBJX3E4G…` is not known to be held — the account exists and is
funded, but its key's whereabouts is recorded nowhere in this repo. So the demo
moved to a merchant we control (`GAATVGLR…`) with a live USDC trustline.

**The prediction was that displacement would recover the binding automatically.
It was tested live, and it is false — see below.**

---

## What actually happened, 2026-08-14

The demo was redeployed on canonical USDC and the served 402 was confirmed by
content:

```
resource.url : https://vellar-seller-demo.onrender.com/quote
payTo        : GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC
asset        : CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
```

Two payments then settled against it:

| tx | ledger | on-chain |
| --- | --- | --- |
| `bc7e4a157fd8e433…` | 4133889 | successful |
| `2d1c3c78d3f174c4…` | 4133905 | successful |

The merchant received exactly 0.2 USDC, so both were real. **The catalog did not
move**: still bound to `GBJX3E4G…`, still advertising the dead asset,
`ownerVerified: false`, `settlements: 0`.

Two settlements were used deliberately, because `tryDisplace`'s own contract says
the settle that *triggers* a displacement is still refused and the next one lands
normally. The second one did not land either.

### What this rules out

| Suspect | Excluded by |
| --- | --- |
| Trailing-slash key mismatch | `normalizePath` strips it; both spellings map to one key |
| The `everVerified` one-way latch | `ownerVerified` **is** that latch (`annotateTrust` → `isVerifiedOwner`), and it reads false |
| Catalog frozen | `/health` reports no freeze |
| Ownership probe timing out | 3s budget; the demo answers warm in ~0.8s |
| Displacement not wired up | Fires fire-and-forget on every settle (`bazaar.ts`) |
| "First settle reveals, second lands" | Two were run |
| **Restoration from storage** | **New test** — a restored *unverified* binding displaces correctly |

That last row was the leading hypothesis and it is wrong. The suite had no
coverage for "restored, unverified, claimant proves ownership" — every passing
displacement test built its binding in the same process, and the only restart
test covered a *verified* binding, where the right answer is "skipped". So a
test was added for the production shape. **It passes**, which excludes
restoration rather than reproducing the failure.

### Why it took source-reading to get this far

Every remaining candidate lives behind a guard that returned a bare `"skipped"`.
Eight of them, no signal, so a displacement that silently did not happen could
not be diagnosed from outside the process — the same defect as `settle`
collapsing every submission failure into one constant `errorReason`, and this
time inside the control built to prevent squatting.

Both `tryDisplace` and `reverify` now log a reason on every exit, excluding the
two that fire on ordinary settlements. The next occurrence names its own cause.

### Still open

The cause. The remaining candidates are the empty-binding skip and a cooldown
from a prior verdict, and distinguishing them needs the deployment's logs:

```
grep -E "displacement (skipped|refused|check failed)|rejected upsert for|DISPLACED" 
# window: 2026-08-14 07:00–07:05 UTC
```

`rejected upsert for … is not bound … (F11)` is the discriminator. If it is
**present**, the settlement reached the catalog and the key matched, so the
failure is inside `tryDisplace`. If it is **absent**, the settlement never
reached cataloging at all and the question is upstream of displacement entirely.

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

The old binding to `GBJX3E4G…` was *predicted* to resolve itself by
displacement, since it was never verified. **That prediction is falsified** —
three live settlements naming the new address have not displaced it (see
above). The design intent stands; the observed behaviour does not match it yet.

## Where it stands

**Done:** the demo is deployed on canonical USDC and is payable by a stranger
for the first time — proven by two settlements from an unrelated payer. That was
the point of the change, and it is finished.

**Not done:** the catalog entry still shows the old binding and the dead asset,
and the badge still reads false. That is a display problem in shared state, not a
payment problem — nothing about paying this resource is broken.

**Do not** expect a further settlement to fix it. Two already failed to — and a
**third** (2026-08-14T12:28:38Z, `cda3cbaa…`, ledger 4137813) failed under the
conditions the cold-seller explanation said should succeed: seller measurably
warm (0.82s response), the 3-attempt retry deployed (`commit 6e4845d`), monitor
watching for 8 minutes. Catalog unchanged.

That falsifies "the seller was asleep" as the whole story. `buyer-classic.mjs`
opens with an unpaid GET that itself wakes the seller, so the target was never
cold at probe time in ANY of the three attempts. What remains consistent with
everything observed: the **facilitator's own outbound path** — a fresh
container's first DNS + TLS to a new host blowing the 3s budget — or in-provider
DNS resolving `.onrender.com` to a private range from inside Render, which the
SSRF guard would refuse as an instant `unverifiable` (matching both the speed
and the 15-minute cooldown of the original incident).

The #57/#58 logging was live for the third settlement, so the discriminating
evidence now exists:

```
grep "\[catalog\] displacement" 
# window: 2026-08-14 12:28–12:33 UTC
```

The line names its verdict. `timeout` → facilitator outbound latency, and the
retry should also appear. `unverifiable` arriving fast → the SSRF-guard/DNS
hypothesis, which no timeout retry will ever fix and which would mean the
facilitator can never verify a sibling Render service from inside Render.
The next step is that grep, not another payment.

To re-check the badge at any point:

```sh
curl -s https://vellar-facilitator.onrender.com/discovery/resources \
  | python3 -c 'import sys,json; [print(i["resource"], i["trust"]["ownerVerified"]) for i in json.load(sys.stdin)["items"]]'
```

The demo entry should read `True`. The three `localhost` entries will not — they
are unreachable by design and cannot be removed; the boot guard added alongside
this stops a fourth.
