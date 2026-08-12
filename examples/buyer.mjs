// Example 2 — BUYER: an agent pays for a discoverable x402 resource.
//
// Flow: hit the paid endpoint → 402 with requirements + the bazaar discovery
// extension → build the SEP-41 transfer as a smart-account auth entry → sign
// with the agent's ed25519 session key (V1 credentials) → ECHO the discovery
// extension into the payment payload → retry with PAYMENT-SIGNATURE → 200.
//
// The echo is what feeds Bazaar: the facilitator catalogs the resource when
// this payment settles. After a successful run, the resource is visible at
// GET {facilitator}/discovery/resources and /discovery/search.
//
// The signing pattern is the one live-proven in vela-wallet's x402 spike
// (docs/decisions.md 2026-07-26): a policy-governed Vellar smart account with
// an ed25519 agent signer, no passkey, budget enforced on-chain.
//
// WHY THIS FILE IS HAND-ROLLED AND buyer-classic.mjs IS NOT
// --------------------------------------------------------
// Not a style choice, and not something to "fix" by porting this file onto the
// official client the way buyer-classic.mjs was. The official client CANNOT
// express a smart-account signature today. Traced through the published code:
//
//   1. `@x402/stellar/exact/client` signs via
//      `tx.signAuthEntries({ address, signAuthEntry, expiration })` and never
//      passes an `authorizeEntry` override.
//   2. `AssembledTransaction.signAuthEntries` narrows whatever your signer
//      returns to a NAKED BUFFER — `Buffer.from(signedAuthEntry, "base64")`.
//   3. A naked buffer sends `authorizeEntry` down the ed25519 branch, which
//      calls `Keypair.fromPublicKey()` on the auth entry's own address. For a
//      smart account that address is a C-address, and it throws:
//      `invalid version byte. expected 48, got 16`.
//
// The SDK core does support this — `authorizeEntry`'s signer may return
// `{ signatureScVal }`, documented verbatim for "custom account contracts
// (smart wallets, passkey/WebAuthn signers)" whose `__check_auth` expects its
// own signature structure. But `signAuthEntries` closes that door, and the
// x402 client scheme does not reopen it. Hence: hand-rolled, until upstream
// threads `authorizeEntry` (or `signatureScVal`) through the client scheme.
// See docs/upstream-issue-smart-accounts.md.
//
// Run (testnet):
//   RESOURCE_URL=http://localhost:4031/quote \
//   WALLET_CONTRACT_ID=C...   (the smart-account payer) \
//   AGENT_SECRET=S...         (ed25519 session key attached to the wallet) \
//   SIM_SOURCE_ACCOUNT=G...   (any funded classic account, used only to simulate) \
//   node buyer.mjs

import {
  Keypair,
  Address,
  xdr,
  hash,
  nativeToScVal,
  buildAuthorizationEntryPreimage,
  rpc,
} from "@stellar/stellar-sdk";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { Client as PasskeyClient } from "passkey-kit-sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Auto-load examples/.env.recording so you never have to `source` it. Existing
// shell env vars still win (loadEnvFile does not override). No-op if absent.
try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), ".env.recording"));
} catch {}

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const RESOURCE_URL = process.env.RESOURCE_URL || "http://localhost:4031/quote";
const walletId = process.env.WALLET_CONTRACT_ID;
const agentSecret = process.env.AGENT_SECRET;
const simSource = process.env.SIM_SOURCE_ACCOUNT;
if (!walletId || !agentSecret || !simSource) {
  console.error("WALLET_CONTRACT_ID, AGENT_SECRET, and SIM_SOURCE_ACCOUNT are required");
  process.exit(1);
}

// Optional demo banner: prints the recipient's verification status as an
// OUTCOME, for the walkthrough video. Set RECIPIENT_STATUS=verified|revoked to
// reflect the real on-chain state you've set (this line only displays it, it
// does not perform or reveal the verification mechanism).
const recipientStatus = (process.env.RECIPIENT_STATUS || "").toLowerCase();
if (recipientStatus === "verified") {
  console.error("\n  recipient: VERIFIED ✓  (payment allowed)\n");
} else if (recipientStatus === "revoked") {
  console.error("\n  recipient: REVOKED ✗  (payment will be refused)\n");
}

