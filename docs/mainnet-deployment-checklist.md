# Mainnet deployment checklist

Deploying the facilitator to **Stellar pubnet** as a **new Render service**,
alongside — not replacing — the existing testnet service.

Ten steps. Steps 1–7 are mechanical; **Step 8 is blocked on something this repo
does not yet have** (a mainnet seller), and the checklist says so rather than
letting you discover it after funding 51 accounts.

> **This spends real money.** 550 XLM minimum across 51 accounts, and there is no
> friendbot and no undo. Read Step 3's note about trustlines before funding —
> it is the step most likely to be over-provisioned.

Companion documents: [`deploy-runbook.md`](./deploy-runbook.md) is the general
operator reference (every env var, troubleshooting); this file is the specific,
ordered mainnet sequence.

---

## Prerequisites

- Node.js installed locally (v22, matching `NODE_VERSION` in `render.yaml`)
- Access to the `Vellar-Wallet/vellar-facilitator` repo
- A Stellar **mainnet** wallet holding **≥ 600 XLM** (550 minimum + buffer)
- A [Turso](https://turso.tech) account
- Access to the Render dashboard

---

## Step 1 — Generate mainnet keypairs

```sh
node scripts/gen-mainnet-keys.mjs
```

Generates 1 sponsor + 50 channel keypairs. It writes
`scripts/.mainnet-keys-<timestamp>.json` (mode `0600`, gitignored) and refuses
to run at all if that ignore rule is missing.

Keep from the output:

| Needed for | Value |
| --- | --- |
| Funding (Step 2) | sponsor **public** key |
| `SPONSOR_SECRET_KEY` (Step 6) | sponsor **secret** key |
| Funding (Step 3) | all 50 channel **public** keys |
| `CHANNEL_ACCOUNT_SECRET_KEYS` (Step 6) | the pre-formatted comma-separated line |

The comma-separated line is pre-formatted because `config.ts` validates the pool
as **exactly 50 distinct secrets, none equal to the sponsor** — assembling it by
hand is 51 copy-pastes where any slip fails at boot.

---

## Step 2 — Fund the sponsor account

Send **≥ 50 XLM** to the sponsor public key.

Verify: `https://stellar.expert/explorer/public/account/<sponsor-public-key>`
(usually visible in under 30s).

**Why 50.** The sponsor pays every settlement's network fee. `/settle` is refused
below `SPONSOR_HARD_FLOOR_STROOPS` (10 XLM) and warns below the soft floor
(25 XLM), so 50 gives real operating room above both.

---

## Step 3 — Fund all 50 channel accounts

Send **≥ 10 XLM to each** of the 50 channel public keys. **500 XLM total.**

> **Channel accounts do NOT need USDC trustlines — or any trustline.**
>
> They never pay their own fees (the sponsor is the `feeBumpSigner`) and never
> hold the payment asset; funds move payer → `payTo` directly. Each needs only
> XLM for the Stellar minimum reserve. Verified against production: a live
> channel account reports `subentry_count: 0`. See
> [`channel-pool-design.md`](./channel-pool-design.md) §5/§6.
>
> Adding 50 trustlines is 50 unnecessary transactions and 50 unnecessary reserves.

50 separate sends, or one batch if your wallet supports multi-send. Spot-check
several on Stellar Expert before continuing.

---

## Step 4 — Create a Turso mainnet database

Create a **new** database — do not reuse the testnet one, or testnet ownership
bindings become mainnet ownership bindings.

```sh
turso db create vellar-facilitator-mainnet
turso db show vellar-facilitator-mainnet --url                    # -> CATALOG_DB_URL
turso db tokens create vellar-facilitator-mainnet --expiration never  # -> CATALOG_DB_AUTH_TOKEN
```

Use a **database-scoped** token, not a group or platform token. `--read-only`
will not work — the store runs `CREATE TABLE IF NOT EXISTS` on every boot.
Tables are created automatically; no migration step.

Treat this token like `SPONSOR_SECRET_KEY`: whoever holds it can forge or clear
any ownership binding in that database.

---

## Step 5 — Create a new Render Web Service

Dashboard → **New → Web Service** → connect `Vellar-Wallet/vellar-facilitator`.

| Field | Value |
| --- | --- |
| Branch | `main` |
| Name | `vellar-facilitator-mainnet` |
| Plan | Free |
| Build command | `npm install --omit=dev && npm install -g tsx` |
| Start command | `tsx src/server.ts` |
| Health check path | `/health` |

> **Build and start commands are taken from `render.yaml`, which is what the
> working testnet service actually uses.** There is **no `npm run build`** script
> in `package.json` — this project runs TypeScript directly through `tsx` and has
> no compile step. A `npm run build` build command fails immediately.

**Do not edit `render.yaml`.** It is the testnet blueprint; the mainnet service
takes its entire configuration from dashboard environment variables. Editing it
would repoint the testnet service at mainnet.

---

## Step 6 — Set environment variables on Render

**Required:**

```
STELLAR_NETWORK              = pubnet
STELLAR_RPC_URL              = https://mainnet.sorobanrpc.com
SPONSOR_SECRET_KEY           = <sponsor secret from Step 1>
CHANNEL_ACCOUNT_SECRET_KEYS  = <comma-separated 50 secrets from Step 1>
CATALOG_DB_URL               = <Turso URL from Step 4>
CATALOG_DB_AUTH_TOKEN        = <Turso token from Step 4>
```

> `STELLAR_NETWORK` must be **exactly** `pubnet`. `mainnet`, `PUBNET`, and
> `stellar:pubnet` are all **rejected at boot** with an error naming the mistake
> (commit `b392c97`). This previously failed *silently* by defaulting to testnet
> — which, on a box holding funded mainnet keys, meant every pubnet safety
> control quietly off.

**Optional** — leave unset to take the defaults:

```
CHANNEL_ACCOUNT_MIN_STROOPS  = 5000000      (5 XLM)
SPONSOR_SOFT_FLOOR_STROOPS   = 250000000    (25 XLM)
SPONSOR_HARD_FLOOR_STROOPS   = 100000000    (10 XLM)
SPONSOR_BALANCE_INTERVAL_MS  = 60000
```

Do not lower `SPONSOR_BALANCE_INTERVAL_MS` below ~10s — the channel monitor
checks 50 accounts per tick and would exceed Horizon's per-IP rate limit.

**Deliberately unset:**

| Variable | Why |
| --- | --- |
| `VERIFICATION_API_URL` | No verdict source deployed. Every verdict reads `unknown` and `verified_only` is refused with a 400 — the honest default. |
| `UPTO_CONTRACT_ID` | The `upto` contract is deployed on **testnet only**, and `upto` does not use the channel pool (concurrent settlements can `txBadSeq`). Not mainnet-ready. |
| `BOND_ESCROW_CONTRACT_ID` | Carries `PLACEHOLDER_*` constants, explicitly not mainnet-ready. Must be set together with its admin key or boot fails. |

---

## Step 7 — Deploy and verify

Trigger a manual deploy; wait ~2–3 minutes.

```sh
curl https://<mainnet-render-url>/health
```

```jsonc
{
  "status": "ok",
  "service": "vellar-facilitator",
  "commit": "<current git short hash>",
  "catalogSize": 0,          // correct — the mainnet catalog starts empty
  "channelPool": { "available": 50, "inUse": 0, "disabled": 0, "total": 50 }
}
```

**`channelPool.total` must read exactly 50.** Anything else means the service is
not running the configuration you think it is — compare `commit` against
`git rev-parse --short HEAD`.

```sh
curl https://<mainnet-render-url>/supported
```

Must show `"network": "stellar:pubnet"` in `kinds[]`, with
`extra.areFeesSponsored: true`. If it says `stellar:testnet`, `STELLAR_NETWORK`
did not take effect.

Also confirm the rejection shape is conformant:

```sh
curl -X POST https://<mainnet-render-url>/settle \
  -H 'Content-Type: application/json' -d '{}'
```

Expect `400` with `success`, `transaction`, `network`, and a non-null
`errorReason`.

---

## Step 8 — Run a real mainnet settlement

> **This step is blocked today, and that is worth knowing before Step 1.**
>
> A settlement needs a seller advertising a paid endpoint on `stellar:pubnet`.
> `vellar-seller-demo.onrender.com` is **testnet-only** — it is pinned to testnet
> USDC and a testnet `payTo` in `render.yaml`.

You need either:

- **(a)** a real seller who has deployed an x402 endpoint on Stellar mainnet, or
- **(b)** a test seller deployed with `STELLAR_NETWORK=pubnet`, a mainnet `payTo`
  holding a **mainnet USDC trustline**, and mainnet USDC to be paid in.

A *seller's* `payTo` does need the asset's trustline — unlike channel accounts
(Step 3). That asymmetry is the single most common misreading of this design.

Once a mainnet seller exists:

1. Make a real payment through the facilitator.
2. Copy the tx hash from the settle response.
3. Verify: `https://stellar.expert/explorer/public/tx/<hash>` — confirm
   `successful: true` and that `fee_account` is the **sponsor**, which is the
   on-chain evidence for `areFeesSponsored`.
4. Record it in Step 9.

---

## Step 9 — Update the conformance report

In [`conformance-report.md`](./conformance-report.md):

- **§6.2** — replace ⛔ with ✅; add the mainnet Render URL, the first settled tx
  hash, the date, and the deployed commit.
- **§1 table** — C5 moves from ⚠️ *testnet only*; C1/C4 stay ⛔ until the
  x402-foundation e2e suite has run against both networks.
- **§4** — add the pubnet `exact` hash beside the testnet one.

Re-verify the hash against Horizon before writing it down, rather than copying
from a settle response — that is the convention the rest of that report follows.

---

## Step 10 — Delete the keypair file

```sh
rm scripts/.mainnet-keys-*.json
git log --all -- 'scripts/.mainnet-keys-*.json'   # must print NOTHING
```

Empty output means it was never committed. If it prints anything, treat all 51
accounts as compromised and rotate — sweep the funds to fresh keypairs and start
from Step 1. A pushed secret is not recoverable by deleting the file.

Keep the secrets in a password manager if you need them again; the Render
dashboard already holds the two that the service uses.

---

## After deployment

- `technical-doc.md` §9 checklist **item 4** → ✅ Done, once the first mainnet
  settlement is confirmed. Not before: the item is *deployment **+ live
  settlement test***, and a healthy `/health` alone does not close it.
- **Item 1 (external security audit) remains open** and is a hard blocker for
  the mainnet *tag*, distinct from having an instance running.
- Watch `vellar_pool_disabled` (Grafana). Non-zero and not recovering means a
  channel account needs XLM — the monitor disables and re-enables automatically
  but does **not** fund.
- **G-10 is now live.** On pubnet the spend policy *enforces*: the ceiling is
  accounted at a 500,000-stroop estimate against a ~22,579 measured charge, so it
  refuses the 101st settle per window having actually spent ~4.5% of what it
  names. It fails safe. Tune it with real mainnet fee data, not before —
  see [`closing-state.md`](./closing-state.md) G-10 for why lowering the ceiling
  is the wrong lever.
