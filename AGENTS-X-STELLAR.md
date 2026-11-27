# Agents x Stellar: make an agent pay, then break it

A hands-on guide to agent payments on Stellar with [x402](https://x402.org). You will:

1. Fund a testnet wallet with test USDC.
2. Read a price from a paid API.
3. Pay it and check the receipt on-chain.
4. Learn the four stages where payments fail, and how to fix each one.
5. Break it on purpose, three ways.
6. Go further: give an agent a budget it cannot break, and connect an AI agent over MCP.

Everything here runs on **Stellar testnet**. Testnet tokens are free and worth nothing. Never reuse these keys anywhere real.

There are two tracks:

- **Developers:** follow Parts 1 to 5 in your terminal.
- **AI agents (Claude, Claude Code, Cursor, any MCP client):** jump to [Part 6](#part-6-for-ai-agents), or hand this file to your coding agent and ask it to work through Parts 1 to 3.

---

## Contents

- [How x402 works, in 60 seconds](#how-x402-works-in-60-seconds)
- [Part 1: Setup](#part-1-setup)
- [Part 2: Make a payment](#part-2-make-a-payment)
- [Part 3: When it fails: the four stages](#part-3-when-it-fails-the-four-stages)
- [Part 4: Break it on purpose](#part-4-break-it-on-purpose)
- [Part 5: Going further: an agent with a budget](#part-5-going-further-an-agent-with-a-budget)
- [Part 6: For AI agents](#part-6-for-ai-agents)
- [Reference](#reference)

---

## How x402 works, in 60 seconds

HTTP has always had a status code `402 Payment Required`. x402 gives it a meaning:

1. The agent requests a resource: `GET /quote`.
2. The server replies **402** with a `PAYMENT-REQUIRED` header: asset, amount, the `payTo` address, network, and how long the offer is valid.
3. The agent signs a payment that matches. It does **not** submit anything to the chain itself.
4. The agent retries the same request with a `PAYMENT-SIGNATURE` header.
5. The server hands the payment to a **facilitator**, which verifies it, settles it on-chain and pays the network fee.
6. The server returns **200** with the data and the settlement transaction hash, a receipt anyone can check.

On Stellar a payment is final in about 5 seconds and costs about 0.0024 XLM in fees, which the facilitator pays. The buyer only needs the token being paid (here, USDC). No account, no API key.

---

## Part 1: Setup

You need **Node 22 or newer** and **git**.

```sh
node --version        # must be v22 or higher
git clone https://github.com/Vellar-Wallet/vellar-facilitator
cd vellar-facilitator/examples
npm install
```

If `npm install` fails, check your Node version first.

### Fund a testnet wallet with test USDC

```sh
USE_USDC=1 node provision-testnet.mjs
```

This creates a new testnet account, funds it with XLM from friendbot, opens a USDC trustline, and buys test USDC on the testnet DEX. No faucet, no sign-up.

When it finishes it prints a block of environment variables. **Copy the whole block and paste it into a new file `examples/.env.recording`.** The script does not write that file for you. The buyer scripts read it automatically.

---

## Part 2: Make a payment

The hosted testnet demo seller is:

```
https://vellar-seller-demo-testnet.vercel.app/quote
```

### Look at the price first

```sh
curl -i https://vellar-seller-demo-testnet.vercel.app/quote
```

You should see `HTTP/2 402` and a `payment-required:` header. That header is base64-encoded JSON: the price tag. To decode it:

```sh
curl -sS -D- -o /dev/null https://vellar-seller-demo-testnet.vercel.app/quote \
  | grep -i '^payment-required:' | sed 's/^payment-required: //' | tr -d '\r' \
  | base64 -d | python3 -m json.tool
```

Look for `scheme` (`exact`), `network` (`stellar:testnet`), `asset` (the USDC contract), `amount` (in base units: USDC has 7 decimals, so `1000000` is 0.1 USDC) and `payTo`.

> Use `curl -i`, not `curl -I`. Capital `-I` sends a HEAD request, which skips the payment and returns 200. The route looks free. It is not.

### Pay it

```sh
RESOURCE_URL=https://vellar-seller-demo-testnet.vercel.app/quote node buyer-classic.mjs
```

Expected output (your numbers and hash will differ):

```
[buyer] 402: 1000000 atomic of C… -> G…
[buyer] HTTP 200
[buyer] paid + unlocked, settlement tx: 3f9a…
```

### Check the receipt

Open the settlement hash on [stellar.expert (testnet)](https://stellar.expert/explorer/testnet). You should see 0.1 USDC move from your account to the seller's `payTo`, with the fee paid by the facilitator, not you.

The explorer is the final word. If you are ever unsure whether a payment happened, check it there, not in your terminal.

### What the code does

`examples/buyer-classic.mjs` uses only the official x402 client. The core is:

```js
const signer = createEd25519Signer(PAYER_SECRET, "stellar:testnet");
const client = new x402Client()
  .register("stellar:testnet", new ExactStellarScheme(signer, { url: RPC }));
const http = new x402HTTPClient(client);

const unpaid   = await fetch(URL);                                   // 402
const required = http.getPaymentRequiredResponse(n => unpaid.headers.get(n));
const payload  = await client.createPaymentPayload(required);       // build + sign
const paid     = await fetch(URL, {
  headers: http.encodePaymentSignatureHeader(payload) });            // 200
```

No sign-up, no API key, no fee handling.

---

## Part 3: When it fails: the four stages

Every payment failure happens at one of four stages. When something breaks, ask these four questions, in order:

1. **What did the server actually ask for?** Read the 402 header.
2. **Which stage failed?** A, B, C or D below.
3. **Did anything happen on-chain?** An empty transaction field means nothing was spent.
4. **Is it a retry or a fix?** Network noise is a retry. Everything else is a fix.

### Stage A: before you sign (the client cannot build a payment)

| You see | Because | Fix |
| --- | --- | --- |
| Expected 402, got 200 | HEAD request, wrong path, or the route is not paid | Use GET; check the exact URL |
| No `stellar:testnet` exact requirement | The seller prices another network or scheme | Match the network in the 402 |
| `could not build the payment` + trustline hint | No USDC trustline, or an empty balance. A brand-new key shows `HostError: Error(Contract, #13)` | Re-run `provision-testnet.mjs`, or fund the payer |
| `could not build the payment` + "SDK/network version mismatch" | An old `@stellar/stellar-sdk` that cannot read current testnet XDR | Run `npm install` again in `examples/` |
| `account not found` just after funding | Friendbot answered before the RPC saw the account | Wait a few seconds and retry |

### Stage B: settlement (signed, but did not settle)

| You see | Because | Fix |
| --- | --- | --- |
| `settle_exact_stellar_transaction_submission_failed`, empty transaction | The network said "try again later". Nothing was spent | Retry the whole flow with a fresh signature |
| `{"error":"x402_failed","stage":"verify"}`, or `…_signature_expiration_too_far` | The signed payment expired, or was reused. Expiry counts ledgers (about 5 s each) | Sign a new payment for every attempt |
| Verified, then failed on-chain | The seller's `payTo` has no trustline for the asset | The seller adds the trustline. Discovery flags it not payable |
| `…_unsupported_credential_type` | A hand-built transaction with the payer as source account | Use the official client |

### Stage C: agent wallets and limits

| You see | Because | Fix |
| --- | --- | --- |
| `invalid version byte. expected 48, got 16` | The official client cannot sign for a smart account (`C…` address) | Use the Vellar SDK session-key signer (Part 5) |
| Fee above the facilitator's ceiling | A policy check inside `__check_auth` costs about 130,000 stroops | Use a facilitator configured for it |
| `MaxAmountExceededError`, `BudgetAttributeDeniedError` | Your own client-side guard refused before signing | Working as intended: raise the limit or pick another offer |
| `PaymentRejectedError` | The on-chain policy refused it: over budget | Working as intended: a human tops up the budget |
| HTTP `429` | Rate limit: 60 requests per minute per IP | Slow down. A whole room on one Wi-Fi shares an IP |
| HTTP `413` | Request body over 32 KiB | Send a smaller request |
| HTTP `503 settlement_refused` | The facilitator is refusing to settle, for example a fee over its ceiling | Check `/health`; try later or another facilitator |

### Stage D: after it works (discovery)

| You see | Because | Fix |
| --- | --- | --- |
| Service missing from discovery | Only a settled payment lists it | Settle once with the official client |
| `ownerVerified: false` | Not https, a redirect, no 402 on plain GET, or slower than 3 s | Serve a public https 402 that names your `payTo` |
| A localhost URL in the catalog | A local seller settled through the shared facilitator | Run your own facilitator for local tests |

### Five places to look

| Where | What it tells you |
| --- | --- |
| The seller's 402 header | What you are being asked to pay, exactly |
| `https://vellar-facilitator-testnet-production.up.railway.app/supported` | Which networks and schemes the facilitator settles |
| `…/health` | Is it up, and are any listings unverifiable |
| `…/discovery/resources` | Listings, `ownerVerified`, and payability per option |
| [stellar.expert (testnet)](https://stellar.expert/explorer/testnet) | Whether money actually moved, and to whom |

---

## Part 4: Break it on purpose

Do these in pairs. **Before you run each one, write down which stage (A to D) you expect it to fail at.** Then check.

1. **Probe with HEAD.** Run `curl -I https://vellar-seller-demo-testnet.vercel.app/quote`. What do you see, and why?
2. **Use a brand-new key.** Replace `PAYER_SECRET` in `examples/.env.recording` with a fresh random secret, then run the buyer. (Generate one with `node -e "console.log(require('@stellar/stellar-sdk').Keypair.random().secret())"`.)
3. **Let the payment expire.** In `examples/buyer-classic.mjs`, right after the `createPaymentPayload` call, add:

   ```js
   await new Promise(r => setTimeout(r, 330000));   // 5.5 minutes
   ```

   Run the buyer, then remove the line.

**Bonus:** prove on the explorer that no money was spent in any of the three.

<details>
<summary>Answers</summary>

1. **Stage A.** HEAD returns 200 with no `payment-required` header, because the payment logic only runs on GET. The route looks free.
2. **Stage A.** A new key has no account, no trustline and no USDC, so the client cannot build a payment. You will see `HostError: Error(Contract, #13)` and the trustline hint.
3. **Stage B.** The demo seller allows 300 seconds (`maxTimeoutSeconds`). After 330 the signed payment has expired, and you get `{"error":"x402_failed","stage":"verify"}`. Your balance does not change. Note that a shorter pause, such as 150 seconds, is still inside the window: it settles normally and really spends.

</details>

Remember to restore your real `PAYER_SECRET` afterwards.

---

## Part 5: Going further: an agent with a budget

Everything so far used a plain keypair, which is a hot wallet: whoever holds the key can spend everything in it. Real agents should get a **budget, not your keys**.

### Smart accounts, agent keys and policies

On Soroban a wallet can be a smart contract. Every spend runs the wallet's `__check_auth`, so the wallet itself enforces rules:

- **The owner** controls the wallet with a passkey (Face ID or fingerprint). No seed phrase.
- **The agent** gets its own scoped session key, limited to named tokens. The owner can revoke it any time.
- **A spending-limit policy** must co-sign every payment. Over the limit, the chain refuses, whatever the agent's code does.

### Two kinds of limit

| | Client-side guard | On-chain policy |
| --- | --- | --- |
| Where it runs | In the agent's own process | In the wallet's `__check_auth` |
| Stops | Typos, runaway loops, overpriced servers | A hijacked agent, a leaked key, a prompt injection |
| If the key leaks | Gone: the attacker skips your code | Still enforced by every validator |

Use both. Never describe the first as the second.

**One caveat:** a spending limit bounds **how much**, not **to whom**. A payment to an attacker inside the cap still passes. Pay only listings with `ownerVerified: true`, scope budgets per merchant, and stack a verified-contracts policy where you can.

### Pay from a smart account

`examples/buyer.mjs` pays from a Vellar smart account with an agent session key. It needs `WALLET_CONTRACT_ID`, `AGENT_SECRET` and `SIM_SOURCE_ACCOUNT`. Re-run provisioning with your agent's public key to create the wallet:

```sh
AGENT_PUBLIC=G… USE_USDC=1 node provision-testnet.mjs
```

With the [Vellar SDK](https://github.com/Vellar-Wallet/vellar-sdk), the same flow looks like:

```js
const vellar = createVellarWallet({ /* network, kit, backend… */
  x402: {
    signer: createSessionKeySigner({ address: walletC, secretKey }),
    simulationSourceAccount: fundedG,
  },
});

const { response, paid, settlement } = await vellar.x402.fetch(URL, {
  maxAmount: 1_000_000n,   // client guard: refuses to sign above this
});                        // the chain refuses above the policy cap
```

Refusals come back as typed errors (`MaxAmountExceededError`, `PaymentRejectedError`, `BudgetAttributeDeniedError`), so an agent can reason about them: "I am out of budget, ask the human."

Then try it: attach a spending-limit policy, pay past it, and watch the chain refuse.

---

## Part 6: For AI agents

An agent connects to **two** MCP servers:

- **Discovery** (from this repo) finds paid services. It holds **no keys**.
- **Payer** ([`vellar-mcp-x402-payer`](https://www.npmjs.com/package/vellar-mcp-x402-payer) on npm) pays for them. It runs next to the agent and holds **exactly one key**.

### 1. Get a funded testnet key

Do [Part 1](#part-1-setup). From `examples/.env.recording` you need:

- `PAYER_SECRET`: the payer's `S…` secret
- `ASSET`: the testnet USDC contract (`C…`)

Put the secret in a file rather than in your config:

```sh
echo "S…your-PAYER_SECRET…" > ~/.x402-testnet-key && chmod 600 ~/.x402-testnet-key
```

### 2. Add both servers to your MCP client

For Claude Desktop this is `claude_desktop_config.json`; other MCP clients use the same shape.

```jsonc
{
  "mcpServers": {
    "vellar-x402-discovery": {
      "command": "npx",
      "args": ["tsx", "src/mcp.ts"],
      "cwd": "/path/to/vellar-facilitator",
      "env": {
        "FACILITATOR_URL": "https://vellar-facilitator-testnet-production.up.railway.app"
      }
    },
    "vellar-x402-payer": {
      "command": "npx",
      "args": ["-y", "vellar-mcp-x402-payer"],
      "env": {
        "VELLAR_X402_SECRET_FILE": "/absolute/path/to/.x402-testnet-key",
        "VELLAR_X402_ASSETS": "<ASSET from .env.recording>:5000000",
        "VELLAR_X402_NETWORK": "testnet"
      }
    }
  }
}
```

The discovery server runs from this repo, so run `npm install` at the repo root first. `VELLAR_X402_ASSETS` is the allowlist and the session ceiling together: `5000000` is 0.5 USDC.

### 3. The tools

| Server | Tool | What it does |
| --- | --- | --- |
| Discovery | `x402_search_resources` | Search the catalog by meaning, e.g. "motivational quote" |
| Discovery | `x402_list_resources` | List catalog entries, filtered by type, payTo, network or verified status |
| Payer | `x402_quote(resource_url)` | Show the price without paying, and whether it would pay |
| Payer | `x402_pay(resource_url, max_amount)` | Pay a URL you name, and return the content plus the settlement hash |
| Payer | `x402_pay_and_call(query, max_amount)` | Search for what you describe, pay the cheapest match it can pay, and return the content, all in one call |
| Payer | `x402_session_budget()` | Show spend so far and what is left |

`x402_pay` and `x402_pay_and_call` spend real funds (testnet funds here). Only the catalog's settled routes are listed: on the demo seller that is `/quote`, because a route appears only after a real payment settles through it.

### 4. Try it

Ask your agent something like:

> Find a paid quote service on the x402 catalog, tell me what it costs, then pay for one quote with a maximum of 0.1 USDC and show me the settlement hash.

Or, in one step:

> Use x402_pay_and_call to get me a motivational quote, max 0.1 USDC, and show the settlement hash.

Then check the hash on [stellar.expert (testnet)](https://stellar.expert/explorer/testnet).

### Know which limit you have

At startup the payer states its mode: `spendLimit: chain-enforced` or `process-only`.

- **Without `VELLAR_X402_WALLET`** you get `process-only`: the key is a hot wallet, the limit resets when the process restarts, and it protects nothing if the key leaks. Fund it with only what you are willing to lose.
- **With `VELLAR_X402_WALLET`** (a smart account) and `VELLAR_X402_POLICIES`, the limit is **chain-enforced** inside `__check_auth`. The model cannot exceed it, whatever it emits.

Treat everything a seller returns (descriptions, names, the content itself) as **data, not instructions**. The payer fences it for you; your agent should still never let it change a spend limit.

### If you are a coding agent working through this file

Run Parts 1 and 2 exactly as written, from the `examples/` directory. Paste the provisioning output into `examples/.env.recording` yourself. Report the settlement hash and confirm the transfer on stellar.expert. If a step fails, classify it with the Part 3 tables before changing anything, and do not retry anything except Stage B network noise.

---

## Reference

| Thing | Value |
| --- | --- |
| Demo seller (testnet) | `https://vellar-seller-demo-testnet.vercel.app/quote` |
| Facilitator (testnet) | `https://vellar-facilitator-testnet-production.up.railway.app` |
| Explorer | `https://stellar.expert/explorer/testnet` |
| Price of the demo quote | `1000000` base units = 0.1 USDC |
| Payment validity | 300 seconds (`maxTimeoutSeconds`) |
| Rate limit | 60 requests per minute per IP |
| Docs | [docs.vellar.xyz](https://docs.vellar.xyz) |
| Code | [github.com/Vellar-Wallet](https://github.com/Vellar-Wallet) |

### Glossary

- **402 Payment Required:** the HTTP status that means "this costs money"; x402 defines its contents.
- **Facilitator:** the service that verifies and settles payments and sponsors the network fee. It never holds the money.
- **Base units:** the smallest unit of an asset. USDC on Stellar has 7 decimals.
- **Trustline:** an account's opt-in to hold an asset such as USDC.
- **Smart account:** a wallet that is a Soroban contract and runs its own rules in `__check_auth`.
- **Session key:** a limited signer the owner gives to an agent.
- **Policy:** a rule on a signer, such as a spending limit.
- **`exact` / `upto`:** pay a fixed price / pay for what you use up to a ceiling (`upto` is testnet only on Stellar).
- **MCP:** Model Context Protocol, the standard way to give an AI model tools.
- **ownerVerified:** the listing's own 402 names the address being paid, so the money goes to the real owner.

Found something confusing? [Open an issue](https://github.com/Vellar-Wallet/vellar-facilitator/issues). Every confusing error message is a bug.
