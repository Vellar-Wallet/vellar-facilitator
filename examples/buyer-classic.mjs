// BUYER (classic keypair) — pay for an x402 resource with a plain Stellar
// account. No smart account, no passkey-kit, no policy contract.
//
// This is the minimal payer, and it is deliberately built on the OFFICIAL x402
// client rather than hand-rolled. `@x402/stellar/exact/client` already builds
// the SEP-41 transfer, signs the auth entry and computes ledger-based expiry;
// `@x402/core/client` already echoes the seller's discovery extension into the
// payload. Copy this file, not the mechanics underneath it.
//
// If you want an agent with an on-chain budget, use `buyer.mjs` — that one
// signs with a Vellar smart account's session key and the spend limit is
// enforced by the wallet contract. It is hand-rolled because it has to be; the
// header of that file explains why the official client cannot do it.
//
// Flow: GET → 402 → createPaymentPayload() → retry with PAYMENT-SIGNATURE.
//
// Run (testnet):
//   RESOURCE_URL=http://127.0.0.1:4031/quote \
//   PAYER_SECRET=S...   (your account; holds the asset + a trustline) \
//   node buyer-classic.mjs
//
// NO SEPARATE SIMULATION SOURCE IS NEEDED.
// ----------------------------------------
// Earlier revisions of this file required a second funded account in
// SIM_SOURCE_ACCOUNT, because simulating from the payer yields SOURCE-ACCOUNT
// credentials and the facilitator's scheme accepts only ADDRESS credentials
// (`invalid_exact_stellar_payload_unsupported_credential_type`). That was an
// artifact of building the transaction by hand. The official client passes no
// `publicKey` to `AssembledTransaction.build`, so simulation runs from the
// SDK's NULL_ACCOUNT — the payer is never the transaction source and the
// failure cannot arise. If you are porting old code, delete the variable.

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), ".env.recording"));
} catch {}

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const RESOURCE_URL = process.env.RESOURCE_URL || "http://127.0.0.1:4031/quote";
const NETWORK = "stellar:testnet";
const payerSecret = process.env.PAYER_SECRET;

if (!payerSecret) {
  console.error("PAYER_SECRET is required (run provision-testnet.mjs to get one)");
  process.exit(1);
}

if (process.env.SIM_SOURCE_ACCOUNT) {
  console.error(
    "[buyer] note: SIM_SOURCE_ACCOUNT is set and is no longer used — the official\n" +
      "        client simulates from the SDK's null account. Ignoring it.",
  );
}

const signer = createEd25519Signer(payerSecret, NETWORK);
const client = new x402Client().register(NETWORK, new ExactStellarScheme(signer, { url: RPC_URL }));
const http = new x402HTTPClient(client);

// 1. Unpaid request → 402 with payment requirements + discovery extension.
const unpaid = await fetch(RESOURCE_URL);
if (unpaid.status !== 402) {
  console.error(`expected 402, got ${unpaid.status} — is the seller running?`);
  console.error("  (debug with GET, not HEAD — a HEAD request carries no challenge)");
  process.exit(2);
}

const required = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name), undefined);
const req = required.accepts?.find((a) => a.network === NETWORK && a.scheme === "exact");
if (!req) {
  console.error(`no ${NETWORK} exact requirement in the 402`);
  process.exit(2);
}
console.error(`[buyer] 402: ${req.amount} atomic of ${req.asset} -> ${req.payTo}`);
if (required.extensions?.bazaar) console.error("[buyer] discovery extension present — echoed automatically");

// 2. Build + sign the payment. One call: the scheme assembles the SEP-41
//    transfer, signs the payer's auth entry, and sets expiry from the seller's
//    maxTimeoutSeconds. Signatures expire in LEDGERS (~5s each), not
//    wall-clock, so never cache the result — sign a fresh one per attempt.
//
//    The seller's `extensions` are merged into the payload here without any
//    client-side extension being registered. That echo is what makes the
//    facilitator catalog the resource on settlement.
let payload;
try {
  payload = await client.createPaymentPayload(required);
} catch (err) {
  console.error(`[buyer] could not build the payment: ${err?.message ?? err}`);
  console.error("  Common causes: no trustline to the asset, or an empty balance.");
  process.exit(2);
}

// 3. Retry with the payment attached.
const paid = await fetch(RESOURCE_URL, { headers: http.encodePaymentSignatureHeader(payload) });
const body = await paid.json();
console.error(`[buyer] HTTP ${paid.status}`);
if (paid.status !== 200) {
  console.error(`[buyer] not unlocked: ${JSON.stringify(body)}`);
  console.error(
    "  Roughly one settle in three fails on testnet with an empty transaction.\n" +
      "  Nothing was spent — retry the whole flow, signing a fresh payload.",
  );
  process.exit(2);
}
console.log(JSON.stringify(body, null, 2));
console.error(`[buyer] ✅ paid + unlocked, settlement tx: ${body.settlement?.transaction}`);
console.error("[buyer] the resource should now be cataloged: try GET {facilitator}/discovery/resources");
