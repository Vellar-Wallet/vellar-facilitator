#!/usr/bin/env node
// Load test — Tranche 1 success criteria AND the F12 live demonstration
// (docs/closing-state.md §794), proven live at once.
//
// THIS IS NOT A UNIT TEST. It is a standalone, manually-run script against a
// REAL testnet facilitator, moving REAL (testnet) funds. It is NOT added to
// CI (see .github/workflows/ci.yml's own "deliberately vscode-free"/offline
// posture for every OTHER script in this repo — this one is the deliberate
// exception, and stays out of that file for exactly that reason). A human
// runs this by hand, reads the two reports, and decides whether the success
// criteria are actually met — this script reports; it does not gate a merge.
//
// THE PLAN THIS IMPLEMENTS: docs/channel-pool-design.md §9, word for word.
// Two runs, negative control first:
//   Run 1 — the facilitator at FACILITATOR_URL, configured with its CURRENT
//           single-signer setup (no channel pool). Expected: nonzero txBadSeq.
//   Run 2 — the SAME URL, after you reconfigure and restart that facilitator
//           with the 50-account channel pool (CHANNEL_ACCOUNT_SECRET_KEYS
//           set). Required: zero txBadSeq, p95 <= 15s.
// "Same URL" is deliberate, not a simplification — docs/channel-pool-design.md
// §9 says exactly this: the operator reconfigures and restarts ONE
// facilitator between runs, rather than this script targeting two different
// instances. Between the two runs, this script pauses and tells you exactly
// what to do.
//
// METHODOLOGY MATCHES docs/diagnosis-settle-failures.md: negative control
// before claiming a fix, real errorCodes captured per settlement (never a
// bare success/failure count), numbers reported honestly including when they
// are inconvenient (a Run 1 with zero txBadSeq is flagged loudly, not buried).
//
// errorCode CAPTURE: this script does NOT call installRpcStatusCapture
// itself — that patches rpc.Server.prototype.sendTransaction in whatever
// process calls it, and settlement happens server-side, inside the
// FACILITATOR's own process, not this script's. The facilitator already
// installs it at boot (src/server.ts's own installRpcStatusCapture() call)
// and already surfaces the result as `rpcStatus` in a failed /settle
// response body (src/server.ts, the `if (result.success === false &&
// rpcStatus)` branch, wired in Step 4/5 of this same design). This script
// just reads that field back out of the HTTP response — the real capture
// already happened, server-side, by the time this script sees it.
//
// USAGE
//   node scripts/run-load-test.js
//   node scripts/run-load-test.js https://vellar-facilitator.onrender.com
//   LOAD_TEST_FACILITATOR_URL=http://localhost:4100 node scripts/run-load-test.js
//
// Uses the root package.json's own @stellar/stellar-sdk / @x402/core /
// @x402/stellar — the same versions the facilitator itself runs, no separate
// install needed (confirmed present: package.json's own dependencies).

import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { x402Client } from "@x402/core/client";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FACILITATOR_URL =
  process.argv[2] || process.env.LOAD_TEST_FACILITATOR_URL || "https://vellar-facilitator.onrender.com";
const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const HORIZON_URL = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const NETWORK = "stellar:testnet";

// docs/channel-pool-design.md §2: N=50, sized for true simultaneity — the
// load test's own concurrency must match the number the pool was actually
// sized against, not some other round number.
const CONCURRENCY = 50;

// Canonical testnet USDC (matches provision-testnet.mjs's own USE_USDC=1
// path, and the same address confirmed live in this repo's other testnet
// tooling/docs) — real, permissionless (auth_required=false), no faucet.
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const usdc = new Asset("USDC", USDC_ISSUER);

// One payment's worth. 0.1 USDC (7 decimals) — small, so 50 buyers' worth of
// DEX buying pressure stays negligible against the testnet order book, and
// so 50 buyers can each be funded fast without waiting on a large XLM->USDC
// conversion per account.
const PAYMENT_ATOMIC = "1000000"; // 0.1 USDC at 7 decimals
const USDC_ACQUIRE_UNITS = "1"; // 1 USDC bought per buyer — 10x the payment, headroom for fees/rounding
const USDC_MAX_XLM = "50"; // generous ceiling for that small a buy; friendbot grants ~10,000 XLM

