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
// Demo merchant: trustlined to the X402TST bound token. Hard-defaulted so a
// stale shell `PAYTO` can't make the seller serve a merchant with no trustline.
const PAYTO = "GBDZH5KZSVX67MEWPTEMSOP6FBHKYX4GYOW4RRM4JENRC4XZF5UHTKOP";
const ASSET = "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND"; // X402TST bound token
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
await httpServer.initialize();

function adapter(req) {
  return {
    getHeader: (name) => req.get(name),
    getMethod: () => req.method,
    getPath: () => req.path,
    getUrl: () => `http://localhost:${PORT}${req.originalUrl}`,
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
