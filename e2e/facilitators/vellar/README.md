# Running the x402-foundation e2e suite against the live Vellar facilitator

This directory is the proxy configuration used to produce the C1 result in
[`docs/conformance-report.md`](../../../docs/conformance-report.md) §6.1. It
exists so a reviewer can recreate that run exactly rather than take the report's
word for it.

**Result being reproduced:** 6 passed / 4 failed, six settled testnet
transactions confirmed on Horizon, against `x402-foundation/x402` HEAD
`241df66` on 2026-09-08.

---

## Why a proxy is needed at all

The e2e suite starts each facilitator as a **local process on a port it
assigns**, then points the resource server at it. There is no flag that says
"call this URL instead". Setting `FACILITATOR_URL` does **not** do it —
that variable tells the *resource server* which facilitator to call, and the
harness will still have started its own bundled one.

Per the suite's own `e2e/facilitators/external-proxies/README.md`, external
facilitators must live in a proxy directory carrying a `test.config.json`, are
"not selected by default", and "require explicit selection". `index.ts` here is
a transparent relay: it adds no behaviour, so the suite measures the deployed
service.

> If you skip this step and simply export `FACILITATOR_URL`, the suite will run
> green **against its own bundled reference facilitator** and tell you nothing
> about Vellar. That is a false pass, and it is the specific trap this README
> exists to prevent.

---

## Prerequisites

Three funded Stellar testnet accounts. Client and server need a **USDC
trustline**; the client needs **testnet USDC**; the facilitator account needs
XLM only.

1. Generate three keypairs and fund each with
   [Friendbot](https://friendbot.stellar.org/?addr=PUBLIC_KEY).
2. Add a USDC trustline to the **client** and **server** accounts.
   Testnet USDC issuer: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
3. Fund the **client** with testnet USDC from
   [faucet.circle.com](https://faucet.circle.com) (select Stellar testnet).
   The routes cost `$0.001` each, so a minimal drip is ample.

## Setup

```bash
git clone --depth 1 https://github.com/x402-foundation/x402
cd x402

# 1. Build the workspace packages the e2e suite depends on.
#    NOTE: plain `pnpm build` does NOT work — @x402/evm exhausts the JS heap
#    (ERR_WORKER_OUT_OF_MEMORY) and aborts turbo before @x402/stellar compiles,
#    while still reporting tasks as "successful" with empty dist/ directories.
cd typescript
pnpm install
NODE_OPTIONS=--max-old-space-size=8192 npx turbo run build --filter=@x402/stellar...
cd ..

# 2. Install the e2e workspace.
cd e2e
pnpm install

# 3. Install this proxy.
mkdir -p facilitators/external-proxies/local
cp -r /path/to/vellar-facilitator/e2e/facilitators/vellar \
      facilitators/external-proxies/local/vellar
```

## Credentials

```bash
cd e2e
cat > .env <<'EOF'
SERVER_STELLAR_ADDRESS=G...            # server public key
CLIENT_STELLAR_PRIVATE_KEY=S...        # client secret (holds USDC)
FACILITATOR_STELLAR_PRIVATE_KEY=S...   # facilitator secret (XLM only)
EOF
chmod 600 .env

# The suite's own gate reads process.env and does NOT load .env itself,
# so the variables must be exported:
set -a; . ./.env; set +a

npx tsx scripts/ci-select-families.ts   # must print: stellar
```

If that prints `No protocol families have all required wallet secrets
configured`, the variables are not **exported** — it does not mean they are
missing from `.env`.

## Run

```bash
cd e2e
set -a; . ./.env; set +a
pnpm test --testnet --min --families=stellar --versions=2 --facilitators=vellar
```

To point at a different deployment, export `VELLAR_FACILITATOR_URL`.

## What a correct result looks like

```
🏛️ Starting facilitator: vellar on port 4027
✅ Passed: 6    ❌ Failed: 4    📈 Total: 10
```

Confirm each reported hash independently rather than trusting the summary:

```bash
curl -s https://horizon-testnet.stellar.org/transactions/<HASH> \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['successful'],d['ledger'],d['fee_account'])"
```

`fee_account` should be the facilitator's sponsor
(`GBUCR6H22CZC5OYHBJIEUS2JFZBOB63AHEGTCV6UEPMD2TMLKG2ZMIW4`) and **not** the
payer — that difference is the on-chain evidence for `areFeesSponsored: true`.

## The four scenarios that do not execute — and why they are not Vellar's fault

Tests 3, 4, 9 and 10 fail with `Error: Server failed to start`:

| # | Server | Cause |
|---|---|---|
| 3, 4 | `typescript/http/next` | Next.js server exits 1 during startup |
| 9, 10 | `typescript/mcp` | MCP server exits 1 during startup |

**No payment is attempted and no request reaches the facilitator** on these
four — the harness never gets far enough to make one.

Verify the attribution yourself rather than accepting it. Run the same command
against the suite's bundled reference facilitator:

```bash
pnpm test --testnet --min --families=stellar --versions=2 --facilitators=typescript
```

That control produces the **identical** failure set — 6 passed, 4 failed, the
same two servers, the same error. A component that fails the same way against
the upstream reference implementation is an upstream/environment build problem,
not a property of the facilitator under test.

## Scope of what this proves

- ✅ testnet, `exact` scheme, `express` / `hono` / `fastify` servers, `fetch`
  and `axios` clients.
- ❌ **not** pubnet — no pubnet deployment exists
  ([`docs/conformance-report.md`](../../../docs/conformance-report.md) §6.2).
- ❌ **not** the MCP transport, and **not** the `upto` scheme — the upstream
  Stellar catalog declares neither.
