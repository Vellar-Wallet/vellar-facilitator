# Deploy runbook — vellar-facilitator

Standing up a **new** instance from nothing. Every value below was read out of
the code that enforces it (`src/config.ts`, `src/server.ts`, `src/store.ts`,
`render.yaml`), not from memory — where this document and the code disagree, the
code is right and this document is a bug.

**This is not the incident runbook.** Once an instance is running and something
is wrong with it — a stale `payTo` binding, an empty catalog, a tombstone cap,
`unverifiableEntries` — go to [`docs/operator-runbook.md`](./operator-runbook.md).
This document ends where that one begins.

---

## 1. Overview

**Who this is for:** an operator standing up a new facilitator instance, on
Render or any Node host. Not developers running locally — for that, `npm install
&& npm run dev` and the [README](../README.md) are enough.

**What a healthy deployed instance looks like**, and the four things worth
checking in this order:

```jsonc
// GET /health
{
  "status": "ok",
  "service": "vellar-facilitator",
  "uptimeSeconds": 59,
  "catalogSize": 12,        // > 0 once anything has settled; 0 on a fresh DB is correct
  "reverifyPending": 0,
  "commit": "f182b86",      // which build is actually serving
  "channelPool": { "available": 50, "inUse": 0, "disabled": 0, "total": 50 }
}
```

`channelPool.total` must read **exactly 50**. Anything else means the process is
not running the configuration you think it is — see §12.

Two fields appear only when they matter, so a healthy instance stays quiet:
`unverifiableEntries` (sellers advertising an address the facilitator cannot
fetch) and `catalogFrozen` (bindings frozen — settlement still works, cataloging
does not).

---

## 2. Prerequisites

| | Needed | Notes |
| --- | --- | --- |
| Node host | Yes | Render blueprint included (`render.yaml`). Node 22. |
| libSQL/Turso database | Strongly recommended | Optional in code — unset means **in-memory**, and every restart empties the catalog and every ownership binding with it. |
| Sponsor account | **Required** | One funded Stellar classic (`S…`) account. §4. |
| 50 channel accounts | **Required** | Exactly 50, distinct, none equal to the sponsor. §5. |
| `VERIFICATION_API_URL` | Optional | Unset ⇒ every trust verdict reads `unknown` and `verified_only` is refused with a 400. That is the honest default, not a fault. |
| `UPTO_CONTRACT_ID` | Optional | Unset ⇒ `exact` only. Set ⇒ `upto` is advertised on `/supported`. |
| Bond escrow | Optional | `BOND_ESCROW_CONTRACT_ID` + `BOND_ESCROW_ADMIN_SECRET_KEY` — **both or neither**, enforced at boot. |

> **Correction to a common assumption: channel accounts do NOT need trustlines.**
> They need only the Stellar minimum reserve in XLM. The sponsor pays every
> settlement fee as `feeBumpSigner`, and payment funds move payer → `payTo`
> directly — a channel account never holds the payment asset. Verified against
> production: a live channel account shows `subentry_count: 0` and XLM only.
> See [`docs/channel-pool-design.md`](./channel-pool-design.md) §5.
>
> The **sponsor** does not need a payment-asset trustline either, for the same
> reason. It pays fees in XLM and is never a settlement source or destination.

---

## 3. Environment variables

Every variable `src/config.ts` reads. Two are required; everything else has a
working default.

### Required

| Name | What it does | Format | If missing |
| --- | --- | --- | --- |
| `SPONSOR_SECRET_KEY` | The account that pays every settlement's network fee (`feeBumpSigner`) and funds the channel accounts. | `S…`, 56 chars | **Boot throws.** `SPONSOR_SECRET_KEY is required: a funded Stellar classic (S...) secret…` |
| `CHANNEL_ACCOUNT_SECRET_KEYS` | The 50 settlement source accounts, each giving one concurrent settlement its own sequence lane. | Comma-separated, **exactly 50** `S…` keys | **Boot throws.** No default — a single shared signer produces `txBadSeq` under load. |

`CHANNEL_ACCOUNT_SECRET_KEYS` is validated hard at boot, and each failure names
itself: wrong count (`must contain exactly 50 keys, got N`), a malformed key
(the bad value is **never** echoed — it is secret material and this error is
uncaught at boot), a key equal to `SPONSOR_SECRET_KEY`, or a duplicate.