const agent = Keypair.fromSecret(agentSecret);
const server = new rpc.Server(RPC_URL);
const spec = new PasskeyClient({ contractId: walletId, networkPassphrase: PASSPHRASE, rpcUrl: RPC_URL }).spec;
const SIGNER_KEY_UDT = xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: "SignerKey" }));
const SIGNATURE_UDT = xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: "Signature" }));

// 1. Unpaid request → 402 with payment requirements + discovery extension.
const unpaid = await fetch(RESOURCE_URL);
if (unpaid.status !== 402) {
  console.error(`expected 402, got ${unpaid.status}`);
  process.exit(2);
}
const required = JSON.parse(
  Buffer.from(unpaid.headers.get("PAYMENT-REQUIRED"), "base64").toString("utf8"),
);
const req = required.accepts.find((a) => a.network === "stellar:testnet" && a.scheme === "exact");
console.error(`[buyer] 402: ${req.amount} atomic of ${req.asset} -> ${req.payTo}`);
if (required.extensions?.bazaar) console.error("[buyer] discovery extension present — will echo");

// 2. Build the SEP-41 transfer with the smart account as `from`.
const tx = await AssembledTransaction.build({
  contractId: req.asset,
  method: "transfer",
  args: [
    nativeToScVal(walletId, { type: "address" }),
    nativeToScVal(req.payTo, { type: "address" }),
    nativeToScVal(BigInt(req.amount), { type: "i128" }),
  ],
  networkPassphrase: PASSPHRASE,
  rpcUrl: RPC_URL,
  publicKey: simSource,
  parseResultXdr: (r) => r,
});

// 3. Sign the wallet's auth entry with the agent key (V1 address credentials).
const expirationLedger = (await server.getLatestLedger()).sequence + 12;
const auth = tx.built.operations[0].auth ?? [];
let signed = 0;
for (let i = 0; i < auth.length; i++) {
  const entry = auth[i];
  if (entry.credentials().switch().name !== "sorobanCredentialsAddress") continue;
  if (Address.fromScAddress(entry.credentials().address().address()).toString() !== walletId) continue;
  const creds = entry.credentials().address();
  creds.signatureExpirationLedger(expirationLedger);
  const preimage = buildAuthorizationEntryPreimage(entry, expirationLedger, PASSPHRASE);
  const signature = agent.sign(hash(preimage.toXDR()));
  const scKey = spec.nativeToScVal(
    { tag: "Ed25519", values: [Buffer.from(agent.rawPublicKey())] },
    SIGNER_KEY_UDT,
  );
  const scSig = spec.nativeToScVal({ tag: "Ed25519", values: [Buffer.from(signature)] }, SIGNATURE_UDT);
  creds.signature(xdr.ScVal.scvVec([xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: scKey, val: scSig })])]));
  signed++;
}
if (signed === 0) {
  console.error("no wallet auth entry to sign");
  process.exit(2);
}
tx.built.operations[0].auth = auth;

// 4. Payment payload — echoing the discovery extension so Bazaar catalogs it.
const paymentPayload = {
  x402Version: 2,
  resource: required.resource,
  accepted: req,
  payload: { transaction: tx.built.toXDR() },
  ...(required.extensions ? { extensions: required.extensions } : {}),
};

// 5. Retry with the payment attached.
const paid = await fetch(RESOURCE_URL, {
  headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(paymentPayload)).toString("base64") },
});
const body = await paid.json();
console.error(`[buyer] HTTP ${paid.status}`);
if (paid.status !== 200) {
  console.error(`[buyer] not unlocked: ${JSON.stringify(body)}`);
  process.exit(2);
}
console.log(JSON.stringify(body, null, 2));
console.error(`[buyer] ✅ paid + unlocked, settlement tx: ${body.settlement?.transaction}`);
console.error("[buyer] the resource should now be cataloged: try GET {facilitator}/discovery/resources");
