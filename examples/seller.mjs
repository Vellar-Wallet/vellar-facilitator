// Example 1 — SELLER: an x402-protected API that is DISCOVERABLE via Bazaar.
//
// A minimal Express server with one paid route. The route declares the bazaar
// discovery extension, so once a real payment settles through the facilitator,
// the resource appears automatically in GET /discovery/resources and
// /discovery/search — no separate registration step.
//
// Run (testnet):
//   FACILITATOR_URL=http://localhost:4100 \
//   PAYTO=G...            (your merchant account, trustlined to the asset) \
//   ASSET=C...            (SEP-41 token contract id; defaults to testnet USDC) \
//   PRICE_ATOMIC=1000000  (price in atomic units) \
//   node seller.mjs

import express from "express";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Auto-load examples/.env.recording so you never have to `source` it. Existing
// shell env vars still win (loadEnvFile does not override). No-op if absent.
// Captured BEFORE the env file loads, so the boot log can say where PAYTO and
// ASSET actually came from. `.env.recording` is a gitignored dotfile that
// silently outranks the built-in defaults, and a stale one advertising a dead
// merchant is precisely the failure these constants were once hardcoded to
// prevent. It cannot be silent now: provenance is printed, and the trustline is
// checked, on every boot.
const shellPayTo = process.env.PAYTO;
const shellAsset = process.env.ASSET;

try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), ".env.recording"));
} catch {}

const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://vellar-facilitator.onrender.com";
// Demo merchant + asset. These are DEFAULTS, overridable by `PAYTO` / `ASSET`
// so you can run this seller against your own merchant without editing source
// (`node provision-testnet.mjs` creates a matched set).
//
// They used to be hardcoded constants that silently ignored the environment.
// The reason was real: a stale shell `PAYTO` makes the seller advertise a
// merchant with no trustline, and that settle fails on-chain in a way that is
// indistinguishable from a spend control refusing unless you go and read
// Horizon. Ignoring the environment defended against that by making the seller
// unusable for anyone else — while both docs still documented the flags. The
// guard now lives in `preflightMerchant()` below, which checks the actual
// condition (does this payTo hold a trustline to this asset?) instead of
// proxying it, and refuses to boot with a message that names the fix.
//
// UPDATED 2026-08-10: the previous pair (CBIN4HTP… / GBDZH5KZ…) are DEAD — the
// old issuer was burned during provisioning. If you change these defaults,
// redeploy vellar-seller-demo and re-run the live ownership gate
// (docs/operator-runbook.md §4): the gate verifies the payTo the challenge
// NAMES, so a stale 402 reads as a mismatch that looks like a control failure.
const PAYTO = process.env.PAYTO || "GBJX3E4GDO6IT5ZHWM5LVCXYCHN5L3HWZNKFHJMCR6JZJNBL3VVQL2RH";
const ASSET = process.env.ASSET || "CDYCX4PEXXTPIS67E7WPYM37UFCC5XW7QZX5LQ6UQBR65PQZWZ7HTBHR";
const PRICE_ATOMIC = process.env.PRICE_ATOMIC || "1000000";

// Used only by the boot-time merchant preflight below — never on the payment
// path, which goes through the facilitator.
const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;

/** Where a value came from — shell, the env file, or the built-in default. */
const sourceOf = (shellValue, name) =>
  shellValue ? "environment" : process.env[name] ? "examples/.env.recording" : "built-in default";
const PAYTO_SOURCE = sourceOf(shellPayTo, "PAYTO");
const ASSET_SOURCE = sourceOf(shellAsset, "ASSET");

/**
 * The address this merchant advertises as its own — the single source of truth
 * for the 402 challenge, /whoami, and the boot log.
 *
 * D-3: the boot log used to print `http://localhost:${PORT}` as a HARDCODED
 * string while the challenge correctly used PUBLIC_BASE_URL. It did not merely
 * fail to reflect reality; it printed the precise symptom of the most serious
 * defect in this repo (a seller advertising localhost, which makes F11 Layer 2
 * decorative) on a service that was working correctly. Three consumers now read
 * the same function, so they cannot disagree again.
 */
function publicBase() {
  return process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;
}
// PORT first: Render (and most PaaS) inject it and health-check that port, so
// binding SELLER_PORT there would fail the deploy. SELLER_PORT still wins
// locally when PORT is unset, so `docs/guide.md`'s walkthrough is unchanged.
// This is the ONLY deployment concession in this file — the 402 challenge, the
// discovery declaration and the payment path are untouched.
const PORT = Number(process.env.PORT || process.env.SELLER_PORT || 4031);

const coreServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL }))
  .register("stellar:testnet", new ExactStellarScheme())
  .registerExtension(bazaarResourceServerExtension);

const routes = {
  "GET /quote": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC },
      maxTimeoutSeconds: 120,
    },
    description: "Motivational quote of the day (paid)",
    mimeType: "application/json",
    // The Bazaar declaration: how agents should call this endpoint. The
    // resource-server extension enriches it (adds the HTTP method) and ships
    // it on the 402 response; a paying client echoes it back; the facilitator
    // catalogs the resource when the payment settles.
    extensions: declareDiscoveryExtension({
      input: { topic: "perseverance" },
      inputSchema: { properties: { topic: { type: "string" } } },
      output: { example: { quote: "Ships are safe in harbor, but that's not what ships are for." } },
    }),
  },
};

const httpServer = new x402HTTPResourceServer(coreServer, routes);

// `initialize()` fetches /supported from the facilitator. Without this wrapper
// the process died on every boot and produced a self-sustaining crash loop:
//
//   seller boots -> GET /supported -> facilitator cold-starting -> 502
//   -> seller exits -> Render restarts -> retries at once -> ...
//   -> the restart storm hits the facilitator's own 60/min limit -> 429
//
// WHAT @x402/core ALREADY DOES, read from the source rather than assumed:
// getSupported() loops GET_SUPPORTED_RETRIES (3) times, and on 429 it honours
// Retry-After via computeRetryDelay() before continuing. But on ANY OTHER
// non-ok status — 502 included — it throws IMMEDIATELY. That asymmetry is
// backwards for this topology: a 502 from a cold-starting upstream is the
// textbook retryable case, while a 429 is a deliberate refusal. So the library
// covers the case that needs waiting and not the case that needs patience.
//
// This wrapper therefore exists for 5xx/network, and defers to the library on
// 429 — where it has already spent its Retry-After waits before throwing.
const MAX_BOOT_ATTEMPTS = 5;
const RATE_WINDOW_MS = 65_000; // facilitator limit is 60/min; +5s of margin

