# Handover — docs.vellar.xyz

What the hosted documentation site is missing, found by walking the x402 loop
cold on 2026-08-11 (no repo knowledge, starting from the site and the hosted
facilitator). Separate repo, separate session — this is the work list.

The site is a **client-SDK site**; the facilitator is a footnote. Pages audited:
`/docs/introduction`, `/docs/quickstart`, `/docs/x402`, `/docs/facilitator`.

**The pattern:** the site documents the two things that explain themselves (cold
starts, rate limits) and omits the ones that silently cost hours. Re-audited
2026-08-12 against the live site: **nothing below had been actioned**, and one
item (§6) turned out to be actively wrong rather than merely missing.

**One thing the site gets right — do not "fix" it.** It says the first request
after idle "can take up to a minute (cold start)" and claims **no warm window**.
That was correct when written. **Update 2026-08-15: the facilitator moved to a
paid always-on instance** (`render.yaml`, keepalive retired) — once verified
live, the docs site should retire the facilitator cold-start warning too; the
free-tier demo *seller* still sleeps. The facilitator's own docs claimed warm hours until 2026-08-12
and the claim was withdrawn as false — the keep-alive delivered 6 of 96 pings,
shortest gap 47 min against a 15-min idle timeout. Do not import a warm-window
claim from anywhere. Every fact
below is verified live — sources are in `docs/using-it.md` and
`docs/closing-state.md` § Cold-start findings (O-1…O-11) in the facilitator repo.

---

## P0 — blockers. Someone hits these and stops.

### 1. No testnet asset, and no way to get one

Nothing on the site says how to obtain a SEP-41 token. `/docs/quickstart`
references `nativeTokenId` as a bare variable and never explains where it comes
from. `/docs/x402` omits asset acquisition entirely.

**Write:** the facilitator settles in whatever SEP-41 asset the resource names.
There is no canonical asset, no built-in test token, and **no faucet** — you
bring your own. Point at `examples/provision-testnet.mjs` (creates an issuer, a
SAC, a trustlined merchant, and a funded payer in ~2 minutes).

**Also state plainly:** the demo seller's `X402TST` (`CDYCX4PE…`) **cannot be
acquired by anyone.** Its issuer keypair was generated in-process by a throwaway
script and the secret no longer exists. Readers who find the contract id in
`/discovery/resources` will otherwise burn time trying to get a balance that
cannot exist.

### 2. The ~1-in-3 settle failure is documented nowhere on the site

The single most damaging omission. The failure is loud, has an alarming name
(`settle_exact_stellar_transaction_submission_failed`), and reads as "this
product is broken" rather than "retry".

**Write:** roughly one settle in three fails on testnet with an empty
`transaction` field, under **two** reason codes —
`settle_exact_stellar_transaction_submission_failed` and
`settle_exact_stellar_transaction_failed`. Both mean the transaction was never
submitted: **nothing was spent, nothing double-pays.** Retry with a freshly
signed payload (signatures expire in ledgers, not wall-clock).

Measured: 13 attempts, 6 failures, merchant balance afterwards exactly
successes × price. The rate is not stable — earlier sessions saw 3/11 and 3/9.
Treat retry as mandatory, not as a rare path.

### 3. No end-to-end path exists on the site

`/docs/quickstart` defers to `/docs/x402`, which is client-only and defers
merchant topics to `/docs/facilitator`, which doesn't cover them. **The loop
closes on nothing.** A reader cannot get from "I have a wallet" to "I paid for a
resource" using the site alone.

**Write:** one page that runs the whole loop — provision an asset, start a
seller, pay it, see it in discovery. Or link to `docs/guide.md` and
`docs/using-it.md` in the facilitator repo, which the site currently never
references.

---

## P1 — silent failures. Things work, wrongly.

### 4. Echoing `required.extensions` into the payment payload

Not mentioned anywhere. Skip it and **the payment succeeds and nothing is
listed** — a silent failure with no error and no signal.

**Write:** echo `required.extensions` into the payment payload; that echo is
what tells the facilitator to catalog the resource.

### 5. `ownerVerified`'s five requirements

`/docs/facilitator` names the field but not the conditions, so a reader cannot
act on it. Copy the five-row table from `docs/using-it.md`: https-only and
publicly resolvable; unauthenticated GET returns 402; a `PAYMENT-REQUIRED`
header ≤ 64 KiB; `accepts[].payTo` includes your address; answers within 3s with
no redirect. Add the trailing-slash canonicalisation note.

