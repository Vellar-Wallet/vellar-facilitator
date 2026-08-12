// Provision everything you need to run the x402 loop on Stellar testnet.
//
// WHY THIS EXISTS
// ---------------
// The facilitator settles payments in a SEP-41 token. It does not care which
// one — but you must hold some, and you cannot hold the token used by this
// project's demo seller (X402TST / CDYCX4PE…): its issuer keypair is generated
// in-process by a throwaway script and its secret no longer exists anywhere.
// Nobody can mint it. So you bring your own token, and this script makes one.
//
// WHAT IT CREATES (testnet only)
//   • an issuer account + a Stellar Asset Contract (SAC) for a new token
//   • a merchant account with a trustline  ← your `payTo`
//   • a classic payer account with a trustline and a balance  ← your buyer
//   • optionally, a Vellar smart account with your ed25519 agent key as signer
//     (only when AGENT_PUBLIC is set; needs passkey-kit-sdk)
//
// It prints a paste-ready env block at the end.
//
// USAGE
//   cd examples && npm install
//   node provision-testnet.mjs                       # classic payer only
//   AGENT_PUBLIC=G... node provision-testnet.mjs      # also a smart account
//
//   ASSET_CODE=MYTOKEN   override the token code (default X402DEV, ≤12 alnum)
//
// TESTNET ONLY. It prints secret keys to stdout, because you need the payer's
// secret to run a buyer. Never point this at pubnet and never reuse these keys.

