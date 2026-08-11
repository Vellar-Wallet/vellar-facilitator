// BUYER (classic keypair) — pay for an x402 resource with a plain Stellar
// account. No smart account, no passkey-kit, no policy contract.
//
// This is the minimal payer. If you want an agent with an on-chain budget, use
// `buyer.mjs` instead — that one signs with a Vellar smart account's session
// key and the spend limit is enforced by the wallet contract.
//
// Flow: GET → 402 → build the SEP-41 transfer → sign the auth entry with your
// account key → echo the discovery extension → retry with PAYMENT-SIGNATURE.
//
// Run (testnet):
//   RESOURCE_URL=http://127.0.0.1:4031/quote \
//   PAYER_SECRET=S...          (your account; holds the asset + a trustline) \
//   SIM_SOURCE_ACCOUNT=G...    (a DIFFERENT funded account — see below) \
//   node buyer-classic.mjs
//
// WHY A SEPARATE SIMULATION SOURCE
// --------------------------------
// The facilitator rebuilds the transaction with ITSELF as the source account
// before submitting, so the source you build with is only ever used to
// simulate — it is never charged and never signs anything. But it must not be
// the payer: when the payer is also the transaction source, Soroban authorizes
// the transfer with SOURCE-ACCOUNT credentials, and the facilitator's scheme
// only accepts ADDRESS credentials
// (`invalid_exact_stellar_payload_unsupported_credential_type`). Simulating
// from a different account is what makes the auth entry an address entry that
// you can sign detached.

import {
  Address,
  Keypair,
  xdr,
  hash,
  nativeToScVal,
  buildAuthorizationEntryPreimage,
  rpc,
} from "@stellar/stellar-sdk";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), ".env.recording"));
} catch {}

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const RESOURCE_URL = process.env.RESOURCE_URL || "http://127.0.0.1:4031/quote";
const payerSecret = process.env.PAYER_SECRET;
const simSource = process.env.SIM_SOURCE_ACCOUNT;

if (!payerSecret || !simSource) {
  console.error("PAYER_SECRET and SIM_SOURCE_ACCOUNT are required (run provision-testnet.mjs to get both)");
  process.exit(1);
}

const payer = Keypair.fromSecret(payerSecret);
const server = new rpc.Server(RPC_URL);

if (payer.publicKey() === simSource) {
  console.error(
    `SIM_SOURCE_ACCOUNT must be a DIFFERENT account from the payer.\n` +
      `  payer and sim source are both ${simSource}\n` +
      `  Simulating from the payer produces source-account credentials, which the\n` +
      `  facilitator rejects with invalid_exact_stellar_payload_unsupported_credential_type.`,
  );
  process.exit(1);
}

// 1. Unpaid request → 402 with payment requirements + discovery extension.
const unpaid = await fetch(RESOURCE_URL);
if (unpaid.status !== 402) {
  console.error(`expected 402, got ${unpaid.status} — is the seller running?`);
  process.exit(2);
}
const required = JSON.parse(Buffer.from(unpaid.headers.get("PAYMENT-REQUIRED"), "base64").toString("utf8"));
const req = required.accepts.find((a) => a.network === "stellar:testnet" && a.scheme === "exact");
if (!req) {
  console.error("no stellar:testnet exact requirement in the 402");
  process.exit(2);
}
console.error(`[buyer] 402: ${req.amount} atomic of ${req.asset} -> ${req.payTo}`);
if (required.extensions?.bazaar) console.error("[buyer] discovery extension present — will echo");

// 2. Build the SEP-41 transfer, `from` = your classic account.
const tx = await AssembledTransaction.build({
  contractId: req.asset,
  method: "transfer",
  args: [
    nativeToScVal(payer.publicKey(), { type: "address" }),
    nativeToScVal(req.payTo, { type: "address" }),
    nativeToScVal(BigInt(req.amount), { type: "i128" }),
  ],
  networkPassphrase: PASSPHRASE,
  rpcUrl: RPC_URL,
  publicKey: simSource, // simulate-only; the facilitator re-sources the tx
  parseResultXdr: (r) => r,
});

// 3. Sign the payer's auth entry.
//
// Signatures expire in LEDGERS (~5s each), not wall-clock — current + 12 gives
// about a minute. Never cache a signed payload.
//
// For a classic account, Soroban expects the signature as a vec of
// { public_key, signature } maps — one per signer that contributed. A single
// master-key account means exactly one entry. (A smart account instead expects
// its own contract-defined shape; that is the difference between this file and
// buyer.mjs.) Map keys must be in sorted order: public_key before signature.
const expirationLedger = (await server.getLatestLedger()).sequence + 12;
const auth = tx.built.operations[0].auth ?? [];
let signed = 0;
for (const entry of auth) {
  if (entry.credentials().switch().name !== "sorobanCredentialsAddress") continue;
  const creds = entry.credentials().address();
  if (Address.fromScAddress(creds.address()).toString() !== payer.publicKey()) continue;

  creds.signatureExpirationLedger(expirationLedger);
  const preimage = buildAuthorizationEntryPreimage(entry, expirationLedger, PASSPHRASE);
  const signature = payer.sign(hash(preimage.toXDR()));

  creds.signature(
    xdr.ScVal.scvVec([
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("public_key"),
          val: xdr.ScVal.scvBytes(payer.rawPublicKey()),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("signature"),
          val: xdr.ScVal.scvBytes(signature),
        }),
      ]),
    ]),
  );
  signed++;
}
if (signed === 0) {
  console.error(
    "no address auth entry for the payer to sign.\n" +
      "  If SIM_SOURCE_ACCOUNT is the payer, simulation produced source-account\n" +
      "  credentials instead — use a different account.",
  );
  process.exit(2);
}
tx.built.operations[0].auth = auth;

// 4. Payment payload — echoing the discovery extension is what catalogs the
//    resource. Skip it and the payment still succeeds, but nothing is listed.
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
