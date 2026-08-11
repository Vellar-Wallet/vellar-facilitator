#!/usr/bin/env node
// Diagnostic RPC tap — forwards Soroban JSON-RPC and logs what the network
// ACTUALLY said when a submission fails.
//
// WHY. Roughly one settle in three fails with
// `settle_exact_stellar_transaction_submission_failed` and an empty
// `transaction`. That reason string is manufactured by @x402/stellar, which
// discards the RPC response that explains it:
//
//     const sendResult = await server.sendTransaction(txToSubmit);
//     if (sendResult.status !== "PENDING") {
//       return { success: false, transaction: "",
//                errorReason: "settle_exact_stellar_transaction_submission_failed", payer };
//     }
//
// `sendResult` carries `status`, `errorResult` (a TransactionResult XDR naming
// the exact ledger-level failure), `diagnosticEvents`, and `latestLedger`. All
// of it is thrown away. We have a name and a stable rate and no cause, because
// the cause never leaves that function.
//
// This does not fix anything and does not change production. It sits between the
// facilitator and the RPC so the response is visible:
//
//     node scripts/rpc-tap.mjs                       # listens on :8899
//     STELLAR_RPC_URL=http://localhost:8899 npm start
//
// Then drive settlements until one fails and read the log. Nothing here is
// intended to ship.

import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { xdr } from "@stellar/stellar-sdk";

const PORT = Number(process.env.TAP_PORT ?? 8899);
const UPSTREAM = process.env.TAP_UPSTREAM ?? "https://soroban-testnet.stellar.org";

let sends = 0;
let failures = 0;

/** Decode the TransactionResult XDR the RPC returns on a rejected submission.
 *  This is the actual answer — txBAD_SEQ, txINSUFFICIENT_FEE, txTOO_LATE and so
 *  on each imply a completely different cause and a different fix. */
function decodeErrorResult(b64) {
  try {
    const r = xdr.TransactionResult.fromXDR(b64, "base64");
    const out = { code: r.result().switch().name, feeCharged: r.feeCharged().toString() };
    try {
      const inner = r.result().results?.();
      if (Array.isArray(inner)) out.opCodes = inner.map((o) => o.tr?.().switch?.().name ?? o.switch().name);
    } catch {
      /* not all result types carry operation results */
    }
    return out;
  } catch (e) {
    return { undecodable: String(e?.message ?? e), raw: b64?.slice(0, 120) };
  }
}

// TLS, because @stellar/stellar-sdk refuses an http RPC endpoint outright
// ("Cannot connect to insecure Soroban RPC server if `allowHttp` isn't set").
// A self-signed cert plus NODE_TLS_REJECT_UNAUTHORIZED=0 on the facilitator is
// the smallest way through for a local diagnostic. Never do either in anger.
const TLS_KEY = process.env.TAP_TLS_KEY;
const TLS_CERT = process.env.TAP_TLS_CERT;
const makeServer = (handler) =>
  TLS_KEY && TLS_CERT
    ? https.createServer({ key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) }, handler)
    : http.createServer(handler);

const server = makeServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let method = "?";
    try {
      method = JSON.parse(body)?.method ?? "?";
    } catch {
      /* not JSON — forward anyway */
    }
    const started = Date.now();
    try {
      const upstream = await fetch(UPSTREAM, {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: req.method === "POST" ? body : undefined,
      });
      const text = await upstream.text();
      const ms = Date.now() - started;

      if (method === "sendTransaction") {
        sends++;
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* fall through to the raw log below */
        }
        const r = parsed?.result;
        const status = r?.status ?? "(no result)";
        if (status !== "PENDING") {
          failures++;
          console.error(
            `\n[tap] SUBMISSION NOT PENDING  (${failures}/${sends} sends)  ${ms}ms  http ${upstream.status}`,
          );
          console.error(`[tap]   status        ${status}`);
          if (r?.errorResult) console.error(`[tap]   errorResult   ${JSON.stringify(decodeErrorResult(r.errorResult))}`);
          if (r?.errorResultXdr) console.error(`[tap]   errorResultXdr ${JSON.stringify(decodeErrorResult(r.errorResultXdr))}`);
          if (r?.latestLedger) console.error(`[tap]   latestLedger  ${r.latestLedger}`);
          if (r?.diagnosticEvents?.length) console.error(`[tap]   diagnostics   ${r.diagnosticEvents.length} event(s)`);
          if (parsed?.error) console.error(`[tap]   jsonrpc error ${JSON.stringify(parsed.error)}`);
          if (!parsed) console.error(`[tap]   raw           ${text.slice(0, 400)}`);
        } else {
          console.error(`[tap] sendTransaction PENDING  (${sends} sends, ${failures} failed)  ${ms}ms`);
        }
      }

      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(text);
    } catch (err) {
      // A transport failure to the upstream is itself a candidate cause, so it
      // is logged rather than silently converted into a 502.
      console.error(`[tap] UPSTREAM TRANSPORT FAILURE on ${method}: ${String(err?.message ?? err)}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });
});

server.listen(PORT, () => {
  console.error(`[tap] forwarding :${PORT} -> ${UPSTREAM}`);
  console.error(`[tap] point the facilitator at it:  STELLAR_RPC_URL=http://localhost:${PORT}`);
});
