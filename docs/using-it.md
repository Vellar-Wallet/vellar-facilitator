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

**Your account needs a trustline to the payment asset**, or settlement fails
on-chain after everything else has succeeded.

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

This is recoverable without an operator: settle once, and if your 402 names your
address, you take the binding back automatically (displacement). What is *not*
automatic is changing the address on a binding that was already verified — that
needs [runbook §1](./operator-runbook.md).

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
- **`statsSource`** — `"observed"` means every settlement was witnessed by the
  running process; `"persisted"` means part of the count was loaded from storage
  and cannot be re-derived from the chain. `observedSettlements` is the number to
  trust.
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

**A smart account is optional.** The examples use a Vellar smart account with an
ed25519 session key — the "agent with a budget" pattern, where an on-chain policy
contract constrains what the key may spend. A classic keypair works fine. The
reason the examples use one: policy-governed accounts run their policy inside
`__check_auth`, which pushes the simulated fee to ~130k stroops, and facilitators
defaulting to a 50k ceiling reject them. This one defaults to 500,000.

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

```
1. GET the resource                    → 402 + PAYMENT-REQUIRED header
2. Build the SEP-41 transfer            (from you, to payTo, amount)
3. Sign your auth entry
4. Echo required.extensions into the payload   ← this is what catalogs it
5. Retry with PAYMENT-SIGNATURE: base64(payload) → 200 + content
```

**Copy from `examples/buyer.mjs`** — it is the exact signing code proven against
this facilitator, including the smart-account auth-entry shape, which is the part
worth not reinventing.

Two things that will cost you time otherwise:

- **Step 4 is not optional if you want discovery to work.** Echoing the
  extensions is what tells the facilitator to catalog the resource. Skip it and
  the payment succeeds and nothing is listed.
- **Signatures expire in ledgers (~5s each), not wall-clock.** The examples sign
  for current + 12. Do not cache a signed payload.

---

## What will bite you on the hosted instance

Five things, in the order you will meet them.

| | What | What to do |
| --- | --- | --- |
| **1** | **~50s on the first request after 15 min idle.** The free tier replaces the container; measured cold start 42s | Set a generous client timeout, or send a warming `GET /health` before a real call. `/health` is exempt from rate limiting |
| **2** | **Roughly 1 settle in 3 fails** with `settle_exact_stellar_transaction_submission_failed` and an empty `transaction` | **Retry.** It fails before the chain sees anything, so nothing was spent and nothing double-pays. Observed at 3/11 and 3/9 across two sessions; cause not established — a testnet RPC lead, not a facilitator defect |
| **3** | **Trust badges are inert.** `verification` and `acceptsVerification` are always `"unknown"` | Read `ownerVerified` instead — that one works. The badge source is deployed nowhere and is not switching on soon (README has the dependency chain) |
| **4** | **`?verified_only=true` returns an empty list** | Do not use it. It filters on the inert field |
| **5** | **`pagination.total` ignores `verified_only`** | You will see `items: []` alongside `total: 1`. Trust `items.length` |

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
searchable. Expect the five annoyances above.

### Ready — self-hosting for something real

Run your own instance. The code is the part that has been reviewed hardest: a
full pre-mainnet security audit with every finding tracked to closure
([`closing-state.md`](./closing-state.md)), 327 tests, and mutation-verified
controls. You supply a funded sponsor account and a libSQL/Turso database.

What you inherit that is genuinely yours to run: the sponsor pays every
settlement's network fee, so **its balance is your availability**, and the
balance guard refuses `/settle` below a hard floor rather than failing
confusingly on-chain.

### Not ready — production traffic on the hosted instance

Do not. Three reasons, none of them about the code:

1. **It is a free-tier testnet demo.** One instance, no uptime commitment, a 50s
   cold start, and a sponsor account funded for demonstration.
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