### Network and host

| Name | Default | What it does |
| --- | --- | --- |
| `STELLAR_NETWORK` | `testnet` | Exactly `pubnet` or `testnet`; unset means `testnet`. **Any other value throws at boot** — see §10. |
| `STELLAR_RPC_URL` | SDK default | Soroban RPC endpoint. |
| `PORT` | `4100` | |
| `HOST` | `0.0.0.0` | |

### Storage

| Name | Default | What it does |
| --- | --- | --- |
| `CATALOG_DB_URL` | *(unset)* | libSQL/Turso URL. **Unset ⇒ in-memory**, warned loudly at boot: listings and ownership bindings are lost on every restart. |
| `CATALOG_DB_AUTH_TOKEN` | *(unset)* | Database-scoped read-write token. Required for a remote database. |

### Optional features

| Name | Default | What it does | If missing |
| --- | --- | --- | --- |
| `VERIFICATION_API_URL` | *(unset)* | Trust-verdict source. | Every verdict `unknown`; `verified_only=true` → `400 verified_only_unavailable`. |
| `UPTO_CONTRACT_ID` | *(unset)* | Registers the `upto` scheme. | `exact` only. A malformed value **throws** rather than being ignored. |
| `BOND_ESCROW_CONTRACT_ID` | *(unset)* | Bond escrow contract. | Bonding inactive. |
| `BOND_ESCROW_ADMIN_SECRET_KEY` | *(unset)* | Signs `register_settlement`. Deliberately **not** the sponsor key. | Bonding inactive. Setting one without the other **throws**. |

### Thresholds

| Name | Default | What it does |
| --- | --- | --- |
| `MAX_TX_FEE_STROOPS` | `500000` | Fee-ceiling **bid** cap. Raised far above `@x402/stellar`'s 50,000 default so policy-governed smart-account payments are not rejected. Non-integer or ≤ 0 **throws**. |
| `SPEND_CEILING_STROOPS` | `50000000` (5 XLM) | Global rolling sponsor-spend ceiling per window. |
| `SPEND_WINDOW_MS` | `60000` | |
| `SETTLE_RATE_WINDOW_MS` | `60000` | Shared window for the per-entity budgets. |
| `SETTLE_PER_URL_MAX` | `10` | Settles per window per bound resource URL. |
| `SETTLE_PER_PAYTO_MAX` | `50` | Settles per window per `payTo`. |
| `SETTLE_UNBOUND_POOL_MAX` | `10` | Shared budget for all unbound URLs. |
| `CHANNEL_ACCOUNT_MIN_STROOPS` | `5000000` (5 XLM) | Reserve floor for ONE channel account. Below it the channel monitor disables the account; above it, re-enables. A **reserve** floor, not a fee budget — channel accounts never pay their own fees and never hold the payment asset (§2). |
| `SPONSOR_SOFT_FLOOR_STROOPS` | `250000000` (25 XLM) | Warn below this. |
| `SPONSOR_HARD_FLOOR_STROOPS` | `100000000` (10 XLM) | **Refuse `/settle`** below this (`503 sponsor_balance_low`). |
| `SPONSOR_BALANCE_INTERVAL_MS` | `60000` | Sponsor balance poll interval — **and** the channel-account balance check interval (`src/channelMonitor.ts` reuses it). At the default 60s, 50 channel accounts = 50 Horizon requests per minute, within Horizon's per-IP limit. **Do not lower below 10s** — at 10s the channel monitor alone generates 300 req/min and will exceed that limit, causing balance checks to fail (and, after 5 consecutive failures per account, to disable accounts that are actually healthy). |

> **Boot invariant.** `SPONSOR_HARD_FLOOR_STROOPS` must exceed
> `SPEND_CEILING_STROOPS`, or one spend window can drain the sponsor straight
> through the floor before the next balance check. On **pubnet this throws**; on
> testnet it warns.

### Retired — set nothing here

| Name | Behaviour |
| --- | --- |
| `SETTLE_RATE_MAX` | **Ignored**, warns at boot. Was a second per-payTo budget that shadowed `SETTLE_PER_PAYTO_MAX`. |
| `CATALOG_FILE` | **Ignored**, warns at boot. The catalog is in libSQL/Turso. |
| `CATALOG_OWNERSHIP_BOOTSTRAP` | **Ignored**, warns at boot. |

