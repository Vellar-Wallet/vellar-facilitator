// VOLUNTARY ROTATION — authorize a resource's handoff from an old payTo to a
// new one, with one small real settlement from the OLD owner's own account.
//
// docs/proposal-voluntary-rotation.md (see its addendum — a review of #112
// found and fixed a real hijack gap in this flow's first implementation).
// This is NOT a payment for a resource — there is no seller, no 402
// challenge, no discovery extension. It pays the facilitator's OWN
// CONFIGURED MARKER ADDRESS (not just "the sponsor" loosely — the
// facilitator checks requirements.payTo/scheme/network against its exact
// configured marker, and refuses a rotation extension on anything else) and
// carries a `rotation` extension instead, settled through the exact same
// /verify + /settle pipeline every other exact-scheme payment uses. Zero new
// client code: ExactStellarScheme already builds and signs a classic
// payer's payment correctly, the same machinery buyer-classic.mjs
// exercises — this script only adds the extension and targets the marker
// address instead of a seller.
//
// RUN THIS YOURSELF, as the old owner, directly against the facilitator.
// Do not sign this and hand it to someone else to submit — signing only
// proves who paid; whoever actually calls /settle controls what payTo/
// scheme/network the settlement presents, and the facilitator's gate checks
// exactly those fields, not anything about the signature.
//
// What this proves, and what it does not. On its own this call only RECORDS
// a marker — it does not move anything. The actual rotation happens on the
// resource's NEXT settlement from the new owner: tryDisplace reads this
// marker, bypasses the one-way latch for that one attempt, and still runs
// the ordinary Layer-2 probe (the resource's own 402 challenge must name the
// new owner) before anything moves. See catalog.ts's tryDisplace and
// authorizeRotation for the two-proof requirement this script is half of.
//
// Run (testnet):
//   FACILITATOR_URL=http://localhost:4100 \
//   OLD_OWNER_SECRET=S...   (the account that currently owns the resource) \
//   RESOURCE_URL=http://127.0.0.1:4031/quote \
//   NEW_PAYTO=G...          (the successor address) \
//   MARKER_PAYTO=G...       (the facilitator's own configured marker address — \
//                            ask the operator; settling to any other address \
//                            gets the rotation extension ignored, not recorded) \
//   node rotate-classic.mjs
//
// After this succeeds, settle one real payment from NEW_PAYTO against
// RESOURCE_URL in the usual way (e.g. buyer-classic.mjs with a payer whose
// account is NEW_PAYTO) — THAT settlement is what actually triggers
// tryDisplace and moves the binding, within the marker's expiry window.

import crypto from "node:crypto";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), ".env.recording"));
} catch {}

const FACILITATOR_URL = process.env.FACILITATOR_URL || "http://localhost:4100";
const NETWORK = "stellar:testnet";
const oldOwnerSecret = process.env.OLD_OWNER_SECRET;
const resourceUrl = process.env.RESOURCE_URL;
const newPayTo = process.env.NEW_PAYTO;
// Where the marker settlement's value goes. MUST be the facilitator's own
// configured marker address exactly — the sponsor's address is the proposed
// default (docs/proposal-voluntary-rotation.md §1), but what actually
// matters is that it matches registerBazaar's `rotationMarker.payTo` on the
// server this script is calling. Settling to any other address gets the
// rotation extension ignored and warn-logged, not recorded (bazaar.ts's
// #112-review fix) — the amount itself is nominal either way (the marker's
// purpose is the authenticated payer, not the value moved).
const markerPayTo = process.env.MARKER_PAYTO;
const asset = process.env.ASSET;
const amount = process.env.AMOUNT || "1";

if (!oldOwnerSecret || !resourceUrl || !newPayTo || !markerPayTo || !asset) {
  console.error(
    "OLD_OWNER_SECRET, RESOURCE_URL, NEW_PAYTO, MARKER_PAYTO, and ASSET are all required",
  );
  process.exit(2);
}

const signer = createEd25519Signer(oldOwnerSecret, NETWORK);
const scheme = new ExactStellarScheme(signer);

const paymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  asset,
  amount,
  payTo: markerPayTo,
  maxTimeoutSeconds: 60,
  extra: {},
};

let built;
try {
  built = await scheme.createPaymentPayload(2, paymentRequirements);
} catch (err) {
  console.error(`[rotate] could not build the marker payment: ${err?.message ?? err}`);
  console.error("  Common causes: no trustline to the asset, or an empty balance, on OLD_OWNER_SECRET.");
  process.exit(2);
}

const nonce = crypto.randomBytes(16).toString("hex");
const paymentPayload = {
  ...built,
  extensions: {
    rotation: {
      resourceUrl,
      oldPayTo: signer.address,
      newPayTo,
      nonce,
    },
  },
};

console.error(
  `[rotate] marker: ${resourceUrl}\n` +
    `         ${paymentPayload.extensions.rotation.oldPayTo} -> ${newPayTo}, nonce ${nonce.slice(0, 12)}…`,
);

const call = async (path) => {
  const res = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  return { status: res.status, body: await res.json() };
};

const verify = await call("/verify");
console.error(`[rotate] /verify ${verify.status}:`, JSON.stringify(verify.body));
if (!verify.body.isValid) process.exit(1);

const settle = await call("/settle");
console.error(`[rotate] /settle ${settle.status}:`, JSON.stringify(settle.body));
if (!settle.body.success) process.exit(1);

console.log(JSON.stringify({ transaction: settle.body.transaction, nonce }, null, 2));
console.error(
  `[rotate] ✅ marker settled and recorded (expires in 72h). The rotation itself completes on ` +
    `${newPayTo}'s NEXT real settlement against ${resourceUrl} — nothing has moved yet.`,
);