import {
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const HORIZON = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const ASSET_CODE = process.env.ASSET_CODE || "X402DEV";

// The Vellar smart-account (passkey-kit) wallet contract already installed on
// testnet. Only used by the optional AGENT_PUBLIC branch.
//
// This is the one value here that can rot without anything failing loudly: it
// pins a wasm someone else uploaded, so if that install is archived or you want
// a different wallet build, `Client.deploy` fails with a wasm-not-found error
// that does not name this constant. Override with WALLET_WASM_HASH.
// Last verified working: 2026-08-11 (wallet CDKIAPI3…, settlement e8581537…).
const WALLET_WASM_HASH =
  process.env.WALLET_WASM_HASH || "fdefad64b96837147e1c333e51f537b696eab925e9f147e63d597c04e3c903f0";

const PAYER_MINT_ATOMIC = 1_000_000_000n; // 100 tokens @ 7 decimals
const MERCHANT_SEED_UNITS = "1"; // so the merchant's trustline is visibly live

if (!/^[A-Za-z0-9]{1,12}$/.test(ASSET_CODE)) {
  console.error(`ASSET_CODE must be 1-12 alphanumeric characters, got "${ASSET_CODE}"`);
  process.exit(1);
}
const agentPublic = process.env.AGENT_PUBLIC;
if (agentPublic && !StrKey.isValidEd25519PublicKey(agentPublic)) {
  console.error("AGENT_PUBLIC must be a valid G… ed25519 public key");
  process.exit(1);
}

const server = new rpc.Server(RPC_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry helper. soroban-testnet.stellar.org is load-balanced across nodes whose
 * ledger states drift, so a read that succeeds on one node can 404 on the next
 * call. Everything that touches the network goes through this.
 */
async function retry(label, fn, attempts = 6) {
  for (let a = 1; ; a++) {
    try {
      return await fn();
    } catch (err) {
      if (a >= attempts) throw new Error(`${label}: gave up after ${attempts} attempts — ${err.message}`);
      console.log(`  [retry ${a}/${attempts - 1}] ${label}: ${String(err.message ?? err).slice(0, 100)}`);
      await sleep(3000 * a);
    }
  }
}

/**
 * Fund an account and WAIT until the RPC can actually see it.
 *
 * Friendbot returning 200 does not mean the account is visible to Soroban RPC —
 * and because the RPC is load-balanced, one successful read does not mean the
 * next one hits a node that has caught up. We require three consecutive reads.
 */
async function fundAndWait(pub) {
  const res = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  // 400 usually means "already funded", which is fine; anything else is not.
  if (!res.ok && res.status !== 400) {
    throw new Error(`friendbot ${pub.slice(0, 6)}…: HTTP ${res.status}`);
  }
  let streak = 0;
  for (let i = 0; i < 60; i++) {
    try {
      await server.getAccount(pub);
      if (++streak >= 3) return;
    } catch {
      streak = 0;
    }
    await sleep(2000);
  }
  throw new Error(`${pub.slice(0, 6)}…: funded but never became visible to the RPC`);
}

/**
 * Build, sign and submit. Only Soroban operations may be passed through
 * `prepareTransaction` — it rejects classic operations such as changeTrust and
 * payment outright with "unsupported operation type", so we skip it for those.
 */
async function submit(label, kp, ops) {
  return retry(label, async () => {
    const acct = await server.getAccount(kp.publicKey());
    let tx = new TransactionBuilder(acct, { fee: "1000000", networkPassphrase: PASSPHRASE });
    for (const op of ops) tx = tx.addOperation(op);
    tx = tx.setTimeout(120).build();

    const needsSoroban = tx.operations.some(
      (o) =>
        o.type === "invokeHostFunction" ||
        o.type === "extendFootprintTtl" ||
        o.type === "restoreFootprint",
    );
    if (needsSoroban) tx = await server.prepareTransaction(tx);

    tx.sign(kp);
    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR") {
      throw new Error(`send rejected: ${JSON.stringify(sent.errorResult ?? sent.status)}`);
    }
    for (let i = 0; i < 45; i++) {
      await sleep(1500);
      const got = await server.getTransaction(sent.hash);
      if (got.status === "SUCCESS") return sent.hash;
      if (got.status === "FAILED") throw new Error(`tx FAILED (${sent.hash})`);
    }
    throw new Error(`timed out awaiting ${sent.hash}`);
  });
}

// ---------------------------------------------------------------------------

const issuer = Keypair.random();
const merchant = Keypair.random();
const payer = Keypair.random();
const deployer = Keypair.random();
// A funded account used ONLY to simulate. It must be distinct from the payer:
// when the payer is also the transaction source, Soroban authorizes with
// source-account credentials, and the facilitator's scheme accepts only address
// credentials. Its secret is never needed, so it is never printed.
const simSource = Keypair.random();

const asset = new Asset(ASSET_CODE, issuer.publicKey());
const sacId = asset.contractId(PASSPHRASE);

console.log(`\nProvisioning ${ASSET_CODE} on testnet — this takes 2-4 minutes.\n`);

console.log("[1/7] funding accounts (friendbot, then waiting for RPC visibility)…");
await Promise.all([issuer, merchant, payer, deployer, simSource].map((k) => fundAndWait(k.publicKey())));
console.log("  ok — 5 accounts funded and visible");

console.log(`[2/7] deploying the SAC for ${ASSET_CODE}:${issuer.publicKey().slice(0, 6)}…`);
const sacHash = await submit("sac-deploy", deployer, [Operation.createStellarAssetContract({ asset })]);
console.log(`  ok — ${sacId}`);

console.log("[3/7] waiting for the contract instance to be readable…");
await retry("sac-live", async () => {
  const acct = await server.getAccount(deployer.publicKey());
  const probe = new TransactionBuilder(acct, { fee: "1000000", networkPassphrase: PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract: sacId, function: "decimals", args: [] }))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(probe);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error("contract instance not live yet");
  return scValToNative(sim.result.retval);
});
console.log("  ok — decimals: 7");

console.log("[4/7] adding trustlines (merchant + payer)…");
await submit("merchant-trustline", merchant, [Operation.changeTrust({ asset })]);
await submit("payer-trustline", payer, [Operation.changeTrust({ asset })]);
console.log("  ok — both trustlines live");

console.log("[5/7] funding the payer with tokens…");
const mintHash = await submit("mint-to-payer", issuer, [
  Operation.invokeContractFunction({
    contract: sacId,
    function: "mint",
    args: [nativeToScVal(payer.publicKey(), { type: "address" }), nativeToScVal(PAYER_MINT_ATOMIC, { type: "i128" })],
  }),
]);
await submit("seed-merchant", issuer, [
  Operation.payment({ destination: merchant.publicKey(), asset, amount: MERCHANT_SEED_UNITS }),
]);
console.log(`  ok — payer holds ${PAYER_MINT_ATOMIC} atomic (100 ${ASSET_CODE})`);