### Read outside `config.ts`

| Name | Read by | Purpose |
| --- | --- | --- |
| `RENDER_GIT_COMMIT` | `src/server.ts` | Injected by Render; surfaces as `commit` on `/health`. |
| `SUBMIT_RETRY_MAX` | `src/rpcstatus.ts` | Clamped 0–2. `0` is the settle-probe control arm. |
| `SKEW_RETRY_MAX` | `src/retry.ts` | Ledger-skew retry budget. |
| `FACILITATOR_URL` | `src/mcp.ts`, examples | Which facilitator the MCP server / examples target. |

---

## 4. Sponsor account setup

1. **Generate or supply a keypair** — [Stellar Lab](https://lab.stellar.org/account/create).
   Use a dedicated account. Never a mainnet key on a testnet instance.

2. **Fund it with XLM.**

   ```sh
   # testnet
   curl "https://friendbot.stellar.org/?addr=<SPONSOR_PUBLIC_KEY>"
   # pubnet: fund from a real account
   ```

   **How much.** Boot only requires a balance **> 0** — `assertSponsorFunded`
   fails only on a missing account or zero XLM. The number that matters
   operationally is the runtime guard: below `SPONSOR_HARD_FLOOR_STROOPS`
   (**default 10 XLM**) `/settle` is refused. Provision comfortably above the
   soft floor (**25 XLM**), plus whatever the 50 channel accounts consume in
   minimum reserves at provisioning time.

3. **Trustline: not required.** The sponsor pays fees in XLM and never holds the
   payment asset.

4. **Confirm on Horizon.**

   ```sh
   curl -s "https://horizon-testnet.stellar.org/accounts/<SPONSOR_PUBLIC_KEY>" \
     | python3 -c "import json,sys;d=json.load(sys.stdin);print([ (b['asset_type'],b['balance']) for b in d['balances'] ])"
   ```

   On a successful boot the log says so explicitly — silence would be
   indistinguishable from the check not running:

   ```
   [boot] sponsor preflight ok — GBUCR6H2… holds 9998.5 XLM
   ```

   If Horizon is unreachable the preflight **skips** with a warning and the
   polling guard takes over. It does not block boot.

---

## 5. Channel account setup

The pool is why concurrent settlement works. Measured, with a negative control:
a single signer managed **1/50** successful settlements with **48 `txBadSeq`**;
the 50-account pool managed **50/50, zero `txBadSeq`, p95 11,956 ms**
(`load-test-results-2026-08-31T11-15-47-630Z.json`).

1. **Generate exactly 50 keypairs.** Distinct, and none equal to the sponsor —
   both enforced at boot.

2. **Fund each with XLM.** Only the **Stellar minimum reserve** is needed. Channel
   accounts pay no fees (the sponsor fee-bumps every settlement) and hold no
   payment asset. Fund from the sponsor's balance; on testnet friendbot works
   per account.

3. **Trustlines: none.** See the §2 correction.

4. **Format the variable** — comma-separated, whitespace around entries is
   trimmed:

   ```
   CHANNEL_ACCOUNT_SECRET_KEYS=SA...1,SB...2,SC...3,…,SZ...50
   ```

   Exactly 50 entries. A shorter list silently loses the concurrency guarantee,
   so it is rejected; a longer one is rejected rather than trimmed, because an
   operator adding extras meant something the pool is not sized to give.

5. **Confirm after boot** — `total` must be 50:

   ```sh
   curl -s https://<your-instance>/health \
     | python3 -c "import json,sys;print(json.load(sys.stdin)['channelPool'])"
   # {'available': 50, 'inUse': 0, 'disabled': 0, 'total': 50}
   ```

---

## 6. Database setup

1. **Create a Turso database**, then mint a **database-scoped** read-write token:

   ```sh
   turso db create vellar-facilitator
   turso db show vellar-facilitator --url          # -> CATALOG_DB_URL
   turso db tokens create vellar-facilitator --expiration never   # -> CATALOG_DB_AUTH_TOKEN
   ```

   **Scope is a security decision.** Do not use a group token or a platform API
   token — both reach beyond this database. `--read-only` will **not** work: the
   store issues `CREATE TABLE IF NOT EXISTS` on every boot and writes bindings on
   the settle path.

   `--expiration never` is deliberate: the catalog **fails closed** on an
   unusable store, so an expiring token is a scheduled outage. Rotate
   deliberately (mint → set → restart → revoke the old one), never on a timer
   nobody is watching.

   Treat this token like `SPONSOR_SECRET_KEY`: whoever holds it can forge or
   clear any ownership binding in that database.

2. **Set both variables** — `CATALOG_DB_URL` and `CATALOG_DB_AUTH_TOKEN`.

3. **No manual migration.** `LibsqlCatalogStore.init()` runs
   `CREATE TABLE IF NOT EXISTS` for the `ownership` and `entry` tables plus the
   `entry_last_updated` index on every boot, and additively adds
   `ownership.verified_at` if an older database lacks it (checked via
   `PRAGMA table_info`, not attempted-and-caught).

---

## 7. Deployment on Render

The blueprint defines three services: `vellar-facilitator`, `vellar-seller-demo`
(the walkthrough seller), and `vellar-alloy` (metrics forwarder).

1. **Fork or clone** the repo.
2. **New → Blueprint** on Render, point it at the repo. It reads `render.yaml`.
3. **Set the secrets in the dashboard** (never in git — they are `sync: false`):
   `SPONSOR_SECRET_KEY`, `CHANNEL_ACCOUNT_SECRET_KEYS`, `CATALOG_DB_URL`,
   `CATALOG_DB_AUTH_TOKEN`, and `GRAFANA_API_TOKEN` if using Alloy.
4. **Deploy.** `healthCheckPath: /health` gates the release.
5. **Confirm** `status: ok` and `channelPool.total: 50` (§8).

> **Free tier.** The blueprint pins `plan: free` deliberately for budget. Render
> spins the service down after ~15 minutes idle and **destroys** the container —
> ~45 s cold start on the next request. With the catalog in Turso this costs only
> latency, not data. Changing that line to `plan: starter` **starts billing
> (~$7/mo) on the next blueprint sync** — do not let a routine sync be what
> starts a charge.

---

## 8. Post-deploy verification

Run these in order. On the free tier allow up to 60 s for the first call.

**1 — Health.**

```sh
curl -s https://<your-instance>/health | python3 -m json.tool
```
Expect `status: ok`, `channelPool.total: 50`, and a `commit` matching
`git rev-parse --short HEAD`. `catalogSize: 0` on a fresh database is correct.

**2 — Supported.**

```sh
curl -s https://<your-instance>/supported | python3 -m json.tool
```
Expect `kinds[]` with your network, `extra.areFeesSponsored: true`,
`extensions: ["bazaar"]`, `signers` listing 51 addresses (50 channel + sponsor),
and `catalogAssets` with both network keys present (empty arrays are fine).

**3 — Metrics.** All 11 must be present:

```sh
curl -s https://<your-instance>/metrics | grep -c "^# HELP vellar_"   # -> 11
```
`vellar_settle_total`, `vellar_settle_errors_total`, `vellar_verify_total`,
`vellar_settle_duration_seconds`, `vellar_pool_available`, `vellar_pool_in_use`,
`vellar_pool_disabled`, `vellar_catalog_size`,
`vellar_rate_limit_rejections_total`, `vellar_uptime_seconds`,
`vellar_reverify_pending`.

**4 — Discovery.**

```sh
curl -s "https://<your-instance>/discovery/resources?limit=2" | python3 -m json.tool
```
Expect `{ x402Version, items, pagination }`. Empty `items` on a fresh instance is
correct — the catalog fills from real settlements.

**5 — Rejection shape.** The wire contract for a bad request:

```sh
curl -s -X POST https://<your-instance>/settle \
  -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool
```
Expect HTTP **400** and:
```json
{ "success": false, "transaction": "", "network": "stellar:testnet",
  "errorReason": "invalid_body", "error": "invalid_body",
  "detail": "paymentPayload and paymentRequirements are required" }
```
`success`, `transaction`, `network` and a **non-null** reason are all required by
the x402 spec. No `extension-responses` header on this path — cataloging never
ran, and the header is only set where it did.

---

## 9. Observability

`GET /metrics` is **public and unauthenticated**, rate-limited at 60 req/min per
IP like every other route. It exposes operational counters only — no payloads, no
addresses, no PII.

Grafana Cloud is push-based and cannot scrape an arbitrary URL, so the
`vellar-alloy` service scrapes `/metrics` and forwards it. Full setup, the
dashboard JSON, and the account trail:
[`docs/grafana-dashboard-setup.md`](./grafana-dashboard-setup.md).

---

## 10. Mainnet vs testnet

Switching is configuration, but the accounts are **not** reusable — a testnet
keypair does not exist on pubnet.

| | Testnet | Pubnet |
| --- | --- | --- |
| `STELLAR_NETWORK` | `testnet` (or unset) | **`pubnet`** exactly — see the note below |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | e.g. `https://mainnet.sorobanrpc.com` |
| Horizon (derived) | `horizon-testnet.stellar.org` | `horizon.stellar.org` |
| USDC SAC | `CBIELTK6…QDAMA` | `CCW67TSZ…MI75` |
| Sponsor + 50 channel accounts | Friendbot | **New accounts, funded for real** |
| Spend policy | Log-only | **Enforced** — `503 settlement_refused` |
| Floor invariant | Warns | **Throws at boot** |

> **`STELLAR_NETWORK` is validated strictly, and rejects anything else at boot.**
> Only `"pubnet"` and `"testnet"` are accepted; unset means `testnet`. Anything
> else throws before a port is bound, naming the mistake:
>
> ```
> [config] STELLAR_NETWORK must be "pubnet" or "testnet", got "mainnet".
> Common mistakes: "mainnet" (Stellar calls it pubnet), "PUBNET"
> (case-sensitive), "stellar:pubnet" (that is the CAIP-2 id this derives,
> not the input). Unset defaults to "testnet".
> ```
>
> This used to fail *silently* — every unrecognised value meant `testnet`. On a
> box provisioned for mainnet that is the worst outcome available: real sponsor,
> 50 real channel accounts, and a testnet facilitator holding those keys with
> the spend policy in log-only mode and the floor invariant demoted to a
> warning. Every pubnet safety control off, and nothing in the logs saying so.

**USDT0 is mainnet-only** (no testnet equivalent). It needs no facilitator
configuration — the facilitator is asset-agnostic at settle time and runs no
allowlist. A *seller* accepting USDT0 needs a USDT0 trustline on their `payTo`;
channel accounts still need none, for the reason in §2. USDT0 sets
`auth_revocable` and `auth_clawback_enabled` — see
[`docs/asset-support.md`](./asset-support.md) before advising sellers.

Mainnet is **not yet done**: no pubnet deployment exists and the plumbing is
untested. See [`docs/conformance-report.md`](./conformance-report.md) §6.2.

---

## 11. Known operational gaps

Stated plainly, because an operator finding these at 3 a.m. is worse than
reading them now.

- **Channel-account balance monitoring — automated** via `src/channelMonitor.ts`
  (`c88d79f`). Accounts below `CHANNEL_ACCOUNT_MIN_STROOPS` (default 5 XLM) are
  disabled automatically; accounts that recover are re-enabled automatically.
  **Operators must still fund low-balance accounts manually** — the monitor
  handles disable/enable, not funding. Watch `vellar_pool_disabled` (§9): a
  non-zero, non-recovering value means an account needs XLM.
  <br>Two behaviours worth knowing before you rely on it. A failed Horizon read
  leaves an account **exactly as it is** — only 5 consecutive failures for that
  same account withdraw it, so one Horizon outage cannot empty the pool. And a
  balance read that is malformed rather than low counts as a failure, not as
  healthy.
- **No in-band rotation for a verified `payTo` binding.** A once-proven binding is
  permanently non-displaceable by design. Recovery is the manual procedure in
  [`docs/operator-runbook.md`](./operator-runbook.md) §1. Automating it would give
  away the property F11 exists for.
- **`upto` does not use the channel pool.** `UptoStellarScheme` shares the
  sponsor's sequence number directly, so **concurrent `upto` settlements can
  `txBadSeq`**. `exact` is unaffected. (`src/upto.ts`;
  [`docs/channel-pool-design.md`](./channel-pool-design.md) §8.)
- **The spend ceiling is ~22× more conservative than sponsor exposure requires** —
  accounted at the 500,000 estimate against a measured 22,579 charge, so it
  refuses the 101st settle in a window having actually spent ~0.23 of the 5 XLM
  it names. Fails safe; open as pubnet tuning (G-10).
- **Free-tier cold start** ~45 s after ~15 min idle. The keep-warm cron is
  best-effort — GitHub's scheduler measurably slips.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Boot throws `SPONSOR_SECRET_KEY is required` | Not set | Set it. §4. |
| Boot throws `CHANNEL_ACCOUNT_SECRET_KEYS is required` | Not set | Set 50 keys. §5. |
| Boot throws `must contain exactly 50 keys, got N` | Wrong count | Provide exactly 50. |
| Boot throws `not a valid Stellar secret key (S…, 56 chars)` | Malformed entry | Check separators. **The bad value is not echoed** — it is secret material. |
| Boot throws `contains SPONSOR_SECRET_KEY` | Sponsor is in the pool | Remove it. The sponsor is reserved for funding and fee-bumping. |
| Boot throws `contains a duplicate key` | Repeated key | Each of the 50 must be distinct. |
| Boot throws `Sponsor account … does not exist` | Unfunded / wrong network | Friendbot on testnet; check `STELLAR_NETWORK`. |
| Boot throws about the hard floor and the spend ceiling | `SPONSOR_HARD_FLOOR_STROOPS` ≤ `SPEND_CEILING_STROOPS` | Raise the floor or lower the ceiling. Throws on pubnet, warns on testnet. |
| Boot throws about bond escrow | Only one of the two bond vars set | Set both or neither. |
| `channelPool.total: 0` (or not 50) | Config not applied — a stale process, or the deploy did not pick up the change | Compare `/health`'s `commit` against `git rev-parse --short HEAD`; a mismatch means the running build is not the one you configured. |
| `catalogSize: 0` persists after real settlements | `CATALOG_DB_URL` unset (in-memory) or the store is unreachable | Check the boot log for the in-memory warning, and `/health` for `catalogFrozen`. See [`operator-runbook.md`](./operator-runbook.md) §2. |
| `503` + `pool_exhausted`, `retryable: true` | All 50 lanes in use — transient, nothing spent, nothing invalid | Retry. Sustained exhaustion means real demand above 50 concurrent settlements. |
| `503` + `sponsor_balance_low` | Sponsor below `SPONSOR_HARD_FLOOR_STROOPS` (default 10 XLM) | Fund the sponsor. Discovery is unaffected. |
| `503` + `spend_ceiling` / `rate_limited_payto` / `rate_limited_url` / `unbound_pool_exhausted` | A spend budget tripped | Expected under load. Tune the §3 thresholds, keeping the floor invariant. |
| `txBadSeq` on `exact` | Should not happen with the pool | Verify `channelPool.total: 50`. If it is 50, this contradicts the load-test result — capture the payload and treat it as a real defect. |
| `txBadSeq` on `upto` | **Known gap** — `upto` shares the sponsor's sequence | §11. Serialise `upto` settlements until the pool is extended. |
| `400 verified_only_unavailable` | `VERIFICATION_API_URL` unset | Working as designed — an empty list would describe the deployment, not the resources. Read `trust.ownershipState` instead. |
| `/health` shows `unverifiableEntries` | Sellers advertising an address the facilitator cannot fetch (http://, loopback, private IP, route template) | [`operator-runbook.md`](./operator-runbook.md) §6. |
| `/health` shows `catalogFrozen` | Ownership store unreachable/invalid, or the tombstone cap | Settlement still works; cataloging does not. [`operator-runbook.md`](./operator-runbook.md) §3. |

---

## Related

- [`docs/operator-runbook.md`](./operator-runbook.md) — incident response for a running instance
- [`docs/channel-pool-design.md`](./channel-pool-design.md) — why 50, and the sponsor's exclusion
- [`docs/grafana-dashboard-setup.md`](./grafana-dashboard-setup.md) — observability
- [`docs/conformance-report.md`](./conformance-report.md) — what is verified, and what is not
- [`docs/asset-support.md`](./asset-support.md) — USDC, USDT0, clawback risk
- [`docs/security-audit.md`](./security-audit.md) · [`docs/closing-state.md`](./closing-state.md) — findings and final statuses
