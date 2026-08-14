# Using this facilitator

Two audiences with different jobs. Pick yours.

- **[I sell something](#merchants)** — you have a paid HTTP endpoint and want
  payments settled and your resource listed in discovery.
- **[I buy things](#buyers)** — you are an agent or client paying for resources
  you found.

This covers pointing at a **running** facilitator. To run one locally and walk
the whole loop with both example scripts, use
[`guide.md`](./guide.md); for the project overview and hosted-instance caveats,
the [README](../README.md). This page does not repeat either.

**Hosted testnet instance:** `https://vellar-facilitator.onrender.com`
Read [§ What will bite you](#what-will-bite-you-on-the-hosted-instance) before
you rely on it, and [§ Who this is ready for](#who-this-is-ready-for) before you
point anything real at it.

---

## First: bring your own payment asset

Both roles need this, and it is the step most likely to stop you before you
start.

The facilitator settles in a **SEP-41 token, and it does not care which one.**
It ships no token of its own and runs no faucet, so you need to decide which
token you are transacting in before anything else works.

Two options, and the first is newer advice than the rest of this page:

**Canonical testnet USDC.** `@x402/stellar` ships its address, so it is the
closest thing to a default the ecosystem has:

```
CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
  → USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5, 7 decimals
```

**You can obtain it with no faucet and no human step** — verified end to end on
2026-08-12:

```sh
cd examples && USE_USDC=1 node provision-testnet.mjs
```

Circle's testnet issuer sets `auth_required: false`, so trustlines are
permissionless, and there is a live XLM/USDC market on the testnet DEX. The
script funds an account from friendbot, opens the trustline, and buys USDC with
a path payment — **10 USDC cost 5.59 XLM** against a 10,000 XLM friendbot grant,
so the budget is not close to binding. A full x402 payment then settled in it
(`f9b743c5…`, merchant balance reconciling exactly).

Use USDC when two parties who have never met need to transact. Agent-to-agent
payment requires an asset both sides already accept, and a token you minted
yourself is one nobody else holds.

**A token you mint yourself.** The default, and still the right choice for
walking the loop: fully self-contained, no dependency on an external market, and
you can mint as much as you want. Correspondingly useless to anyone but you.

```sh
cd examples && node provision-testnet.mjs
```

**You cannot use the demo seller's token.** The `X402TST` asset (`CDYCX4PE…`)
advertised by `vellar-seller-demo` was minted by an issuer keypair generated
in-process by a throwaway script; that secret no longer exists anywhere. Nobody
can mint more of it — not you, not us. Reading the contract id out of
`/discovery/resources` will not help, because the problem is not knowing the id,
it is that no one can obtain a balance. **A payment to that demo resource cannot
be built by anyone except its original wallet.** Point your buyer at your own
seller instead.

Making your own takes about two minutes on testnet:

```sh
cd examples && npm install
node provision-testnet.mjs
```

That creates an issuer, deploys a Stellar Asset Contract for a fresh token,
funds a merchant account **with a trustline** (your `payTo`), funds a classic
payer **with a balance** (your buyer), and prints a paste-ready env block.

**Only if you want a smart-account payer** (`buyer.mjs`) rather than a classic
one, generate an agent keypair first and pass its public key. Generate and store
it in ONE process, so the secret is a result rather than an argument that reaches
your shell history:

```sh
mkdir -p ~/.vellar-keys && chmod 700 ~/.vellar-keys
node -e '
  const {Keypair}=require("@stellar/stellar-sdk"), fs=require("fs");
  const kp=Keypair.random();
  fs.writeFileSync(process.env.HOME+"/.vellar-keys/agent.key", kp.secret(), {mode:0o600});
  console.log("AGENT_PUBLIC="+kp.publicKey());   // public key ONLY
'
AGENT_PUBLIC=G... node provision-testnet.mjs      # adds a smart account
```

`buyer.mjs` then needs that secret as `AGENT_SECRET`, plus the
`WALLET_CONTRACT_ID` the script prints. The full handling rules — never in a
transcript, never as an argument, never across a session boundary — are in
[`walkthrough-wallet-spec.md`](./walkthrough-wallet-spec.md).

Doing it by hand needs, in order: an issuer account, a SAC for the asset
(`createStellarAssetContract`), a `changeTrust` on every classic recipient, and
a `mint` to the payer. Two traps the script already handles — friendbot
returning 200 before the RPC can see the account, and `prepareTransaction`
rejecting classic operations such as `changeTrust`.

---

## Merchants

### What you change

One thing: point your x402 resource server at this facilitator.

```js
import { HTTPFacilitatorClient } from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";

const server = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: "https://vellar-facilitator.onrender.com" }),
)
  .register("stellar:testnet", new ExactStellarScheme())
  .registerExtension(bazaarResourceServerExtension); // opt in to discovery
```

You keep your own server, routes, auth and business logic. The facilitator only
verifies and settles, and catalogs the resource when a payment settles.

**Copy from `examples/seller.mjs`.** It is a complete working merchant — one paid
route, discovery declaration, `PUBLIC_BASE_URL` handling, and a `/whoami` endpoint
that reports exactly what it is advertising. That last part is worth stealing: it
exists because a hardcoded `localhost` in a log line once hid a broken deployment
for weeks.

Run it against your own merchant and asset — both are read from the environment:

```sh
cd examples
PAYTO=G... ASSET=C... PRICE_ATOMIC=1000000 node seller.mjs
```

It refuses to boot in two cases. First, if that pair cannot be paid: `PAYTO` must
be a funded account holding a **trustline to `ASSET`**. Without the trustline every payment verifies
and then fails at settlement, with an on-chain error that reads exactly like a
spend control refusing it — so the check happens once, at boot, and names the
fix. `SKIP_TRUSTLINE_CHECK=1` bypasses it; an unreachable RPC warns rather than
blocks.

Second, if booting would pollute shared state: an **unverifiable resource URL
pointed at a non-local facilitator** is refused, because the first settlement
would write a permanent public entry nobody can remove. See [§ Your first
settlement writes to a shared
catalog](#your-first-settlement-writes-to-a-shared-catalog-permanently).

### What your 402 must declare

Your unpaid response needs payment requirements. For discovery, add the bazaar
declaration:

```js
const routes = {
  "GET /quote": {
    accepts: {
      scheme: "exact",
      network: "stellar:testnet",
      payTo: MERCHANT_ADDRESS,          // your G... address
      price: { asset: SEP41_CONTRACT_ID, amount: "1000000" }, // atomic units
      maxTimeoutSeconds: 120,
    },
    description: "Motivational quote of the day (paid)",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { topic: "perseverance" },
      inputSchema: { properties: { topic: { type: "string" } } },
      output: { example: { quote: "…" } },
    }),
  },
};
```

`SEP41_CONTRACT_ID` is **your** token's contract id — the `ASSET` value printed
by `provision-testnet.mjs`, or the SAC of any asset you control. There is no
default to fall back on; see [§ First: bring your own payment
asset](#first-bring-your-own-payment-asset).

**Your account needs a trustline to the payment asset**, or settlement fails
on-chain after everything else has succeeded. `seller.mjs` checks this at boot
so you find out before a buyer does.

### Getting ownership verification right

Your entry carries `ownerVerified`. It is `true` only when the facilitator can
fetch your resource URL and find your own `payTo` in your own 402 challenge —
which is what stops someone else listing your URL against their address.

**Five things must be true.** They are checked in this order, and any one failing
gives `unverifiable`:

| # | Requirement | Why |
| --- | --- | --- |
| 1 | The URL is **https** and publicly resolvable | http is rejected before a socket opens; so are loopback, private ranges and cloud-metadata addresses |
| 2 | An **unauthenticated GET returns 402** | The verifier sends no payment. A 200, a 401, or anything else is unverifiable |
| 3 | It carries a **`PAYMENT-REQUIRED` header** ≤ 64 KiB | The verdict comes entirely from the header; your body is never downloaded |
| 4 | The challenge's `accepts[].payTo` **includes your address** | This is the actual check |
| 5 | It answers within **3 seconds**, with **no redirect** | Redirects are not followed — a `301 /quote → /quote/` reads as unverifiable |

Two that catch people:

- **Advertise your public address, not your local one.** The `resource.url` in
  your 402 is what gets cataloged and re-fetched. `http://localhost:4031/quote`
  can never verify. `examples/seller.mjs` uses `PUBLIC_BASE_URL` for this.
- **The canonical key strips a trailing slash.** If your server serves *only*
  `…/quote/` and 404s on `…/quote`, verification fetches the latter and fails.

### If you get it wrong — the silent-unverified case

**Nothing breaks loudly. Payments keep settling.** Your entry is listed and
served, with `ownerVerified: false`, and there is no error on the payment path
because verification runs *after* settlement and never blocks it.

How to notice:

```sh
curl -s https://vellar-facilitator.onrender.com/health
# → "unverifiableEntries": 1   when any entry's URL can never be verified
#   (http, private address, or a route template — a structural problem, not a
#    transient one)
#
# The field is ABSENT, not 0, when nothing is wrong — a healthy catalog does not
# carry the key at all. Do not read "no such field" as "the endpoint does not
# report this"; check for its presence, not its value.

curl -s 'https://vellar-facilitator.onrender.com/discovery/resources' \
  | python3 -c 'import sys,json; [print(i["resource"], i["trust"]["ownerVerified"]) for i in json.load(sys.stdin)["items"]]'
```

The facilitator also logs once per URL: *"can never be ownership-verified…"*.

**It retries.** A failed check re-runs on your next settlement after a **15
minute** cooldown (24 hours if the challenge actively named a *different*
address, which reads as a possible takeover). So fix the cause, settle once, and
the badge appears — no operator involvement.

### Be first to settle for your own URL

Ownership is trust-on-first-use: the first settlement for a canonical URL
(`origin + pathname`) binds it to that payment's `payTo`. **If someone else
settles for your URL first, they hold the binding** and your own settlements are
refused from the catalog — though your payments still go through.

This is *designed* to be recoverable without an operator: settle once, and if
your 402 names your address, you take the binding back automatically
(displacement). Changing the address on a binding that was already **verified**
is not automatic and needs [runbook §1](./operator-runbook.md).

**Do not rely on that recovery yet.** It works in tests, including against a
binding restored from storage — and on 2026-08-14 it did **not** recover a real
stale binding on the hosted instance. Two settlements naming the claimant landed
on-chain and the catalog did not move. The cause is not yet established, and
until it is, treat displacement as a mechanism that should work rather than one
observed working in production. Detail, including everything ruled out:
[`diagnosis-demo-listing.md`](./diagnosis-demo-listing.md).

The practical advice is unchanged and now matters more: **be first to settle for
your own URL.**

### What you see in discovery

```json
{
  "resource": "https://api.example.com/quote",
  "accepts": [{ "scheme": "exact", "network": "stellar:testnet",
                "asset": "C…", "amount": "1000000", "payTo": "G…" }],
  "trust": {
    "settlements": 7, "uniquePayers": 3,
    "observedSettlements": 7, "statsSource": "observed",
    "ownerVerified": true,
    "verification": "unknown", "acceptsVerification": ["unknown"]
  }
}
```

- **`ownerVerified`** — yours to control, per above.
- **`statsSource`** — where these numbers came from. `"observed"` means the entry
  was created by the running process, so it witnessed the whole history.
  `"persisted"` means the entry was loaded from storage: its baseline was
  recorded by a previous process and cannot be re-derived from the chain.
  A restored entry always reports `"persisted"`, **including when its stored
  count is 0** — a zero it inherited is still a zero it did not witness.
  `observedSettlements` is the number to trust either way.
- **`verification` / `acceptsVerification`** — always `"unknown"` here. Not about
  you; see [§ What will bite you](#what-will-bite-you-on-the-hosted-instance).
- Your entry appears **only after a real payment settles.** Verify-only traffic
  does not catalog anything.

---

## Buyers

### What you need

| You need | You do **not** need |
| --- | --- |
| The **payment asset**, and a trustline to it | **XLM for fees** — the facilitator's sponsor pays them |
| A Stellar signer: a plain classic keypair **or** a smart account | An account on this facilitator. No signup, no key, no allowlist |

**A smart account is optional, and both paths have working code — but they are
not equally easy, and the difference is upstream, not here.**

| Payer | Example | Built on | Use it when |
| --- | --- | --- | --- |
| **Classic keypair** | `examples/buyer-classic.mjs` | The **official** x402 client | You just want to pay. ~12 lines. |
| **Vellar smart account** | `examples/buyer.mjs` | Hand-rolled, of necessity | You want an agent whose budget is enforced on-chain by a policy contract. |

The classic path is the one to copy. It is proven against this facilitator
(settlement `9512a079…`) and it delegates everything to
`@x402/stellar/exact/client` plus `@x402/core/client` — no custom SDK, no
hand-assembled transaction, no hand-signed auth entry.

The smart-account example exists for the "agent with a budget" pattern:
policy-governed accounts run their policy inside `__check_auth`, which pushes the
simulated fee to ~130k stroops, and facilitators defaulting to a 50k ceiling
reject them. This one defaults to 500,000.

It is hand-rolled because **the official client cannot express a smart-account
signature today.** `AssembledTransaction.signAuthEntries` narrows your signer's
result to a naked buffer, which routes to the ed25519 branch of `authorizeEntry`
and throws on a C-address. The SDK's `{ signatureScVal }` escape hatch — added
for exactly this case — is not reachable through the x402 client scheme. Details
and the proposed fix: [`upstream-issue-smart-accounts.md`](./upstream-issue-smart-accounts.md).

**You do not need a second funded account.** Earlier revisions of this page told
you to pass a `SIM_SOURCE_ACCOUNT` different from the payer, because simulating
from the payer yields source-account credentials that the scheme rejects
(`invalid_exact_stellar_payload_unsupported_credential_type`). That was a
consequence of building the transaction by hand. The official client simulates
from the SDK's null account, so the payer is never the transaction source and the
failure cannot arise. `buyer-classic.mjs` ignores the variable if you still have
it set. `buyer.mjs` still needs one.

### Discovering resources

```js
import { HTTPFacilitatorClient } from "@x402/core/http";
import { withBazaar } from "@x402/extensions/bazaar";

const bazaar = withBazaar(
  new HTTPFacilitatorClient({ url: "https://vellar-facilitator.onrender.com" }),
).extensions.bazaar;

const { items } = await bazaar.listResources({ network: "stellar:testnet" });
const { resources } = await bazaar.search({ query: "weather data" });
```

The official client — no custom SDK. Each entry carries everything needed to call
*and* pay: URL, method, input schema, output example, and the exact payment
requirements.

**For AI agents**, `src/mcp.ts` exposes the same two operations as MCP tools; the
README has the client config.

**Read `ownerVerified` before you pay.** It is the signal that a listing is not a
squat — the resource's own 402 names the address you would be paying. Do **not**
filter on `verified_only`; it is inert here and returns nothing.

### Paying

With a classic keypair, the whole thing is three steps and the middle one is a
single call:

```js
const signer = createEd25519Signer(PAYER_SECRET, "stellar:testnet");
const client = new x402Client().register("stellar:testnet", new ExactStellarScheme(signer, { url: RPC_URL }));
const http = new x402HTTPClient(client);

const unpaid = await fetch(RESOURCE_URL);                                  // 402
const required = http.getPaymentRequiredResponse(n => unpaid.headers.get(n));
const payload = await client.createPaymentPayload(required);               // builds + signs
const paid = await fetch(RESOURCE_URL, { headers: http.encodePaymentSignatureHeader(payload) });
```

`createPaymentPayload` assembles the SEP-41 transfer, signs your auth entry, sets
expiry from the seller's `maxTimeoutSeconds`, **and echoes the seller's
`extensions` into the payload** — the last of which is what makes the facilitator
catalog the resource. You do not register a client-side extension to get that;
the merge is unconditional.

**Copy from `examples/buyer-classic.mjs`** (classic keypair) or
`examples/buyer.mjs` (smart account).

```sh
cd examples
RESOURCE_URL=https://your-seller/quote PAYER_SECRET=S... node buyer-classic.mjs
```

One thing that will cost you time otherwise:

- **Signatures expire in ledgers (~5s each), not wall-clock.** The scheme derives
  the expiry ledger from `maxTimeoutSeconds` at signing time. Do not cache a
  signed payload — sign a fresh one per attempt, which also matters because
  retrying a failed settle is mandatory (see below).

If you are writing the payer by hand instead — as `buyer.mjs` must — the flow
underneath is: GET → 402, build the SEP-41 transfer, sign the auth entry, echo
`required.extensions`, retry with `PAYMENT-SIGNATURE`. Skipping the echo still
pays, but lists nothing.

---

## What will bite you on the hosted instance

Six things, in the order you will meet them.

| | What | What to do |
| --- | --- | --- |
| **1** | **~45s on the first request, at any hour.** The service sleeps after 15 minutes idle and there is **no reliable warm window** — see below | **Assume you will pay it.** Send a warming `GET /health` first (exempt from rate limiting) and give it a 120s timeout, or expect your first real call to hang for ~45s. It then stays warm 15 min past your last call |
| **2** | **Roughly 1 settle in 3 fails**, with an empty `transaction` and one of two reasons: `settle_exact_stellar_transaction_submission_failed` or `settle_exact_stellar_transaction_failed` | **Retry — and no, you did not pay twice.** See below |
| **3** | **Trust badges are inert.** `verification` and `acceptsVerification` are always `"unknown"` | Read `ownerVerified` instead — that one works. The badge source is deployed nowhere and is not switching on soon (README has the dependency chain) |
| **4** | **`?verified_only=true` returns an empty list** | Do not use it. It filters on the inert field |
| **5** | **`curl -I` on a paid route returns 200, not 402** | Debug with `GET`, not `HEAD` — a HEAD request does not carry the payment challenge, so the route looks unpaid when it is working correctly |
| **6** | **Your first settlement writes to a shared catalog, and the write is one-way** | Know this before you settle, not after — see below |

### About the cold start — there is no warm window

This page used to claim a keep-alive held the instance warm during
`00:00–07:59` and `12:00–19:59 UTC`, and that inside those hours there was
nothing to do. **That claim was false and has been withdrawn.** The schedule
exists; the delivery does not.

Measured on 2026-08-11/12 from the workflow's own run history:

| | |
| --- | --- |
| Cron on `main` | `*/5 0-7,12-19 * * *` — 12 pings/hour |
| Actually delivered, 12:00–19:59 on 2026-08-11 | **6 runs out of 96 — 6.2%** |
| Shortest gap between consecutive runs (10 gaps) | **47 minutes** |
| Median gap | 68 minutes |
| Gaps shorter than Render's 15-minute idle timeout | **0 of 10** |

GitHub's scheduled workflows are best-effort and were delivering roughly hourly
regardless of the interval requested. Render sleeps after 15 minutes idle, so a
~60-minute ping gap leaves ~45 minutes of sleep inside every "warm" hour.
**Tightening the cron does not help** — `*/5` is already the tightest useful
value and it produced ~1 run/hour.

This is not theoretical. A cold start was measured at **44.76s at 17:01 UTC**,
inside the old advertised window, falling exactly between the 16:24 and 17:25
runs; `/health` reported `uptimeSeconds: 48` immediately afterwards, which means
the process started when the request arrived.

**Making a warm window real needs an external pinger** — a GitHub Actions cron
cannot do it. An uptime monitor on a 5-minute check (UptimeRobot's free tier,
~5 minutes to set up) is dependable in the way this is not. Note the budget
interaction before adding one: a monitor left on 24/7 keeps the instance awake
~744 h/month against a **750 h per-workspace** Free allowance, which would
suspend every Free service in the workspace. Give it a maintenance window
matching the hours you actually want, rather than leaving it always-on.

Until that exists, treat the service as **always cold** and warm it yourself.

### Your first settlement writes to a shared catalog, permanently

**Read this before you settle against the hosted instance, because it cannot be
undone afterwards.**

The catalog is global to the facilitator, and a resource is added the first time
a payment settles for it. Point a buyer at a seller running on
`http://localhost:4031/quote` — which is exactly what the walkthrough tells you
to do — and that URL is now a **public entry on a shared instance**, visible to
every agent calling `/discovery/resources`.

It is permanent in practice:

- A loopback URL can never pass ownership verification (https-only, no
  loopback), so the entry is `ownerVerified: false` **forever**, and counted in
  `/health`'s `unverifiableEntries`.
- There is no self-service removal, and no supported operator one — the runbook
  explicitly warns against deleting ownership rows to clear entries.
- The only removal path is eviction once the catalog passes `MAX_ENTRIES`.

Nothing breaks, and your payments are unaffected. The cost is borne by everyone
reading the catalog: agents see a localhost URL they cannot call, listed
alongside real resources.

**`seller.mjs` now refuses to boot in exactly this combination** — an
unverifiable resource URL (http, loopback, private range) pointed at a
non-local facilitator — and names both fixes: run a local facilitator, or set
`PUBLIC_BASE_URL`. It is deliberately narrow: a public seller on the hosted
instance is the normal deployed case and is untouched, as is a localhost seller
on a localhost facilitator. `ALLOW_UNVERIFIABLE_ON_SHARED=1` overrides it if you
genuinely mean it.

**If you would rather not leave one:** run your own facilitator for the
walkthrough (`docs/guide.md`, one command and a local database), and point at the
hosted instance only once your seller has a public https URL. If you do settle
from localhost deliberately, that is accepted here — just do it knowing it is a
one-way write to shared state.

### About that settle failure

Both reasons above mean the same thing in practice: **the transaction was never
submitted, so nothing was spent and nothing double-pays.** Retry the whole
flow — sign a fresh payload, because signatures expire in ledgers.

That is measured, not assumed. Across 13 settlement attempts in one session, 6
failed; the merchant's on-chain balance afterwards was exactly the number of
*successes* × the price, with no partial or duplicate transfers from any failed
attempt. If you want to check it yourself, read the merchant's trustline balance
on Horizon before and after — an empty `transaction` field means there is no
on-chain event to reconcile.

The rate is not stable. The doc's "1 in 3" came from earlier sessions (3/11 and
3/9); the 6/13 above was a worse day. Treat retry as mandatory, not as a rare
path. Cause not established — it looks like a testnet RPC lead rather than a
facilitator defect, which is also why the two reason codes are not meaningfully
different to a caller.

Also worth knowing: **60 requests/min per IP**, **32 KiB request bodies**, and
spend-control refusals arrive as `503 settlement_refused` with a machine-readable
`reason`. On testnet those controls are log-only, so you will not hit them here —
which also means you cannot test your handling of them here.

---

## Who this is ready for

Plainly, because the answer differs a lot by use case.

### Ready — testnet evaluation

Point a client at the hosted instance and try the loop. The full path is
live-proven with transaction hashes: a smart account paid a discoverable
resource, this facilitator settled it on-chain, and the resource became
searchable. Expect the six annoyances above.

### Ready — self-hosting for something real

Run your own instance. The code is the part that has been reviewed hardest: a
full pre-mainnet security audit with every finding tracked to closure
([`closing-state.md`](./closing-state.md)), 342 tests, and mutation-verified
controls. You supply a funded sponsor account and a libSQL/Turso database.

What you inherit that is genuinely yours to run: the sponsor pays every
settlement's network fee, so **its balance is your availability**, and the
balance guard refuses `/settle` below a hard floor rather than failing
confusingly on-chain.

### Not ready — production traffic on the hosted instance

Do not. Three reasons, none of them about the code:

1. **It is a free-tier testnet demo.** One instance, no uptime commitment, a
   ~45s cold start at any hour (there is no reliable warm window), and a sponsor
   account funded for demonstration.
2. **`stellar:testnet` only.** Testnet assets are not money.
3. **Spend controls are log-only on testnet.** The protections against a funded
   attacker are not enforced in the environment you would be evaluating them in.

### What would need to be true before production traffic

The full list with conditions is in
[`closing-state.md` §6](./closing-state.md). The three blockers:

1. **F12 demonstrated live, or accepted as unproven in writing.** It is the one
   control with no live evidence, and pubnet is where it stops being log-only and
   starts refusing real money.
2. **Thresholds reviewed against real traffic.** Every number came from a testnet
   sample of one wallet. One is known to be 22× more conservative than its name
   implies.
3. **A funded pubnet sponsor**, sized against real volume, with the balance guard
   as the actual defence — not a formality.

And two things to accept knowingly rather than discover: a squatted URL that was
already *verified* needs manual operator recovery, and whoever holds the
database credentials can forge or clear any ownership binding.