### 6. `verified_only` — mentioned, but with the WRONG CAUSE

This is the only item on the site that is actively **incorrect** rather than
absent, so it ranks above the other P1s. Re-audited 2026-08-12; the page says:

> "Don't build UI on trust badges yet. On the hosted free-tier instance,
> ownership verification does not survive restarts, so badges currently read
> unverified and `verified_only=true` can return an empty list."

That conflates two independent mechanisms and gives a cause that is not the real
one:

- **`verification` / `acceptsVerification`** (what `verified_only` actually
  filters on) are **always `"unknown"`**, on every deployment, because the
  external attestation service is deployed nowhere. Restarts are irrelevant.
  This will not improve on the hosted instance.
- **`ownerVerified`** is a different field, computed by the facilitator itself,
  and it **does** work. It is what the restart caveat applies to (G-1), and it
  recovers automatically on the next settlement after a cooldown.

The harm is specific: a reader concludes the badges would work if the instance
stopped restarting — they never will — and is steered away from `ownerVerified`,
which is the one signal that does work.

The same page also says `verification` "reads `'verified'` only when the
resource's URL ownership has been actively verified (`ownerVerified`)". Same
conflation: `verification` comes from the attestation service, not from
`ownerVerified`, and does not read `"verified"` on this deployment at any time.

**Write:** do not use `?verified_only=true`; it filters on `verification`, which
is always `"unknown"` because the attestation service is deployed nowhere. Read
`ownerVerified` instead — that one works, and it is lost on restart but restored
by the next settlement.

### 7. Simulation source must differ from the payer

Not mentioned, and it is a hard failure with an opaque code. The facilitator
**rebuilds the transaction with itself as the source**, so the caller's source
is simulate-only — but if the payer *is* that source, Soroban emits
source-account credentials and the scheme rejects them with
`invalid_exact_stellar_payload_unsupported_credential_type`.

**Write:** always simulate from a funded account that is not the payer.

---

## P2 — accuracy and debugging

| # | Item | What to write |
| --- | --- | --- |
| 8 | **Classic keypairs are supported and now have code** | `/docs/x402` implies smart accounts throughout. A plain `G…` keypair works — proven, settlement `6cf8091c…`. Point at `examples/buyer-classic.mjs`. The only difference is the auth-entry signature shape: a vec of `{ public_key, signature }` maps vs. the smart account's `SignerKey`/`Signature`. |
| 9 | **Debug with GET, not HEAD** | `curl -I` on a paid route returns **200**; `GET` returns 402. A reader probing with HEAD concludes the paid route isn't wired up. |
| 10 | **Merchants need a trustline** | A merchant without a trustline to the payment asset verifies fine and then fails at settlement, with an on-chain error that reads exactly like a spend control refusing it. |
| 11 | **`/health` omits `unverifiableEntries` when zero** | The key is absent, not `0`. Check for presence, not value. |
| 12 | **Cataloging is settle-only** | A resource enters discovery only after a real payment settles. Verify-only traffic catalogs nothing. |
| 13 | **Link out to the facilitator repo** | The site never points at `examples/` or the repo docs — the only materials that actually run. |

---

## Facts to copy verbatim

Verified live on 2026-08-11 against `https://vellar-facilitator.onrender.com`:

- Rate limit **60 req/min per IP**; `/verify` and `/settle` bodies capped at
  **32 KiB**. `/health` is exempt from rate limiting.
- Cold start **~45s at any hour** (44.76s measured). There is **no reliable warm
  window** — the keep-alive is a GitHub Actions cron that delivered 6 of 96
  requested pings, shortest gap 47 min against a 15-min idle timeout. Do not
  repeat the old "warm 00:00–07:59 and 12:00–19:59 UTC" claim; it was withdrawn
  on 2026-08-12. Tell readers to send a warming `GET /health` with a 120s
  timeout.
- Spend controls are **log-only on testnet** — you cannot test your handling of
  `503 settlement_refused` there.
- `stellar:testnet` only. Testnet assets are not money.
- Trust badges `verification` / `acceptsVerification` are always `"unknown"`.
- Time to first successful payment, cold, following the docs: **19m41s** before
  this work, **~2m30s** after.