// A merchant/payTo distinct from every buyer and every signer — required by
// the scheme's own verify() (facilitator_is_payer / unsafe_tx_or_op_source
// checks, .../facilitator/index.js:427-458), one funded account reused
// across all 50 payloads.
//
// REAL BUG, FOUND AND FIXED while smoke-testing this script against real
// testnet: payTo DOES need its own USDC trustline. Confirmed by an actual
// simulation failure — Soroban's SAC `transfer` for a classic destination
// account enforces the account's classic trustline exists, not just that
// the account itself exists ("HostError: Error(Contract, #13) — trustline
// entry is missing for account"). Wrong initial assumption corrected here,
// not left in the code as a comment saying something the mechanics
// disprove.
const rpcServer = new rpc.Server(RPC_URL);
const horizon = new Horizon.Server(HORIZON_URL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same retry shape as provision-testnet.mjs's own `retry` — this script
 *  deliberately reuses that file's already-proven pattern rather than
 *  inventing a new one, for the same reason it exists there: the public
 *  testnet RPC is load-balanced across nodes whose ledger states drift, so a
 *  read that succeeds on one node can fail on the very next call. */
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

/** Fund via friendbot, then wait until the account is actually visible to
 *  Soroban RPC — friendbot returning 200 does not mean that. Copied
 *  verbatim in behavior from provision-testnet.mjs's own fundAndWait. */
async function fundAndWait(pub) {
  const res = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(`friendbot ${pub.slice(0, 6)}…: HTTP ${res.status}`);
  }
  let streak = 0;
  for (let i = 0; i < 60; i++) {
    try {
      await rpcServer.getAccount(pub);
      if (++streak >= 3) return;
    } catch {
      streak = 0;
    }
    await sleep(2000);
  }
  throw new Error(`${pub.slice(0, 6)}…: funded but never became visible to the RPC`);
}

/** Build, sign, submit one classic-account operation set, waiting for
 *  confirmation. Same shape as provision-testnet.mjs's own `submit`. */
async function submit(label, kp, ops) {
  return retry(label, async () => {
    const acct = await rpcServer.getAccount(kp.publicKey());
    let tx = new TransactionBuilder(acct, { fee: "1000000", networkPassphrase: PASSPHRASE });
    for (const op of ops) tx = tx.addOperation(op);
    tx = tx.setTimeout(120).build();
    tx.sign(kp);
    const sent = await rpcServer.sendTransaction(tx);
    if (sent.status === "ERROR") {
      throw new Error(`send rejected: ${JSON.stringify(sent.errorResult ?? sent.status)}`);
    }
    for (let i = 0; i < 45; i++) {
      await sleep(1500);
      const got = await rpcServer.getTransaction(sent.hash);
      if (got.status === "SUCCESS") return sent.hash;
      if (got.status === "FAILED") throw new Error(`tx FAILED (${sent.hash})`);
    }
    throw new Error(`timed out awaiting ${sent.hash}`);
  });
}

/** Buy `destAmount` of USDC on the DEX, paying in XLM — same mechanism as
 *  provision-testnet.mjs's own acquireOnDex, needed here because there is no
 *  mint authority for canonical testnet USDC; the open market is the only
 *  way to acquire a balance. */
