// upto buyer — authorize a CEILING, get settled for the ACTUAL.
//
// The buyer signs (token, payTo, max, expiration, nonce) and never the actual
// amount; the facilitator supplies the metered actual at settle time and the
// contract enforces actual <= max ON-LEDGER. This script plays both buyer and
// resource server: it signs the authorization, then calls the facilitator's
// /verify and /settle directly with the actual amount in requirements.extra.
//
//   FACILITATOR_URL=http://localhost:4100 \
//   UPTO_CONTRACT=C... PAYER_SECRET=S... PAYTO=G... ASSET=C... \
//   MAX=1000000 ACTUAL=400000 node upto-buyer.mjs
//
// The transaction sent to the facilitator is UNSIGNED (envelope-wise): only
// the Soroban auth entries inside it carry the buyer's signature. The
// facilitator rebuilds the transaction from its own sponsor account — the
// buyer needs no XLM.

import crypto from "node:crypto";
import {
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "http://localhost:4100";
const CONTRACT = process.env.UPTO_CONTRACT;
const PAYTO = process.env.PAYTO;
const ASSET = process.env.ASSET;
const MAX = BigInt(process.env.MAX || "1000000");
const ACTUAL = BigInt(process.env.ACTUAL || "400000");

if (!CONTRACT || !PAYTO || !ASSET || !process.env.PAYER_SECRET) {
  console.error("UPTO_CONTRACT, PAYER_SECRET, PAYTO, and ASSET are required");
  process.exit(2);
}
const payer = Keypair.fromSecret(process.env.PAYER_SECRET);
// Simulate from a source that is NOT the payer: when the simulation source IS
// the payer, Soroban returns source-account credentials (no signature slot),
// which silently stop authorizing anything the moment the facilitator rebuilds
// the transaction from its sponsor. Same trap buyer.mjs documents.
const SIM_SOURCE = process.env.SIM_SOURCE_ACCOUNT;
if (!SIM_SOURCE) {
  console.error("SIM_SOURCE_ACCOUNT is required (any funded account that is NOT the payer)");
  process.exit(2);
}
const server = new rpc.Server(RPC_URL);

// 1. Build the settle invocation with a PLACEHOLDER actual (= max). The signed
//    tuple excludes actual, so the signature below stays valid when the
//    facilitator swaps in the real actual at settlement.
const nonce = crypto.randomBytes(32);
const args = [
  nativeToScVal(ASSET, { type: "address" }), // token
  nativeToScVal(payer.publicKey(), { type: "address" }), // from
  nativeToScVal(PAYTO, { type: "address" }), // to
  nativeToScVal(MAX, { type: "i128" }), // max_amount
  null, // expiration_ledger — set below
  nativeToScVal(nonce, { type: "bytes" }), // nonce
  nativeToScVal(MAX, { type: "i128" }), // actual_amount (placeholder)
  xdr.ScVal.scvVoid(), // hook: None
];
const latest = (await server.getLatestLedger()).sequence;
const expirationLedger = latest + 60; // ~5 min — well inside the contract's 24h bound
args[4] = nativeToScVal(expirationLedger, { type: "u32" });

const ic = new xdr.InvokeContractArgs({
  contractAddress: Address.fromString(CONTRACT).toScAddress(),
  functionName: "settle",
  args,
});
const account = await server.getAccount(SIM_SOURCE);
const tx = new TransactionBuilder(account, { fee: "1000", networkPassphrase: PASSPHRASE })
  .addOperation(
    Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(ic),
      auth: [],
    }),
  )
  .setTimeout(120)
  .build();

// 2. Simulate to obtain the required auth entries (root: the contract's signed
//    tuple; nested: the token approve for max), then sign the payer's entries.
const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) {
  console.error("simulation failed:", sim.error);
  process.exit(2);
}
const signedAuth = [];
for (const entry of sim.result.auth) {
  const isPayer =
    entry.credentials().switch().name === "sorobanCredentialsAddress" &&
    Address.fromScAddress(entry.credentials().address().address()).toString() === payer.publicKey();
  signedAuth.push(
    isPayer ? await authorizeEntry(entry, payer, expirationLedger, PASSPHRASE) : entry,
  );
}
if (!signedAuth.length) {
  console.error("no auth entries returned by simulation");
  process.exit(2);
}
// Rebuild the envelope with the signed entries — mutating the decoded
// `operations` array does not write back into the XDR.
const account2 = await server.getAccount(SIM_SOURCE);
const signedTx = new TransactionBuilder(account2, { fee: "1000", networkPassphrase: PASSPHRASE })
  .addOperation(
    Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(ic),
      auth: signedAuth,
    }),
  )
  .setTimeout(120)
  .build();
console.error(
  `[upto-buyer] authorized: ceiling ${MAX} of ${ASSET.slice(0, 8)}… -> ${PAYTO.slice(0, 8)}…, ` +
    `nonce ${nonce.toString("hex").slice(0, 12)}…, expires ledger ${expirationLedger}`,
);

// 3. /verify then /settle. The seller's metered ACTUAL rides in
//    requirements.extra.actualAmount; the buyer never signs it.
const paymentRequirements = {
  scheme: "upto",
  network: "stellar:testnet",
  asset: ASSET,
  amount: MAX.toString(),
  payTo: PAYTO,
  maxTimeoutSeconds: 120,
  extra: { actualAmount: ACTUAL.toString() },
};
const paymentPayload = {
  x402Version: 2,
  accepted: paymentRequirements,
  payload: { transaction: signedTx.toXDR() },
};
const call = async (path) => {
  const res = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  return { status: res.status, body: await res.json() };
};

const verify = await call("/verify");
console.error(`[upto-buyer] /verify ${verify.status}:`, JSON.stringify(verify.body));
if (!verify.body.isValid) process.exit(1);

const settle = await call("/settle");
console.error(`[upto-buyer] /settle ${settle.status}:`, JSON.stringify(settle.body));
if (!settle.body.success) process.exit(1);
console.log(
  JSON.stringify(
    { transaction: settle.body.transaction, amount: settle.body.amount, max: MAX.toString() },
    null,
    2,
  ),
);