async function initializeWithRetry() {
  const base = FACILITATOR_URL.replace(/\/+$/, "");

  // Warm via /health SPECIFICALLY because it is the ONE route exempt from the
  // facilitator's rate limiter (src/server.ts: `allowList: req.url === "/health"`).
  // Warming through any other route would consume the same 60/min bucket the
  // seller needs, and could extend the very lockout this is recovering from.
  // That exemption is now load-bearing — if the limiter config is ever tidied,
  // this warm must move with it.
  try {
    console.error("[seller] warming the facilitator via /health (rate-limit exempt)…");
    await fetch(`${base}/health`, { signal: AbortSignal.timeout(90_000) });
  } catch {
    // Best-effort. The retries below are what actually guarantee readiness.
  }

  let delay = 2_000;
  let lastError;
  for (let attempt = 1; attempt <= MAX_BOOT_ATTEMPTS; attempt++) {
    try {
      await httpServer.initialize();
      console.error(`[seller] facilitator reachable (attempt ${attempt}/${MAX_BOOT_ATTEMPTS})`);
      return;
    } catch (err) {
      lastError = err;
      const detail = err?.cause?.message ?? err?.message ?? String(err);
      if (attempt === MAX_BOOT_ATTEMPTS) break;

      // A 429 here means the library ALREADY exhausted its Retry-After waits and
      // the bucket is still full. Backing off by seconds would just re-consume
      // it — the loop that caused this. Wait out the whole window instead.
      const rateLimited = /\(429\)/.test(detail);
      const wait = rateLimited
        ? RATE_WINDOW_MS
        : delay + Math.floor(Math.random() * 1_000); // jitter
      console.error(
        `[seller] facilitator not ready (attempt ${attempt}/${MAX_BOOT_ATTEMPTS}): ${detail}` +
          ` — ${rateLimited ? "RATE LIMITED, waiting out the full window" : "retrying"} in ${Math.round(wait / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, wait));
      if (!rateLimited) delay = Math.min(delay * 2, 30_000);
    }
  }

  // Give up LOUDLY and specifically. A seller that retried forever against a
  // permanently dead facilitator would be indistinguishable from a slow cold
  // start, so a real misconfiguration must be legible in one line: which URL,
  // and what it actually returned.
  console.error(
    `\n[seller] FATAL: gave up after ${MAX_BOOT_ATTEMPTS} attempts.\n` +
      `  facilitator : ${base}\n` +
      `  last error  : ${lastError?.cause?.message ?? lastError?.message ?? lastError}\n` +
      `  If this is a cold start it should have recovered by now, so treat it as a\n` +
      `  misconfiguration: check FACILITATOR_URL, and that ${base}/supported returns 200.\n`,
  );
  throw lastError;
}

/**
 * Refuse to boot a seller that cannot possibly be paid.
 *
 * A merchant with no trustline to the payment asset fails at SETTLEMENT — after
 * verification has already passed — with an on-chain error that reads exactly
 * like a spend control refusing the payment. You cannot tell the two apart
 * without going and reading Horizon, which is why this used to be "defended"
 * by ignoring `PAYTO`/`ASSET` entirely.
 *
 * Checked here instead, once, at boot:
 *   1. both values are well-formed strkeys (a typo is caught before any I/O);
 *   2. `PAYTO` is a real, funded account;
 *   3. `PAYTO` holds a trustline to `ASSET` — a SAC `balance()` on an account
 *      without one fails with Error(Contract, #13) rather than returning 0.
 *
 * A DEFINITIVE negative is fatal. An INCONCLUSIVE result (RPC unreachable) is a
 * warning: a testnet RPC blip must not take a working seller offline, and the
 * failure it guards against is loud on the settle path anyway.
 *
 * `SKIP_TRUSTLINE_CHECK=1` bypasses it for offline or fixture-driven runs.
 */
async function preflightMerchant() {
  console.error(`[seller] payTo ${PAYTO} (from ${PAYTO_SOURCE})`);
  console.error(`[seller] asset ${ASSET} (from ${ASSET_SOURCE})`);
  if (!StrKey.isValidEd25519PublicKey(PAYTO)) {
    console.error(
      `\n[seller] FATAL: PAYTO is not a valid Stellar account address.\n` +
        `  got: ${PAYTO}\n` +
        `  PAYTO must be a G… ed25519 public key — the merchant that receives payment.\n`,
    );
    process.exit(1);
  }
  if (!StrKey.isValidContract(ASSET)) {
    console.error(
      `\n[seller] FATAL: ASSET is not a valid contract address.\n` +
        `  got: ${ASSET}\n` +
        `  ASSET must be a C… SEP-41 contract id (for a classic asset, its SAC).\n`,
    );
    process.exit(1);
  }
  if (process.env.SKIP_TRUSTLINE_CHECK === "1") {
    console.error("[seller] preflight SKIPPED (SKIP_TRUSTLINE_CHECK=1) — settlement may fail on-chain");
    return;
  }

  const server = new rpc.Server(RPC_URL);
  const inconclusive = (why) =>
    console.error(
      `[seller] preflight INCONCLUSIVE (${String(why).slice(0, 120)}) — ` +
        `could not confirm ${PAYTO.slice(0, 8)}… holds a trustline to ${ASSET.slice(0, 8)}…; starting anyway`,
    );

  let account;
  try {
    account = await server.getAccount(PAYTO);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (!/not found/i.test(msg)) return inconclusive(msg);
    console.error(
      `\n[seller] FATAL: PAYTO ${PAYTO} does not exist on this network.\n\n` +
        `  Fund it, then start again:\n` +
        `    curl "https://friendbot.stellar.org?addr=${PAYTO}"\n\n` +
        `  Or provision a complete matched set (asset, merchant, trustline, payer):\n` +
        `    node provision-testnet.mjs\n`,
    );
    process.exit(1);
  }

  let sim;
  try {
    const probe = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
      .addOperation(
        Operation.invokeContractFunction({
          contract: ASSET,
          function: "balance",
          args: [nativeToScVal(PAYTO, { type: "address" })],
        }),
      )
      .setTimeout(60)
      .build();
    sim = await server.simulateTransaction(probe);
  } catch (err) {
    return inconclusive(err?.message ?? err);
  }

  if (!rpc.Api.isSimulationSuccess(sim)) {
    console.error(
      `\n[seller] FATAL: PAYTO ${PAYTO}\n` +
        `        has no trustline to ASSET ${ASSET}.\n\n` +
        `  Every payment would verify and then FAIL at settlement, with an on-chain\n` +
        `  error that looks like a spend control refusing it. Add the trustline first.\n\n` +
        `  With the Stellar CLI (you need the merchant's secret key):\n` +
        `    stellar tx new change-trust --source <MERCHANT_SECRET> \\\n` +
        `      --line <CODE>:<ISSUER> --network testnet\n\n` +
        `  Or provision a complete matched set (asset, merchant, trustline, payer):\n` +
        `    node provision-testnet.mjs\n\n` +
        `  If you believe this is wrong, SKIP_TRUSTLINE_CHECK=1 bypasses this check.\n`,
    );
    process.exit(1);
  }

  console.error(
    `[seller] preflight ok — ${PAYTO.slice(0, 8)}… holds a trustline to ${ASSET.slice(0, 8)}…` +
      ` (balance ${scValToNative(sim.result.retval)} atomic)`,
  );
}

await preflightMerchant();
await initializeWithRetry();

function adapter(req) {
  return {
    getHeader: (name) => req.get(name),
    getMethod: () => req.method,
    getPath: () => req.path,
    // The resource URL a paying client echoes back, and therefore the key the
    // facilitator catalogs and later re-fetches for F11 Layer 2 ownership
    // verification. Hardcoding localhost here meant every settled payment
    // cataloged `http://localhost:<port>/quote` — a URL no agent can pay, and
    // one the SSRF guard rejects as non-https before opening a socket. That is
    // why Layer 2 had never succeeded in production: not the network, this line.
    // PUBLIC_BASE_URL is how a deployed merchant declares its own address.
    // Via publicBase() so this can never drift from what /whoami and the boot
    // log report — drift between exactly these is what produced D-3.
    getUrl: () => `${publicBase()}${req.originalUrl}`,
    getAcceptHeader: () => req.get("accept") || "",
    getUserAgent: () => req.get("user-agent") || "",
    getQueryParams: () => req.query,
    getBody: () => undefined,
  };
}

const app = express();
/**
 * What this seller is ACTUALLY advertising, queryable in one unauthenticated GET.
 *
 * Same shape as the facilitator's /health commit field, and for the same reason:
 * twice in one day the repo held a fix that the running service did not, and both
 * times the only way to tell was to decode a 402 or read boot logs. Running state
 * should be queryable, not inferred.
 *
 * Reports the values in USE — every field is read from the same source the 402
 * challenge is built from, so this cannot agree with the code while disagreeing
 * with reality. `resourceUrl` is the one that matters: if it is not public https,
 * ownership verification can never pass and every catalog entry this seller
 * creates is permanently unverified.
 */
app.get("/whoami", (_req, res) => {
  const resourceUrl = `${publicBase()}/quote`;
  res.json({
    service: "vellar-seller-demo",
    resourceUrl,
    payTo: PAYTO,
    asset: ASSET,
    priceAtomic: PRICE_ATOMIC,
    facilitatorUrl: FACILITATOR_URL,
    // Which build is serving. Render injects RENDER_GIT_COMMIT; omitted rather
    // than faked when absent, so a local run never claims to be a deployment.
    ...(process.env.RENDER_GIT_COMMIT
      ? { commit: process.env.RENDER_GIT_COMMIT.slice(0, 7) }
      : {}),
    // Decided here rather than by the reader: an ownership-verifiable resource
    // URL must be public https. This is the per-settle precondition.
    verifiable: resourceUrl.startsWith("https://") && !resourceUrl.includes("localhost"),
  });
});

// ---------------------------------------------------------------------------
// DIAGNOSTICS — why every facilitator error used to read as a bare 402 `{}`.
//
// Found during the 2026-08-10/11 walkthrough. Three settles failed with an
// empty-body 402 and could not be explained; the same shape then hid a
// facilitator 503 whose reason we already knew (`sponsor_balance_low`). The
// cause is two small things compounding:
//
//   1. `body ?? {}` and `body ?? {…}` only substitute for null/undefined. The
//      failure responses @x402/core builds carry an EMPTY OBJECT, so the
//      fallback that was supposed to add `detail: settle.errorReason` never
//      fired — for the exact inputs it existed to handle.
//
//   2. Our facilitator's error bodies have no `success` key, so
//      HTTPFacilitatorClient cannot build a structured SettleError
//      (`http/index.js:1120` requires `"success" in data`). It throws a generic
//      Error instead — whose MESSAGE still contains the facilitator's status and
//      body verbatim, and lands in `settle.errorReason`. The reason was
//      available the whole time; nothing printed it.
//
// So: treat an empty object as absent, and always log server-side. A resource
// server that hides its dependency's errors makes every failure look identical
// to every other failure, which is what cost the earlier investigation.
// ---------------------------------------------------------------------------

/** Empty object counts as "no body" — this is the bug `??` could not see. */
const emptyish = (b) => b == null || (typeof b === "object" && Object.keys(b).length === 0);

/**
 * Relay an x402 failure without losing the reason. A real body is passed through
 * UNTOUCHED so protocol responses (402 challenges) stay spec-shaped; only an
 * empty one is replaced with what we actually know.
 */
function relayFailure(res, stage, status, headers, body, extra = {}) {
  for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
  const payload = emptyish(body)
    ? { error: "x402_failed", stage, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null)) }
    : body;
  // Always log, even when the body was fine — during a walkthrough the server
  // log is the only place the upstream reason is guaranteed to appear.
  console.error(`[seller] ${stage} failed: HTTP ${status} ${JSON.stringify(payload)}`);
  return res.status(status).json(payload);
}