let walletId;
if (agentPublic) {
  console.log("[6/7] deploying a Vellar smart account with your agent key…");
  const { Client } = await import("passkey-kit-sdk");
  const { basicNodeSigner } = await import("@stellar/stellar-sdk/contract");
  const deployTx = await retry("wallet-deploy", () =>
    Client.deploy(
      {
        signer: {
          tag: "Ed25519",
          values: [
            Buffer.from(StrKey.decodeEd25519PublicKey(agentPublic)),
            [undefined],
            [undefined],
            { tag: "Persistent", values: undefined },
          ],
        },
      },
      {
        rpcUrl: RPC_URL,
        networkPassphrase: PASSPHRASE,
        wasmHash: WALLET_WASM_HASH,
        publicKey: deployer.publicKey(),
        ...basicNodeSigner(deployer, PASSPHRASE),
        timeoutInSeconds: 120,
      },
    ),
  );
  const { result: walletClient } = await deployTx.signAndSend();
  walletId = walletClient.options.contractId;
  await submit("mint-to-wallet", issuer, [
    Operation.invokeContractFunction({
      contract: sacId,
      function: "mint",
      args: [nativeToScVal(walletId, { type: "address" }), nativeToScVal(PAYER_MINT_ATOMIC, { type: "i128" })],
    }),
  ]);
  console.log(`  ok — ${walletId} (funded)`);
} else {
  console.log("[6/7] skipping the smart account (set AGENT_PUBLIC to create one)");
}

console.log("[7/7] verifying on-chain state…");
for (const [label, kp] of [
  ["merchant", merchant],
  ["payer", payer],
]) {
  const acct = await (await fetch(`${HORIZON}/accounts/${kp.publicKey()}`)).json();
  const line = (acct.balances ?? []).find(
    (b) => b.asset_code === ASSET_CODE && b.asset_issuer === issuer.publicKey(),
  );
  if (!line) throw new Error(`${label} trustline missing after provisioning`);
  console.log(`  ok — ${label} balance: ${line.balance}`);
}

console.log(`
════════════════════════════════════════════════════════════════════════════
  Done. Paste this into examples/.env.recording (testnet keys — do not reuse)
════════════════════════════════════════════════════════════════════════════

# Local by default: the walkthrough runs a localhost seller, and a localhost URL
# written to the SHARED hosted catalog is public and permanent. Point at the
# hosted instance only once your seller has a public https address.
FACILITATOR_URL=http://localhost:4100
STELLAR_RPC_URL=${RPC_URL}

# The token you just created. This is YOUR asset — you can mint more.
ASSET=${sacId}
ASSET_CODE_ISSUER=${ASSET_CODE}:${issuer.publicKey()}
ISSUER_SECRET=${issuer.secret()}

# Seller (the paid API)
PAYTO=${merchant.publicKey()}
MERCHANT_SECRET=${merchant.secret()}
PRICE_ATOMIC=1000000
SELLER_PORT=4031

# Buyer — classic keypair (works with buyer-classic.mjs)
PAYER_SECRET=${payer.secret()}
# Simulate-only, never charged, never signs. MUST differ from the payer.
# Needed by buyer.mjs (smart account) ONLY — buyer-classic.mjs ignores it.
SIM_SOURCE_ACCOUNT=${simSource.publicKey()}
${
  walletId
    ? `
# Buyer — smart account (works with buyer.mjs); pair with your AGENT_SECRET
WALLET_CONTRACT_ID=${walletId}
AGENT_PUBLIC=${agentPublic}`
    : `
# No smart account was created. Re-run with AGENT_PUBLIC=G… if you want one.`
}

Next:
  1. Start the seller:
       PAYTO=${merchant.publicKey()} \\
       ASSET=${sacId} \\
       node seller.mjs
  2. Pay it (classic keypair — the values above are already in .env.recording):
       RESOURCE_URL=http://127.0.0.1:4031/quote \\
       PAYER_SECRET=${payer.secret()} \\
       node buyer-classic.mjs

  Roughly 1 settle in 3 fails on testnet with an empty transaction — retry it.
  Nothing is spent when that happens.
════════════════════════════════════════════════════════════════════════════
`);
