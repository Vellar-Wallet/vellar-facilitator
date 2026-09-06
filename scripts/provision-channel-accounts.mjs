#!/usr/bin/env node
// Provision the 50 channel accounts the facilitator needs to boot.
//
// WHY THIS EXISTS. `CHANNEL_ACCOUNT_SECRET_KEYS` became REQUIRED with no
// default when the channel pool shipped (6f5de85, 2026-08-31), and
// .github/workflows/settle-probe.yml was never updated. The facilitator has
// refused to boot in CI on every scheduled run since that commit — the probe
// failed 24 consecutive times with `curl: (7) Failed to connect to localhost
// port 4100`, because the real error was written to facilitator.log and never
// surfaced. This script is the missing provisioning step.
//
// WHY NOT 50 FRIENDBOT CALLS. Friendbot is rate-limited and slow; 50 sequential
// calls is minutes of wall clock and a new flake surface on a job that already
// takes six. Channel accounts need only the Stellar minimum reserve (never a
// fee budget — the sponsor is the feeBumpSigner, docs/channel-pool-design.md
// §5/§6), so they are created straight from the already-friendbot-funded
// sponsor with `createAccount` ops batched into a handful of transactions.
//
// Prints `CHANNEL_ACCOUNT_SECRET_KEYS=<50 comma-separated secrets>` on stdout
// for `>> "$GITHUB_OUTPUT"`. Everything else goes to stderr so the output line
// is the only thing on stdout.
//
// Env: SPONSOR_SECRET (required), STELLAR_RPC_URL, CHANNEL_STARTING_BALANCE.

import { Keypair, Operation, TransactionBuilder, rpc } from "@stellar/stellar-sdk";

const PASSPHRASE = "Test SDF Network ; September 2015";
const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
/** Locked at 50 by src/config.ts's parseChannelAccountSecretKeys, which rejects
 *  any other count rather than trimming or padding. */
const POOL_SIZE = 50;
/** Comfortably above the 1 XLM a subentry-free account needs, and far below the
 *  ~10,000 XLM friendbot grants the sponsor — so one friendbot call covers all
 *  50 with room to spare. */
const STARTING_BALANCE = process.env.CHANNEL_STARTING_BALANCE || "5";
/** Stellar allows 100 ops/tx; 25 keeps each transaction small enough to confirm
 *  quickly and bounds the blast radius if one submission has to be retried. */
const OPS_PER_TX = 25;

const sponsorSecret = process.env.SPONSOR_SECRET;
if (!sponsorSecret) {
  console.error("SPONSOR_SECRET is required (the friendbot-funded sponsor for this run)");
  process.exit(1);
}

const server = new rpc.Server(RPC_URL);
const sponsor = Keypair.fromSecret(sponsorSecret);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Submit one transaction and wait for it to actually confirm. Same shape as
 *  scripts/run-load-test.js's own `submit` — sendTransaction returning PENDING
 *  is not confirmation. */
async function submit(label, ops) {
  // Sequence is re-read per transaction: these are submitted in series from one
  // source account, so each build must see the previous one's consumed sequence.
  const account = await server.getAccount(sponsor.publicKey());
  let tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE });
  for (const op of ops) tx = tx.addOperation(op);
  tx = tx.setTimeout(120).build();
  tx.sign(sponsor);

  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(`${label}: send rejected — ${JSON.stringify(sent.errorResult ?? sent.status)}`);
  }
  for (let i = 0; i < 45; i++) {
    await sleep(1500);
    const got = await server.getTransaction(sent.hash);
    if (got.status === "SUCCESS") return sent.hash;
    if (got.status === "FAILED") throw new Error(`${label}: ${sent.hash} FAILED on-chain`);
  }
  throw new Error(`${label}: ${sent.hash} never confirmed`);
}

const channels = Array.from({ length: POOL_SIZE }, () => Keypair.random());

// The same invariants config.ts enforces at boot, asserted here so a violation
// surfaces in provisioning rather than as an opaque boot failure two steps later.
const secrets = channels.map((k) => k.secret());
if (new Set(secrets).size !== POOL_SIZE) throw new Error("duplicate channel key generated");
if (secrets.includes(sponsor.secret())) throw new Error("sponsor key landed in the channel pool");

console.error(`[provision] creating ${POOL_SIZE} channel accounts @ ${STARTING_BALANCE} XLM from ${sponsor.publicKey().slice(0, 8)}…`);

for (let i = 0; i < channels.length; i += OPS_PER_TX) {
  const batch = channels.slice(i, i + OPS_PER_TX);
  const ops = batch.map((kp) =>
    Operation.createAccount({ destination: kp.publicKey(), startingBalance: STARTING_BALANCE }),
  );
  const hash = await submit(`createAccount[${i}..${i + batch.length - 1}]`, ops);
  console.error(`[provision]   ${batch.length} accounts created — ${hash}`);
}

// Confirm the pool is visible to the RPC before the facilitator tries to use it.
// friendbot/createAccount returning success does not mean the RPC can see the
// account yet, and a settle against an invisible source account fails in a way
// that looks like a facilitator bug.
console.error("[provision] waiting for the RPC to see every channel account…");
for (const kp of channels) {
  let seen = false;
  for (let i = 0; i < 30 && !seen; i++) {
    try {
      await server.getAccount(kp.publicKey());
      seen = true;
    } catch {
      await sleep(1000);
    }
  }
  if (!seen) throw new Error(`${kp.publicKey().slice(0, 8)}…: created but never visible to the RPC`);
}

console.error(`[provision] all ${POOL_SIZE} channel accounts funded and visible`);
console.log(`CHANNEL_ACCOUNT_SECRET_KEYS=${secrets.join(",")}`);