app.get("/quote", async (req, res) => {
  const paymentHeader = req.get("PAYMENT-SIGNATURE") || req.get("X-PAYMENT") || undefined;
  const presentedPayment = Boolean(paymentHeader);
  let result;
  try {
    result = await httpServer.processHTTPRequest({
      adapter: adapter(req),
      path: req.path,
      method: req.method,
      paymentHeader,
      routePattern: "GET /quote",
    });
  } catch (err) {
    return res.status(500).json({ error: "resource server error", detail: String(err?.message || err) });
  }

  if (result.type === "payment-error") {
    const { status, headers, body } = result.response;
    // NOT every payment-error is a failure. A request that presented NO payment
    // gets the 402 CHALLENGE, and that is the protocol working — its body is
    // empty by design because the requirements travel in the `payment-required`
    // HEADER. Logging it as a failure (and filling the empty body) would make
    // every unpaid first request look broken, which is the same class of
    // misleading diagnostic this block exists to remove.
    if (!presentedPayment) {
      for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
      return res.status(status).json(body ?? {});
    }
    return relayFailure(res, "verify", status, headers, body, {
      detail: result.errorReason ?? result.error ?? undefined,
    });
  }
  if (result.type === "no-payment-required") {
    return res.json({ ok: true, note: "no payment required for this route" });
  }

  // payment-verified: drive settlement through the facilitator.
  try {
    const settle = await httpServer.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      result.declaredExtensions,
    );
    for (const [k, v] of Object.entries(settle.headers || {})) res.setHeader(k, v);
    if (settle.success === false) {
      const { status, headers, body } = settle.response || {};
      // `settle.errorReason` carries the facilitator's status and body verbatim
      // when the client library could not parse a structured error — which is
      // exactly the case for our own 503s. It is the most informative field
      // available, and it was being dropped.
      return relayFailure(res, "settle", status || 502, headers, body, {
        detail: settle.errorReason,
        errorMessage: settle.errorMessage,
      });
    }
    res.json({
      quote: "Ships are safe in harbor, but that's not what ships are for.",
      topic: req.query.topic ?? "perseverance",
      settlement: { transaction: settle.transaction, payer: settle.payer, network: settle.network },
    });
  } catch (err) {
    // A throw from processSettlement never had a body to lose, but it was also
    // never logged — so a crash-shaped failure and a refusal looked the same
    // from outside.
    return relayFailure(res, "settle-threw", 502, {}, undefined, {
      detail: String(err?.message || err),
    });
  }
});

app.listen(PORT, () => {
  console.error(`[seller] paid API on ${publicBase()}/quote  (bound to port ${PORT})`);
  if (!process.env.PUBLIC_BASE_URL) {
    console.error(
      "[seller] WARNING: PUBLIC_BASE_URL is unset, so this seller advertises localhost. " +
        "A localhost resource URL can NEVER pass the facilitator's ownership verification " +
        "(https-only, no loopback), so every entry it creates is permanently unverified. " +
        "Fine locally; wrong anywhere deployed.",
    );
  }
  console.error(`[seller] facilitator: ${FACILITATOR_URL}`);
  console.error(`[seller] price: ${PRICE_ATOMIC} atomic of ${ASSET} -> ${PAYTO}`);
});
