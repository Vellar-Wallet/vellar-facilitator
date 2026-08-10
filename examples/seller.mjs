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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Auto-load examples/.env.recording so you never have to `source` it. Existing
// shell env vars still win (loadEnvFile does not override). No-op if absent.
try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), ".env.recording"));
} catch {}

const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://vellar-facilitator.onrender.com";
// Demo merchant. Hard-defaulted so a stale shell `PAYTO` cannot make the seller
// serve a merchant with no trustline — the failure that motivated hardcoding.
//
// UPDATED 2026-08-10: the previous pair (CBIN4HTP… / GBDZH5KZ…) are DEAD — the
// old issuer was burned during provisioning. A settle against them fails
// on-chain, which is indistinguishable from a control refusing unless you check
// Horizon. If you change these, redeploy vellar-seller-demo and re-run the live
// ownership gate (docs/operator-runbook.md §4): the gate verifies the payTo the
// challenge NAMES, so a stale 402 reads as a mismatch that looks like a
// control failure.
const PAYTO = "GBJX3E4GDO6IT5ZHWM5LVCXYCHN5L3HWZNKFHJMCR6JZJNBL3VVQL2RH";
const ASSET = "CDYCX4PEXXTPIS67E7WPYM37UFCC5XW7QZX5LQ6UQBR65PQZWZ7HTBHR"; // X402TST bound token
const PRICE_ATOMIC = process.env.PRICE_ATOMIC || "1000000";
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

// `initialize()` fetches /supported from the facilitator and THROWS if it can't,
// which killed this process on every boot and produced a crash loop:
//
//   seller boots -> GET /supported -> facilitator is cold-starting -> 502
//   -> seller exits -> Render restarts it -> immediately retries -> ...
//   -> the retry storm hits the facilitator's own 60/min rate limit -> 429
//
// Two things we built collided. The facilitator sleeps (free tier, and the
// keep-alive is deliberately disabled), so a boot fetch during its ~1 min cold
// start reliably 502s. And F7's rate limit — which exempts /health but NOT
// /supported — then turned a transient failure into a persistent one by
// throttling the restarts.
//
// A merchant whose service dies permanently because its facilitator was briefly
// asleep is fragile in a way any real deployment would hit, so this is a real
// fix rather than a test accommodation.
async function initializeWithRetry() {
  // /health IS rate-limit exempt, so waking the facilitator this way cannot
  // contribute to the 429 that made the loop persistent.
  const base = FACILITATOR_URL.replace(/\/+$/, "");
  try {
    console.error("[seller] warming the facilitator (cold start can take ~1 min)…");
    await fetch(`${base}/health`, { signal: AbortSignal.timeout(90_000) });
  } catch {
    // Warming is best-effort; the retries below are what actually guarantee it.
  }

  let delay = 2_000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await httpServer.initialize();
      console.error(`[seller] facilitator reachable (attempt ${attempt})`);
      return;
    } catch (err) {
      if (attempt === 6) throw err;
      // Backoff with jitter. A tight retry is what produced the 429; retrying
      // without backing off would recreate the storm this exists to prevent.
      const wait = delay + Math.floor(Math.random() * 1_000);
      console.error(
        `[seller] facilitator not ready (attempt ${attempt}/6): ${err?.cause?.message ?? err?.message ?? err}` +
          ` — retrying in ${Math.round(wait / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, wait));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}
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
    getUrl: () =>
      `${process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`}${req.originalUrl}`,
    getAcceptHeader: () => req.get("accept") || "",
    getUserAgent: () => req.get("user-agent") || "",
    getQueryParams: () => req.query,
    getBody: () => undefined,
  };
}

const app = express();
app.get("/quote", async (req, res) => {
  let result;
  try {
    result = await httpServer.processHTTPRequest({
      adapter: adapter(req),
      path: req.path,
      method: req.method,
      paymentHeader: req.get("PAYMENT-SIGNATURE") || req.get("X-PAYMENT") || undefined,
      routePattern: "GET /quote",
    });
  } catch (err) {
    return res.status(500).json({ error: "resource server error", detail: String(err?.message || err) });
  }

  if (result.type === "payment-error") {
    const { status, headers, body } = result.response;
    for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
    return res.status(status).json(body ?? {});
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
      for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
      return res.status(status || 502).json(body ?? { error: "settlement failed", detail: settle.errorReason });
    }
    res.json({
      quote: "Ships are safe in harbor, but that's not what ships are for.",
      topic: req.query.topic ?? "perseverance",
      settlement: { transaction: settle.transaction, payer: settle.payer, network: settle.network },
    });
  } catch (err) {
    res.status(502).json({ error: "settle error", detail: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.error(`[seller] paid API on http://localhost:${PORT}/quote`);
  console.error(`[seller] facilitator: ${FACILITATOR_URL}`);
  console.error(`[seller] price: ${PRICE_ATOMIC} atomic of ${ASSET} -> ${PAYTO}`);
});
