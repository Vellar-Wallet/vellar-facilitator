#!/usr/bin/env node
// Settle probe — puts a NUMBER on our settlement failure rate, on whatever
// infrastructure runs it (a GitHub runner is the neutral choice).
//
// WHY THIS EXISTS BEFORE THE RETRY SHIPS (order is deliberate): a baseline
// cannot be taken retroactively. This instrument runs before and after the
// TRY_AGAIN_LATER retry lands, so the retry's claim is measured by the same
// tool on the same infrastructure — not asserted. Everything measured so far
// (the "1 in 3") came from one developer machine under burst access.
//
// WHAT IT DOES. Against an already-running local facilitator+seller (the CI
// workflow boots them; see .github/workflows/settle-probe.yml), it builds a
// real payment with the OFFICIAL x402 client per attempt — fresh signature
// each time, since auth entries expire in ledgers — then calls /verify and
// /settle DIRECTLY on the facilitator, so `rpcStatus` in the error body is
// read first-hand rather than through the seller's relay.
//
// Output: one JSON line per attempt, then a `summary` line. The collector
// (scripts/collect-probe-results.mjs) aggregates across runs.
//
// Env: FACILITATOR_URL, RESOURCE_URL, PAYER_SECRET (all printed by
// examples/provision-testnet.mjs), ATTEMPTS (default 10), MODE=burst|spaced
// (spaced sleeps 30s between attempts; burst is back-to-back, the access
// pattern that provokes TRY_AGAIN_LATER).

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";

const FACILITATOR_URL = (process.env.FACILITATOR_URL ?? "http://localhost:4100").replace(/\/+$/, "");
const RESOURCE_URL = process.env.RESOURCE_URL ?? "http://127.0.0.1:4031/quote";
const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const ATTEMPTS = Number(process.env.ATTEMPTS ?? 10);
const MODE = process.env.MODE === "spaced" ? "spaced" : "burst";
const NETWORK = "stellar:testnet";

if (!process.env.PAYER_SECRET) {
  console.error("PAYER_SECRET required (from provision-testnet.mjs)");
  process.exit(1);
}

const signer = createEd25519Signer(process.env.PAYER_SECRET, NETWORK);
const client = new x402Client().register(NETWORK, new ExactStellarScheme(signer, { url: RPC_URL }));
const http = new x402HTTPClient(client);

const out = (o) => console.log(JSON.stringify(o));
const results = [];

for (let i = 1; i <= ATTEMPTS; i++) {
  const rec = { probe: "settle", i, mode: MODE, variant: process.env.PROBE_VARIANT ?? "default", t: new Date().toISOString() };
  const t0 = Date.now();
  try {
    const unpaid = await fetch(RESOURCE_URL);
    if (unpaid.status !== 402) throw new Error(`expected 402, got ${unpaid.status}`);
    const required = http.getPaymentRequiredResponse((n) => unpaid.headers.get(n), undefined);
    // Fresh payload per attempt — signatures expire in ledgers, never reuse.
    const payload = await client.createPaymentPayload(required);
    const body = {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: required.accepts[0],
    };
    const verify = await fetch(`${FACILITATOR_URL}/verify`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json());
    if (!verify.isValid) {
      Object.assign(rec, { ok: false, stage: "verify", reason: verify.invalidReason ?? "unknown", ms: Date.now() - t0 });
    } else {
      const settle = await fetch(`${FACILITATOR_URL}/settle`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }).then((r) => r.json());
      Object.assign(rec, settle.success
        ? { ok: true, tx: settle.transaction, ms: Date.now() - t0 }
        : { ok: false, stage: "settle", reason: settle.errorReason ?? "unknown",
            rpcStatus: settle.rpcStatus?.status, rpcErrorCode: settle.rpcStatus?.errorCode, ms: Date.now() - t0 });
    }
  } catch (err) {
    Object.assign(rec, { ok: false, stage: "harness", reason: String(err?.message ?? err).slice(0, 120), ms: Date.now() - t0 });
  }
  results.push(rec); out(rec);
  if (MODE === "spaced" && i < ATTEMPTS) await new Promise((r) => setTimeout(r, 30_000));
}

const okCount = results.filter((r) => r.ok).length;
const lat = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : null;
out({
  probe: "summary", mode: MODE, variant: process.env.PROBE_VARIANT ?? "default", attempts: ATTEMPTS, ok: okCount, failed: ATTEMPTS - okCount,
  byReason: results.filter((r) => !r.ok).reduce((m, r) => ((m[`${r.stage}:${r.reason}${r.rpcStatus ? ":" + r.rpcStatus : ""}`] = (m[`${r.stage}:${r.reason}${r.rpcStatus ? ":" + r.rpcStatus : ""}`] ?? 0) + 1), m), {}),
  latencyMs: { min: lat[0] ?? null, p50: pct(50), max: lat[lat.length - 1] ?? null },
});
process.exit(0); // failures are DATA here, not errors — the workflow uploads them either way