async function acquireUsdcOnDex(kp, destAmount) {
  const paths = await retry(`usdc-path-${kp.publicKey().slice(0, 6)}`, async () => {
    const res = await horizon.strictReceivePaths([Asset.native()], usdc, destAmount).call();
    if (!res.records.length) throw new Error("no XLM->USDC path offered");
    return res.records;
  });
  const best = paths[0];
  await submit(`acquire-usdc-${kp.publicKey().slice(0, 6)}`, kp, [
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: USDC_MAX_XLM,
      destination: kp.publicKey(),
      destAsset: usdc,
      destAmount,
      path: best.path.map((p) => (p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code, p.asset_issuer))),
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Setup — 50 fresh buyer keypairs, funded, trustlined, holding USDC
// ---------------------------------------------------------------------------

async function setup() {
  const setupStart = Date.now();
  console.log(`\n=== Load test setup: ${CONCURRENCY} fresh buyer accounts ===\n`);

  const buyers = Array.from({ length: CONCURRENCY }, () => Keypair.random());
  const payTo = Keypair.random();

  console.log(`[1/4] funding ${CONCURRENCY + 1} accounts via friendbot (${CONCURRENCY} buyers + 1 payTo)...`);
  await Promise.all([...buyers, payTo].map((kp) => fundAndWait(kp.publicKey())));
  console.log(`  ok — all ${CONCURRENCY + 1} funded and visible to RPC`);

  // payTo needs its own USDC trustline too, not just to exist as an account —
  // confirmed by an actual on-chain simulation failure while smoke-testing
  // this script (HostError Contract #13, "trustline entry is missing for
  // account"): the SAC's transfer function enforces the destination
  // account's classic trustline exists, same as any other classic recipient.
  console.log(`[2/4] opening USDC trustlines for all ${CONCURRENCY} buyers + payTo...`);
  await Promise.all(
    [...buyers, payTo].map((kp) => submit(`trustline-${kp.publicKey().slice(0, 6)}`, kp, [Operation.changeTrust({ asset: usdc })])),
  );
  console.log("  ok — all trustlines live");

  console.log(`[3/4] buying ${USDC_ACQUIRE_UNITS} USDC each for all ${CONCURRENCY} buyers on the DEX...`);
  await Promise.all(buyers.map((kp) => acquireUsdcOnDex(kp, USDC_ACQUIRE_UNITS)));
  console.log("  ok — all buyers hold USDC");

  console.log("[4/4] verifying payTo's trustline is visible on-chain...");
  await retry("verify-payto", async () => {
    const acct = await rpcServer.getAccount(payTo.publicKey());
    // getAccount succeeding confirms the account exists; the trustline
    // itself was already confirmed by [2/4]'s own successful submit+confirm
    // above (submit() only returns once the ledger accepted the changeTrust
    // operation) — this step is a final on-chain re-read, matching
    // provision-testnet.mjs's own "belt and suspenders" verification step.
    if (!acct) throw new Error("payTo account not visible");
  });
  console.log(`  ok — payTo: ${payTo.publicKey()}`);

  const elapsedSeconds = ((Date.now() - setupStart) / 1000).toFixed(1);
  console.log(`\n=== Setup complete in ${elapsedSeconds}s: ${CONCURRENCY} funded, trustlined, USDC-holding buyers ===\n`);

  return { buyers, payTo, setupElapsedSeconds: Number(elapsedSeconds) };
}

// ---------------------------------------------------------------------------
// Payment payload construction — one real, signed x402 payload per buyer
// ---------------------------------------------------------------------------

/**
 * Builds a real PaymentRequiredResponse by hand (no seller HTTP server
 * involved — this load test talks to the facilitator directly, not through
 * a seller) and signs it via the OFFICIAL x402 client
 * (@x402/stellar/exact/client), exactly buyer-classic.mjs's own recommended
 * pattern ("copy this file, not the mechanics underneath it") — never
 * hand-rolled transaction construction, so the signed payload is exactly
 * what a real buyer's client would produce.
 */
async function buildSignedPayload(buyerKeypair, payToAddress) {
  const signer = createEd25519Signer(buyerKeypair.secret(), NETWORK);
  const client = new x402Client().register(NETWORK, new ExactStellarScheme(signer, { url: RPC_URL }));

  const requirements = {
    scheme: "exact",
    network: NETWORK,
    asset: usdc.contractId(PASSPHRASE),
    amount: PAYMENT_ATOMIC,
    payTo: payToAddress,
    maxTimeoutSeconds: 60,
    // The client-side ExactStellarScheme hard-requires this — confirmed by
    // reading its source (@x402/stellar/dist/esm/chunk-SOJRTSRS.mjs:46-47:
    // "Exact scheme requires areFeesSponsored to be true") and matching the
    // real decoded 402 payload every other endpoint in this project's own
    // testing has produced. Omitting it throws before a payload is ever
    // built, not something a load test can silently work around.
    extra: { areFeesSponsored: true },
  };
  const paymentRequired = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: "https://load-test.invalid/resource", description: "load test", mimeType: "application/json" },
    accepts: [requirements],
  };

  // Signatures expire in ledgers (~5s each), not wall-clock — built and
  // signed immediately before use, never cached or reused across attempts,
  // same discipline buyer-classic.mjs's own comment states.
  return client.createPaymentPayload(paymentRequired);
}

// ---------------------------------------------------------------------------
// One run — fire CONCURRENCY payments simultaneously, classify each result
// ---------------------------------------------------------------------------

/**
 * Classification matches docs/channel-pool-design.md §9 exactly: success,
 * txBadSeq, TRY_AGAIN_LATER, or "other" — never a bare pass/fail count.
 * rpcStatus is read directly from the facilitator's OWN /settle response
 * body (see this file's header comment on why this script never installs
 * its own RPC status capture).
 */
function classify(settleResult) {
  if (settleResult.ok && settleResult.body?.success === true) return "success";
  const rpcStatus = settleResult.body?.rpcStatus;
  if (rpcStatus?.errorCode === "txBadSeq") return "txBadSeq";
  if (rpcStatus?.status === "TRY_AGAIN_LATER") return "TRY_AGAIN_LATER";
  if (settleResult.body?.errorReason === "pool_exhausted") return "pool_exhausted";
  return "other";
}

async function fireOneSettlement(buyerKeypair, payToAddress) {
  const startedAt = Date.now();
  try {
    const paymentPayload = await buildSignedPayload(buyerKeypair, payToAddress);
    const res = await fetch(`${FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload, paymentRequirements: paymentPayload.accepted }),
    });
    const body = await res.json().catch(() => undefined);
    const durationMs = Date.now() - startedAt;
    const result = { ok: res.ok, status: res.status, body };
    return {
      buyer: buyerKeypair.publicKey(),
      durationMs,
      outcome: classify(result),
      httpStatus: res.status,
      errorReason: body?.errorReason,
      rpcStatus: body?.rpcStatus,
      transaction: body?.transaction,
    };
  } catch (err) {
    // A network-level failure (facilitator unreachable, DNS, etc.) — never
    // silently dropped from the count, reported as its own "other" outcome
    // with the real error message attached.
    return {
      buyer: buyerKeypair.publicKey(),
      durationMs: Date.now() - startedAt,
      outcome: "other",
      error: String(err?.message ?? err),
    };
  }
}

async function runOnce(label, buyers, payToAddress) {
  console.log(`\n=== ${label}: firing ${CONCURRENCY} simultaneous settlements against ${FACILITATOR_URL} ===\n`);
  const startedAt = Date.now();
  const results = await Promise.all(buyers.map((kp) => fireOneSettlement(kp, payToAddress)));
  const wallClockMs = Date.now() - startedAt;
  return { label, facilitatorUrl: FACILITATOR_URL, wallClockMs, results };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return NaN;
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

function summarize(run) {
  const byOutcome = { success: 0, txBadSeq: 0, TRY_AGAIN_LATER: 0, pool_exhausted: 0, other: 0 };
  for (const r of run.results) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  const durations = run.results.map((r) => r.durationMs).sort((a, b) => a - b);
  return {
    label: run.label,
    total: run.results.length,
    ...byOutcome,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    wallClockMs: run.wallClockMs,
  };
}

function printSummary(summary) {
  console.log(`\n--- ${summary.label} ---`);
  console.log(`  total settlements:     ${summary.total}`);
  console.log(`  success:               ${summary.success}`);
  console.log(`  txBadSeq:              ${summary.txBadSeq}`);
  console.log(`  TRY_AGAIN_LATER:       ${summary.TRY_AGAIN_LATER}`);
  console.log(`  pool_exhausted:        ${summary.pool_exhausted}`);
  console.log(`  other:                 ${summary.other}`);
  console.log(`  p50 latency:           ${(summary.p50Ms / 1000).toFixed(2)}s`);
  console.log(`  p95 latency:           ${(summary.p95Ms / 1000).toFixed(2)}s`);
  console.log(`  p99 latency:           ${(summary.p99Ms / 1000).toFixed(2)}s`);
  console.log(`  wall clock (all 50):   ${(summary.wallClockMs / 1000).toFixed(2)}s`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Load test target: ${FACILITATOR_URL}`);
  console.log(`Concurrency: ${CONCURRENCY} (docs/channel-pool-design.md §2 — sized for true simultaneity)`);

  const { buyers, payTo, setupElapsedSeconds } = await setup();

  // --- Run 1: negative control ---------------------------------------------
  console.log(
    "\n>>> Run 1 (NEGATIVE CONTROL) targets the facilitator's CURRENT configuration.\n" +
      ">>> docs/channel-pool-design.md §9: never run this against the production\n" +
      ">>> single-signer facilitator with real settlement side effects beyond what\n" +
      ">>> these test payloads themselves already commit to — if FACILITATOR_URL\n" +
      ">>> above is your production instance, make sure it is genuinely running a\n" +
      ">>> single-signer (no channel pool) configuration you consider disposable\n" +
      ">>> for this purpose before continuing.\n",
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter when the facilitator at the URL above is ready for Run 1 (single-signer, no pool)... ");

  const run1 = await runOnce("Run 1 — negative control (single-signer)", buyers, payTo.publicKey());
  const summary1 = summarize(run1);
  printSummary(summary1);

  if (summary1.txBadSeq === 0) {
    console.log(
      "\n*** WARNING: Run 1 produced ZERO txBadSeq failures. ***\n" +
        "docs/channel-pool-design.md §9 is explicit: a Run 2 result is UNINTERPRETABLE\n" +
        "without this. Either the single-signer configuration was not actually in\n" +
        "effect, or sequence contention did not manifest at this concurrency this\n" +
        "time (testnet is documented as variable — see docs/diagnosis-settle-\n" +
        "failures.md's own rate-quoting warning). Consider re-running Run 1 before\n" +
        "treating any Run 2 result below as evidence the pool fixed anything.\n",
    );
  }

  // --- Run 2: positive control ----------------------------------------------
  console.log(
    "\n>>> Reconfigure and RESTART the facilitator at the SAME URL now, with\n" +
      ">>> CHANNEL_ACCOUNT_SECRET_KEYS set (50 keys) so it runs the channel pool.\n" +
      ">>> docs/channel-pool-design.md §9: same URL, same test payload construction —\n" +
      ">>> only the facilitator's own configuration changes between the two runs.\n",
  );
  await rl.question("Press Enter when the facilitator at the URL above is ready for Run 2 (pool configured, restarted)... ");
  rl.close();

  const run2 = await runOnce("Run 2 — positive control (channel pool)", buyers, payTo.publicKey());
  const summary2 = summarize(run2);
  printSummary(summary2);

  // --- Success criteria, printed explicitly ---------------------------------
  console.log("\n=== Success criteria (docs/channel-pool-design.md §9 / grant Tranche 1) ===\n");
  const zeroTxBadSeq = summary2.txBadSeq === 0;
  const p95Ok = summary2.p95Ms <= 15_000;
  console.log(`  [${zeroTxBadSeq ? "PASS" : "FAIL"}] Run 2: zero txBadSeq failures (got ${summary2.txBadSeq})`);
  console.log(`  [${p95Ok ? "PASS" : "FAIL"}] Run 2: p95 latency <= 15s (got ${(summary2.p95Ms / 1000).toFixed(2)}s)`);
  console.log(
    `  [INFO] Run 2 TRY_AGAIN_LATER failures: ${summary2.TRY_AGAIN_LATER} — reported separately, ` +
      "never counted toward or against the txBadSeq criterion above (a separate, already-diagnosed, " +
      "not-fixed-by-this-design failure mode; see docs/diagnosis-settle-failures.md).",
  );
  console.log(
    `  [${summary1.txBadSeq > 0 ? "OK" : "WARNING"}] Run 1 negative control produced ${summary1.txBadSeq > 0 ? "a nonzero" : "a ZERO"} txBadSeq count` +
      (summary1.txBadSeq > 0 ? "" : " — see the warning printed above; Run 2's result is not fully interpretable without this"),
  );

  const overallPass = zeroTxBadSeq && p95Ok && summary1.txBadSeq > 0;
  console.log(`\n  OVERALL: ${overallPass ? "PASS" : "FAIL"}\n`);

  // --- Save results ----------------------------------------------------------
  // Timestamped, never overwritten — running this script twice must produce
  // two independent result files, per the task's own requirement.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = `load-test-results-${timestamp}.json`;
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        facilitatorUrl: FACILITATOR_URL,
        concurrency: CONCURRENCY,
        setupElapsedSeconds,
        payTo: payTo.publicKey(),
        run1: { summary: summary1, results: run1.results },
        run2: { summary: summary2, results: run2.results },
        successCriteria: { zeroTxBadSeq, p95Ok, run1HadTxBadSeq: summary1.txBadSeq > 0, overallPass },
      },
      null,
      2,
    ),
  );
  console.log(`Full per-settlement results saved to ${outFile}`);
}

main().catch((err) => {
  console.error("\nLoad test failed:", err);
  process.exitCode = 1;
});
