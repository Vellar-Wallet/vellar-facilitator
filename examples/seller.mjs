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
import { createHash, randomInt, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { marked } from "marked";
import { diffLines } from "diff";

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
// UPDATED 2026-08-13. These defaults have now died twice, both times the same
// way: the asset's issuer key was a throwaway generated in-process, and once it
// was gone nobody could mint, so nobody could pay, so the resource was
// permanently unpayable. CBIN4HTP…/GBDZH5KZ… went first; CDYCX4PE… (X402TST)
// went next and left the demo's catalog entry frozen at ownerVerified:false,
// because the badge only re-checks on a settlement that could never happen.
//
// THE ASSET IS NOW CANONICAL TESTNET USDC, and the reason that ends the pattern
// is not that it is bigger — it is that ITS ISSUER IS NOT OURS TO DESTROY.
// Circle holds it (home_domain centre.io, 54k+ authorized accounts). Anyone can
// obtain a balance from the testnet DEX with no faucet and no human step:
// `USE_USDC=1 node provision-testnet.mjs`.
//
// PAYTO is Vellar's demo merchant, funded and holding a live USDC trustline.
// Confirmed live before shipping — a second dead default would be worse than
// the first, since it would arrive labelled as a fix.
//
// These are OUR values. Running this seller without PAYTO/ASSET set advertises
// Vellar's merchant, not yours, so anyone paying it pays us. That is fine for a
// demo and wrong for anything else, which is why the boot log says so out loud
// rather than quietly naming a source.
//
// If you change these, redeploy vellar-seller-demo and re-run the live
// ownership gate (docs/operator-runbook.md §4): the gate verifies the payTo the
// challenge NAMES, so a stale 402 reads as a mismatch that looks like a control
// failure.
const PAYTO = process.env.PAYTO || "GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC";
const ASSET = process.env.ASSET || "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PRICE_ATOMIC = process.env.PRICE_ATOMIC || "1000000";

// USDC on Stellar has 7 decimal places (confirmed by this repo's own
// atomic/decimal convention — see provision-testnet.mjs and the sibling
// vellar-playground's lib/usdc.ts `USDC_DECIMALS = 7`), so 1 USDC = 10,000,000
// atomic. `/quote`'s PRICE_ATOMIC default of "1000000" is therefore 0.1 USDC,
// NOT 0.01 — a decimal place off the naive reading. The seven new endpoints
// below are priced independently of PRICE_ATOMIC (which stays /quote's own
// knob): 0.01 USDC = 100,000 atomic for six of them, and 0.02 USDC = 200,000
// atomic for /inspect, which does real Horizon work three calls deep.
const PRICE_ATOMIC_001_USDC = "100000";
const PRICE_ATOMIC_002_USDC = "200000";

// Used only by the boot-time merchant preflight below — never on the payment
// path, which goes through the facilitator.
const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;

// Horizon testnet — used by /inspect (balances + recent txs) and /timestamp
// (ledger sequence number only). These are the only two of the seven new
// routes below that touch an external API; the other five (/stroops, /hash,
// /base64, /word-count, /uuid) are pure local computation. Both Horizon calls
// carry an explicit 10s timeout and fail with a clear JSON error rather than
// hanging or crashing — see fetchHorizon().
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const HORIZON_TIMEOUT_MS = 10_000;

/**
 * GET a Horizon testnet path with an explicit timeout, returning a
 * discriminated result rather than throwing — every caller needs to turn a
 * timeout/network failure into a clean 4xx/502 JSON body, never a crash or an
 * unbounded hang.
 */
async function fetchHorizon(path) {
  try {
    const res = await fetch(`${HORIZON_URL}${path}`, { signal: AbortSignal.timeout(HORIZON_TIMEOUT_MS) });
    let body;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, status: 0, timedOut, error: String(err?.message || err) };
  }
}

/**
 * Where a value came from — shell, the env file, or the built-in default.
 *
 * The built-in case says "Vellar demo default" rather than "built-in default",
 * because naming the source is not the useful fact. The useful fact is WHOSE
 * value it is: run this with no PAYTO and you are advertising Vellar's merchant
 * address, so any payment goes to us rather than to you. Someone skimming a boot
 * log will read "built-in default" as "a sensible fallback" and move on.
 */
const sourceOf = (shellValue, name) =>
  shellValue
    ? "environment"
    : process.env[name]
      ? "examples/.env.recording"
      : "VELLAR DEMO DEFAULT — not yours";
const PAYTO_SOURCE = sourceOf(shellPayTo, "PAYTO");
const ASSET_SOURCE = sourceOf(shellAsset, "ASSET");
const USING_DEMO_DEFAULTS = !shellPayTo && !process.env.PAYTO;

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

/**
 * Can this resource URL ever pass the facilitator's ownership verification?
 *
 * The facilitator's precondition is public https: http is rejected before a
 * socket opens, and so are loopback, private ranges and link-local. This is the
 * seller-side mirror of that rule, and it is deliberately the ONLY copy — both
 * /whoami's `verifiable` and the boot guard read it, so they cannot drift.
 *
 * Previously /whoami tested `startsWith("https://") && !includes("localhost")`,
 * which passed `https://127.0.0.1` and `https://192.168.1.10` — URLs the
 * facilitator refuses. Reporting `verifiable: true` for a URL that can never
 * verify is the exact failure this endpoint exists to prevent.
 */
function isPubliclyVerifiable(url) {
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false; // link-local, incl. cloud metadata
  return true;
}

/** Is the configured facilitator this machine, rather than a shared one? */
function isLocalFacilitator(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
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

// USDC/Stellar atomic scale: 10,000,000 (7 decimal places) — same constant
// documented above and in the sibling vellar-playground's lib/usdc.ts.
const USDC_DECIMALS = 7;
const ATOMIC_SCALE = 10n ** BigInt(USDC_DECIMALS);

/**
 * Parse a USDC decimal-amount string (e.g. "1.5", "0.0000001", "12") into its
 * exact stroop value, as a BigInt — no floating point anywhere, since a
 * float64 cannot represent every 7-decimal value exactly (0.1 + 0.2 territory)
 * and this is money math. Mirrors the *inverse* of vellar-playground's
 * lib/usdc.ts `atomicToDecimalString` (decimal string -> atomic there;
 * atomic -> decimal string here), reimplemented from scratch in this repo.
 *
 * Splits the decimal string into whole and fractional parts, scales each by
 * hand with BigInt arithmetic, and combines them:
 *   whole part  * 10_000_000
 * + fractional part, right-padded/truncated to 7 digits
 *
 * Returns `null` (never throws) for anything that isn't a plain non-negative
 * decimal number, so the route can turn that into a clean 400 rather than a
 * crash or a silently wrong answer.
 */
function usdcToStroops(input) {
  if (typeof input !== "string" || input.length === 0) return null;
  // Whole, or whole.fraction — no sign, no exponent, no thousands separators.
  // Signed/scientific input is exactly the "malformed" case the spec calls
  // out to reject with a 400, not coerce.
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input);
  if (!match) return null;
  const [, wholeStr, fracStr = ""] = match;
  if (fracStr.length > USDC_DECIMALS) {
    // More precision than USDC supports (7 decimals) — reject rather than
    // silently truncating a value the caller thought they specified exactly.
    return null;
  }
  const whole = BigInt(wholeStr);
  const fracPadded = fracStr.padEnd(USDC_DECIMALS, "0");
  const frac = fracPadded.length > 0 ? BigInt(fracPadded) : 0n;
  return whole * ATOMIC_SCALE + frac;
}

const routes = {
  "GET /quote": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Motivational Quote",
    description: "Motivational quote of the day (paid)",
    // Bazaar discovery tags. Scored at weight 3 — second only to serviceName —
    // and previously empty on every route here, so that weight was doing
    // nothing. Each term is a word an agent would plausibly search for and that
    // the description above actually supports; none is invented.
    tags: ["quote", "motivation", "motivational", "inspiration", "daily"],
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

  // ── SEVEN NEW PAID ROUTES ────────────────────────────────────────────────
  // Same conventions as /quote above: `accepts` names the price, `description`
  // + `serviceName` (a dedicated RouteConfig field — see @x402/core's
  // RouteConfig type — used here rather than folding a name into
  // `description`, since it exists for exactly this and flows into the
  // catalog's resourceInfo/discovery metadata) name the resource for Bazaar
  // discovery, and `extensions: declareDiscoveryExtension(...)` describes the
  // real input/output shape so a discovering agent knows how to call it.
  "GET /inspect/:address": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_002_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Stellar Address Inspector",
    tags: ["inspect", "stellar", "address", "balance", "xlm", "usdc", "account"],
    description:
      "Give it any Stellar testnet address, get back its XLM balance, USDC balance, and recent transactions.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      pathParams: { address: "GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC" },
      pathParamsSchema: {
        properties: { address: { type: "string", description: "A Stellar G... account address" } },
        required: ["address"],
      },
      output: {
        example: {
          address: "GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC",
          xlmBalance: "9999.9999900",
          usdcBalance: "10.5664000",
          recentTransactionHashes: ["ef3f8e67...", "4dfbdff5...", "a35959b5..."],
        },
      },
    }),
  },

  "GET /stroops": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Stroop Converter",
    tags: ["stroops", "xlm", "convert", "stellar", "usdc", "payment"],
    description: "Give it a USDC amount, get back the exact stroop value. Useful for building x402 payment payloads.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { usdc: "1.5" },
      inputSchema: {
        properties: { usdc: { type: "string", description: "A USDC decimal amount, e.g. \"1.5\"" } },
        required: ["usdc"],
      },
      output: { example: { usdc: "1.5", stroops: "15000000" } },
    }),
  },

  "GET /hash": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Text Hasher",
    tags: ["hash", "sha256", "md5", "checksum", "fingerprint", "text", "verifiable"],
    description: "Give it any text, get back SHA-256 and MD5 hashes. Results are independently verifiable.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { input: "hello world" },
      inputSchema: {
        properties: { input: { type: "string", description: "Text to hash, max 500 characters" } },
        required: ["input"],
      },
      output: {
        example: {
          input: "hello world",
          sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde",
          md5: "5eb63bbbe01eeed093cb22bb8f5acdc3",
        },
      },
    }),
  },

  "GET /timestamp": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Trusted Timestamp",
    tags: ["timestamp", "time", "ledger", "stellar", "verifiable", "clock"],
    description:
      "Returns the current time anchored to the Stellar ledger sequence number — a verifiable timestamp from the chain.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: {},
      inputSchema: { properties: {} },
      output: {
        example: {
          iso8601: "2026-08-23T06:54:51.000Z",
          unixSeconds: 1787036091,
          stellarLedgerSequence: 4289052,
        },
      },
    }),
  },

  "GET /base64": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Base64 Encoder/Decoder",
    tags: ["base64", "encode", "decode", "encoding", "x402", "header"],
    description: "Encode or decode base64. Useful for reading raw x402 payment headers.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { input: "hello world", mode: "encode" },
      inputSchema: {
        properties: {
          input: { type: "string", description: "Text to encode, or base64 to decode. Max 1000 characters" },
          mode: { type: "string", enum: ["encode", "decode"] },
        },
        required: ["input", "mode"],
      },
      output: { example: { mode: "encode", input: "hello world", output: "aGVsbG8gd29ybGQ=" } },
    }),
  },

  "GET /word-count": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Text Analyzer",
    tags: ["wordcount", "words", "text", "analyze", "characters", "reading"],
    description: "Give it any text, get back word count, character count, sentence count, and reading time.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { text: "Ships are safe in harbor. But that's not what ships are for!" },
      inputSchema: {
        properties: { text: { type: "string", description: "Text to analyze, max 2000 characters" } },
        required: ["text"],
      },
      output: {
        example: { words: 11, characters: 62, sentences: 2, estimatedReadingTimeSeconds: 3 },
      },
    }),
  },

  "GET /uuid": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "UUID Generator",
    tags: ["uuid", "identifier", "unique", "guid", "fingerprint", "verifiable"],
    description: "Returns a fresh UUID v4 with a SHA-256 fingerprint. Each call is unique and independently verifiable.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: {},
      inputSchema: { properties: {} },
      output: {
        example: {
          uuid: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          fingerprint: "1155d132ea7a2addad9a75277e...",
        },
      },
    }),
  },

  // ── ELEVEN CORPUS-EXPANSION ROUTES ───────────────────────────────────────
  // Added to widen the Bazaar catalog beyond Stellar utilities and generic
  // text tools, so semantic-vs-lexical search quality becomes measurable.
  // Same conventions as every route above. serviceName/tags/description are
  // the fields the search scorer weights (4/3/2), so each is written for a
  // real agent query rather than padded.

  "GET /qr": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "QR Code Generator",
    tags: ["qr", "qrcode", "barcode", "image", "generator", "encode", "url", "link"],
    description:
      "Generate a QR code data URL for any text or URL. Returns a base64 PNG data URL ready to embed in HTML.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { text: "https://x402.org" },
      inputSchema: { properties: { text: { type: "string", description: "Text or URL to encode, max 500 chars" } }, required: ["text"] },
      output: { example: { dataUrl: "data:image/png;base64,iVBORw0KGgo..." } },
    }),
  },

  "GET /color": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Color Converter",
    tags: ["color", "hex", "rgb", "hsl", "convert", "design", "palette", "css"],
    description:
      "Convert colors between hex, RGB, and HSL formats. Input any format, get all three back.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { color: "#ff0000" },
      inputSchema: { properties: { color: { type: "string", description: "A color as #rrggbb, rgb(r,g,b), or hsl(h,s%,l%)" } }, required: ["color"] },
      output: { example: { hex: "#ff0000", rgb: "rgb(255, 0, 0)", hsl: "hsl(0, 100%, 50%)" } },
    }),
  },

  "GET /markdown": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Markdown to HTML Converter",
    tags: ["markdown", "html", "convert", "document", "format", "render", "text", "processing"],
    description:
      "Convert Markdown text to HTML. Supports headings, bold, italic, lists, links, and code blocks.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { markdown: "# Hello\n\nSome **bold** text." },
      inputSchema: { properties: { markdown: { type: "string", description: "Markdown source, max 5000 chars" } }, required: ["markdown"] },
      output: { example: { html: "<h1>Hello</h1>\n<p>Some <strong>bold</strong> text.</p>\n" } },
    }),
  },

  "GET /diff": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Text Diff",
    tags: ["diff", "compare", "version", "change", "text", "document", "patch", "delta"],
    description:
      "Compare two texts and return a unified diff showing what changed. Useful for comparing versions of documents or code.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { original: "line one", revised: "line two" },
      inputSchema: { properties: { original: { type: "string" }, revised: { type: "string" } }, required: ["original", "revised"] },
      output: { example: { diff: "- line one\n+ line two\n", additions: 1, deletions: 1, unchanged: 0 } },
    }),
  },

  "GET /regex": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Regex Tester",
    tags: ["regex", "regexp", "pattern", "match", "test", "developer", "string", "search"],
    description:
      "Test a regular expression against input text. Returns all matches with their positions and capture groups.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { pattern: "\\d+", text: "abc123def456", flags: "g" },
      inputSchema: { properties: { pattern: { type: "string" }, text: { type: "string" }, flags: { type: "string", description: "RegExp flags, default \"g\"" } }, required: ["pattern", "text"] },
      output: { example: { matches: [{ match: "123", index: 3, groups: [] }], count: 2, valid: true } },
    }),
  },

  "GET /lorem": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Lorem Ipsum Generator",
    tags: ["lorem", "ipsum", "placeholder", "text", "content", "generator", "dummy", "copy"],
    description:
      "Generate placeholder lorem ipsum text. Specify how many paragraphs or words you need.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { paragraphs: "2" },
      inputSchema: { properties: { paragraphs: { type: "string", description: "How many paragraphs, 1 to 10, default 1" } } },
      output: { example: { text: "Lorem ipsum dolor sit amet...", wordCount: 69, paragraphs: 2 } },
    }),
  },

  "GET /csv": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "CSV to JSON Converter",
    tags: ["csv", "json", "convert", "data", "transform", "spreadsheet", "table", "parse"],
    description:
      "Convert CSV data to a JSON array of objects. First row is treated as headers.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { csv: "name,age\nada,36\ngrace,45" },
      inputSchema: { properties: { csv: { type: "string", description: "CSV text, first row is headers, max 10000 chars" } }, required: ["csv"] },
      output: { example: { data: [{ name: "ada", age: "36" }], rows: 2, columns: 2 } },
    }),
  },

  "GET /password": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Passphrase Generator",
    tags: ["password", "passphrase", "security", "random", "generate", "entropy", "credential", "authentication"],
    description:
      "Generate a cryptographically secure random passphrase. Choose number of words and separator.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { words: "4", separator: "-" },
      inputSchema: { properties: { words: { type: "string", description: "How many words, 3 to 8, default 4" }, separator: { type: "string", description: "Joiner, default \"-\"" } } },
      output: { example: { passphrase: "harbor-anchor-copper-lantern", words: 4, entropy: 34.2 } },
    }),
  },

  "GET /cron": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Cron Expression Explainer",
    tags: ["cron", "schedule", "crontab", "explain", "parse", "job", "automation", "timing"],
    description:
      "Parse a cron expression and explain it in plain English. Also shows the next 5 scheduled times.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { expression: "0 9 * * 1-5" },
      inputSchema: { properties: { expression: { type: "string", description: "Standard 5-field cron expression" } }, required: ["expression"] },
      output: { example: { explanation: "At 09:00, Monday through Friday", next: ["2026-09-09T09:00:00.000Z"] } },
    }),
  },

  "GET /units": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Unit Converter",
    tags: ["units", "convert", "measurement", "length", "mass", "temperature", "volume", "metric", "imperial"],
    description:
      "Convert between units of measurement. Supports length, mass, temperature, and volume.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { value: "1", from: "inch", to: "cm" },
      inputSchema: { properties: { value: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["value", "from", "to"] },
      output: { example: { result: 2.54, value: 1, from: "inch", to: "cm", dimension: "length" } },
    }),
  },

  "GET /weather": {
    accepts: {
      scheme: "exact",
      payTo: PAYTO,
      network: "stellar:testnet",
      price: { asset: ASSET, amount: PRICE_ATOMIC_001_USDC },
      maxTimeoutSeconds: 120,
    },
    serviceName: "Current Weather",
    tags: ["weather", "temperature", "forecast", "climate", "conditions", "city", "humidity", "wind", "meteorology"],
    description:
      "Get current weather conditions for any city. Returns temperature, humidity, wind speed, and conditions.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: { city: "Lagos" },
      inputSchema: { properties: { city: { type: "string", description: "City name to look up" } }, required: ["city"] },
      output: { example: { city: "Lagos", temperature: 27.4, unit: "celsius", humidity: 78, windSpeed: 11.2, conditions: "partly cloudy" } },
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
  if (USING_DEMO_DEFAULTS) {
    console.error(
      `[seller] NOTE: no PAYTO/ASSET set, so this is running on Vellar's DEMO merchant\n` +
        `         and canonical testnet USDC. Payments to this seller go to US, not you.\n` +
        `         Fine for trying the loop; wrong for your own service. To use your own:\n` +
        `           cd examples && USE_USDC=1 node provision-testnet.mjs\n` +
        `         then pass the PAYTO and ASSET it prints.`,
    );
  }
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

/**
 * Refuse the one combination that writes permanent junk into shared state.
 *
 * A resource is cataloged the first time a payment settles for it, keyed by URL,
 * and there is no self-service removal and no supported operator one. So a
 * seller advertising `http://localhost:4031/quote` while pointed at a SHARED
 * facilitator leaves a public entry that every agent can see, no one can call,
 * and nobody can delete — it can never pass ownership verification, so it is
 * `ownerVerified: false` forever and counted in the facilitator's
 * `unverifiableEntries`.
 *
 * The trap was that this is the DEFAULT path: FACILITATOR_URL defaults to the
 * hosted instance and PUBLIC_BASE_URL is usually unset locally, so following the
 * walkthrough literally produced exactly this. docs/using-it.md warned about it
 * at length while the tooling walked people into it.
 *
 * Deliberately narrow: it refuses ONLY remote-facilitator + unverifiable-URL.
 * A public seller on a shared facilitator is the normal deployed case and is
 * untouched; a localhost seller on a localhost facilitator is the walkthrough
 * and is untouched. Both fixes are named because either one is legitimate
 * depending on what you are doing.
 */
function preflightCatalogSafety() {
  const resourceUrl = `${publicBase()}/quote`;
  if (isLocalFacilitator(FACILITATOR_URL) || isPubliclyVerifiable(resourceUrl)) return;

  console.error(
    `\n[seller] REFUSING TO BOOT — this would write a permanent entry into a shared catalog.\n\n` +
      `  advertising : ${resourceUrl}\n` +
      `  facilitator : ${FACILITATOR_URL}  (not local)\n\n` +
      `  That URL can never pass ownership verification (public https only — no http,\n` +
      `  no loopback, no private ranges). The first settlement would list it publicly,\n` +
      `  permanently, with ownerVerified: false. There is no removal path.\n\n` +
      `  Fix it whichever way matches what you are doing:\n\n` +
      `    • Walking the guide locally — run your own facilitator and point at it:\n` +
      `        FACILITATOR_URL=http://localhost:4100 node seller.mjs\n\n` +
      `    • Deploying for real — advertise your public address:\n` +
      `        PUBLIC_BASE_URL=https://your-seller.example node seller.mjs\n\n` +
      `  Override with ALLOW_UNVERIFIABLE_ON_SHARED=1 if you genuinely mean it.\n`,
  );
  process.exit(1);
}

if (!process.env.ALLOW_UNVERIFIABLE_ON_SHARED) preflightCatalogSafety();
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
    verifiable: isPubliclyVerifiable(resourceUrl),
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

/**
 * Thrown by a route's `validate(req)` to reject malformed/missing/out-of-range
 * input with a specific status (always a 4xx) and a human-readable message.
 * Caught by `handlePaidRoute` BEFORE the payment gate runs, so a request that
 * was never going to produce a valid result never makes it as far as a 402
 * challenge or a real charge — an agent shouldn't have to pay to learn its
 * input was malformed.
 */
class InputError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Shared payment-gating flow for every paid GET route in this file: validate
 * input up front, run the request through `processHTTPRequest`, forward a 402
 * challenge or a verify failure exactly as `/quote` already did, settle
 * through the facilitator on success, and only then call `buildResult(req)`
 * for the route's own payload.
 *
 * Factored out of `/quote`'s original inline handler (this is the ONLY place
 * that pattern is now written) so the seven new routes below reuse the exact
 * same gating instead of eight near-identical copies drifting apart. `/quote`
 * itself now calls this too — its behavior is unchanged, byte-for-byte, from
 * before this refactor (it passes no `validate`, so that step is a no-op).
 *
 * `validate(req)` runs FIRST, before any payment processing, and must throw
 * `InputError` (never anything else) to reject a request — this keeps a
 * malformed/unpaid request from ever reaching the 402 challenge, so nobody is
 * asked to pay for a request that could never succeed.
 *
 * `buildResult(req)` runs AFTER settlement and must be synchronous-or-async;
 * if it throws (a bug, or an external dependency like Horizon failing in a
 * way `validate` couldn't have caught up front — e.g. Horizon timing out on a
 * well-formed address), that is a 502, logged, with payment already settled —
 * same tradeoff `/quote`'s original handler body always had.
 */
function handlePaidRoute(routePattern, buildResult, validate) {
  return async (req, res) => {
    if (validate) {
      try {
        await validate(req);
      } catch (err) {
        if (err instanceof InputError) {
          return res.status(err.status).json({ error: "invalid_input", detail: err.message });
        }
        console.error(`[seller] ${routePattern} validate() threw a non-InputError: ${String(err?.message || err)}`);
        return res.status(400).json({ error: "invalid_input", detail: String(err?.message || err) });
      }
    }

    const paymentHeader = req.get("PAYMENT-SIGNATURE") || req.get("X-PAYMENT") || undefined;
    const presentedPayment = Boolean(paymentHeader);
    let result;
    try {
      result = await httpServer.processHTTPRequest({
        adapter: adapter(req),
        path: req.path,
        method: req.method,
        paymentHeader,
        routePattern,
      });
    } catch (err) {
      return res.status(500).json({ error: "resource server error", detail: String(err?.message || err) });
    }

    if (result.type === "payment-error") {
      const { status, headers, body } = result.response;
      // NOT every payment-error is a failure. A request that presented NO
      // payment gets the 402 CHALLENGE, and that is the protocol working — its
      // body is empty by design because the requirements travel in the
      // payment-required HEADER. Logging it as a failure (and filling the
      // empty body) would make every unpaid first request look broken, which
      // is the same class of misleading diagnostic this block exists to
      // remove.
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
    let settle;
    try {
      settle = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
      );
    } catch (err) {
      // A throw from processSettlement never had a body to lose, but it was
      // also never logged — so a crash-shaped failure and a refusal looked
      // the same from outside.
      return relayFailure(res, "settle-threw", 502, {}, undefined, {
        detail: String(err?.message || err),
      });
    }
    for (const [k, v] of Object.entries(settle.headers || {})) res.setHeader(k, v);
    if (settle.success === false) {
      const { status, headers, body } = settle.response || {};
      // `settle.errorReason` carries the facilitator's status and body
      // verbatim when the client library could not parse a structured error
      // — which is exactly the case for our own 503s. It is the most
      // informative field available, and it was being dropped.
      return relayFailure(res, "settle", status || 502, headers, body, {
        detail: settle.errorReason,
        errorMessage: settle.errorMessage,
      });
    }

    // Payment settled. Build this route's own payload; errors here are ours,
    // not the facilitator's, so they get their own clear status/body rather
    // than being folded into relayFailure's x402-shaped envelope.
    try {
      const payload = await buildResult(req);
      res.json({
        ...payload,
        settlement: { transaction: settle.transaction, payer: settle.payer, network: settle.network },
      });
    } catch (err) {
      console.error(`[seller] ${routePattern} handler failed after settlement: ${String(err?.message || err)}`);
      res.status(502).json({ error: "handler_failed", detail: String(err?.message || err) });
    }
  };
}

app.get(
  "/quote",
  handlePaidRoute("GET /quote", (req) => ({
    quote: "Ships are safe in harbor, but that's not what ships are for.",
    topic: req.query.topic ?? "perseverance",
  })),
);

// ---------------------------------------------------------------------------
// SEVEN NEW PAID ROUTES.
//
// Each follows the same shape: a `validate` step (runs before any payment
// processing, throws InputError for a clean 4xx) and a `buildResult` step
// (runs after settlement, returns the JSON payload merged with `settlement`).
// Response shape matches /quote's own established convention — flat fields
// plus a `settlement` block, NOT wrapped in a `result` envelope.
// ---------------------------------------------------------------------------

app.get(
  "/inspect/:address",
  handlePaidRoute(
    "GET /inspect/:address",
    async (req) => {
      const address = req.params.address;

      const [accountRes, txRes] = await Promise.all([
        fetchHorizon(`/accounts/${encodeURIComponent(address)}`),
        fetchHorizon(`/accounts/${encodeURIComponent(address)}/transactions?order=desc&limit=3`),
      ]);

      if (!accountRes.ok) {
        if (accountRes.status === 404) {
          throw new InputError(404, `no account found on Stellar testnet for address ${address}`);
        }
        const reason = accountRes.timedOut
          ? "Horizon did not respond within 10s"
          : accountRes.error || `Horizon returned HTTP ${accountRes.status}`;
        throw new Error(`horizon_unavailable: ${reason}`);
      }

      // Horizon's classic /accounts balances array reports both the native
      // XLM line (asset_type: "native", no asset_code) and any classic
      // trustline the account holds — including USDC, since the SAC this
      // seller prices in (CBIELTK6…) wraps a classic Circle-issued asset that
      // shows up here the same way any other trustline balance does. No
      // separate Soroban RPC call needed; "all from Horizon testnet" per
      // spec.
      const balances = accountRes.body?.balances || [];
      const xlmLine = balances.find((b) => b.asset_type === "native");
      const usdcLine = balances.find((b) => b.asset_code === "USDC");

      const hashes = (txRes.ok ? txRes.body?._embedded?.records || [] : []).map((t) => t.hash);

      return {
        address,
        xlmBalance: xlmLine?.balance ?? "0",
        usdcBalance: usdcLine?.balance ?? "0",
        recentTransactionHashes: hashes,
      };
    },
    async (req) => {
      const address = req.params.address;
      if (!address || typeof address !== "string") {
        throw new InputError(400, "missing address path parameter");
      }
      if (!StrKey.isValidEd25519PublicKey(address)) {
        throw new InputError(400, `"${address}" is not a valid Stellar G... address`);
      }
    },
  ),
);

app.get(
  "/stroops",
  handlePaidRoute(
    "GET /stroops",
    (req) => {
      const usdc = req.query.usdc;
      const stroops = usdcToStroops(usdc);
      return { usdc, stroops: stroops.toString() };
    },
    (req) => {
      const usdc = req.query.usdc;
      if (usdc === undefined || usdc === "") {
        throw new InputError(400, "missing required query param: usdc");
      }
      if (typeof usdc !== "string" || usdcToStroops(usdc) === null) {
        throw new InputError(
          400,
          `"${usdc}" is not a valid USDC decimal amount (expected e.g. "1.5", up to 7 decimal places, no sign/exponent)`,
        );
      }
    },
  ),
);

// ── Helpers for the eleven corpus-expansion routes ─────────────────────────
// Kept together and above their handlers, same as HASH_INPUT_MAX_LEN and
// usdcToStroops sit above theirs.

const QR_TEXT_MAX = 500;
const MARKDOWN_MAX = 5000;
const DIFF_SIDE_MAX = 5000;
const REGEX_TEXT_MAX = 5000;
const CSV_MAX = 10000;
const REGEX_MATCH_CAP = 100;

/** One required string query param, bounded. Throws InputError like every
 *  other validate() in this file. */
function requireStringParam(req, name, max) {
  const v = req.query[name];
  if (v === undefined || v === "") throw new InputError(400, `missing required query param: ${name}`);
  if (typeof v !== "string") throw new InputError(400, `${name} must be a single string query param`);
  if (max !== undefined && v.length > max) {
    throw new InputError(400, `${name} too long (${v.length} chars), max ${max}`);
  }
  return v;
}

/** Parse #rrggbb / #rgb / rgb(r,g,b) / hsl(h,s%,l%) into {r,g,b} 0-255. */
function parseColor(input) {
  const t = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(t);
  if (m) {
    const [a, b, c] = m[1];
    return { r: parseInt(a + a, 16), g: parseInt(b + b, 16), b: parseInt(c + c, 16) };
  }
  m = /^#([0-9a-f]{6})$/.exec(t);
  if (m) {
    return {
      r: parseInt(m[1].slice(0, 2), 16),
      g: parseInt(m[1].slice(2, 4), 16),
      b: parseInt(m[1].slice(4, 6), 16),
    };
  }
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]*)?\)$/.exec(t);
  if (m) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if ([r, g, b].every((n) => n <= 255)) return { r, g, b };
    return null;
  }
  m = /^hsla?\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*(?:,[^)]*)?\)$/.exec(t);
  if (m) return hslToRgb(((Number(m[1]) % 360) + 360) % 360, Number(m[2]) / 100, Number(m[3]) / 100);
  return null;
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][Math.floor(h / 60) % 6];
  return {
    r: Math.round((seg[0] + m) * 255),
    g: Math.round((seg[1] + m) * 255),
    b: Math.round((seg[2] + m) * 255),
  };
}

function rgbToHsl({ r, g, b }) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h = Math.round(h * 60);
  return { h: (h + 360) % 360, s, l };
}

const LOREM_WORDS =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum".split(
    " ",
  );

/** RFC4180-ish CSV: handles quoted fields, escaped quotes, and CRLF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

const PASSPHRASE_WORDS =
  "anchor amber apple arbor arrow autumn basin beacon bishop blossom bramble breeze bridge bronze cactus canyon carbon cedar cinder cipher citrus clover cobalt comet copper coral cotton crater crimson crystal cypress dahlia damson dapple dawn delta desert diamond dolphin domino dragon driftwood dusk ember emerald ermine falcon fathom feather fennel fern fjord flint forest fossil fountain foxglove garnet ginger glacier granite gravel harbor harvest hazel heather hemlock heron hollow horizon hurricane indigo iris island ivory jasmine jasper jetty juniper kelp kestrel lagoon lantern larch lattice laurel lava ledger lichen lilac linden lantern lupine magnet magnolia mahogany mallow mangrove maple marble marigold marsh meadow mercury meteor mica midnight mineral mirage mist monsoon moraine mosaic moss mulberry nebula nectar needle nettle nickel nimbus nutmeg oasis obsidian ocean olive onyx opal orchard orchid osprey otter oxide oyster paddock pampas papyrus parsley pasture peat pebble pelican pepper petal pewter pigment pillar pine pinnacle piper plateau plover plum pollen pond poplar poppy prairie prism pumice quarry quartz quill quince radish rainbow rapids raven reef reed relic ridge rill rimrock river rosemary rowan rubble ruby rush saffron sage salmon sandstone sapphire savanna scarlet sequoia shale shore sienna silica silt silver sorrel spindle spruce squall starling steppe sterling stone stork storm summit sunset surf swallow sycamore talon tamarind tangerine teal tempest terrace thicket thistle thorn thrush thunder tidal timber topaz torrent tundra turquoise umber valley velvet verbena vermilion vertex vine violet vista walnut warbler waterfall wavelength willow windmill winter wisteria wren yarrow yew zephyr zircon".split(
    " ",
  );

const CRON_DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CRON_MONTH = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/** Expand one cron field into the sorted set of values it permits. */
function cronField(spec, min, max) {
  const out = new Set();
  for (const part of spec.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo;
    let hi;
    if (range === "*") { lo = min; hi = max; }
    else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      lo = a; hi = b;
    } else {
      const v = Number(range);
      if (!Number.isInteger(v)) return null;
      lo = v; hi = stepRaw === undefined ? v : max;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function describeCronField(values, all, fmt) {
  if (values.length === all) return null;
  return values.map(fmt).join(", ");
}

/** Unit table. Length/mass/volume convert through a base unit; temperature
 *  needs offsets so it is handled separately. */
const UNITS = {
  length: { m: 1, meter: 1, meters: 1, km: 1000, kilometer: 1000, cm: 0.01, mm: 0.001,
            inch: 0.0254, in: 0.0254, ft: 0.3048, foot: 0.3048, feet: 0.3048,
            yard: 0.9144, yd: 0.9144, mile: 1609.344, mi: 1609.344 },
  mass:   { g: 1, gram: 1, grams: 1, kg: 1000, kilogram: 1000, mg: 0.001,
            lb: 453.59237, pound: 453.59237, oz: 28.349523125, ounce: 28.349523125,
            stone: 6350.29318, tonne: 1e6, ton: 1e6 },
  volume: { l: 1, liter: 1, litre: 1, ml: 0.001, cl: 0.01,
            gallon: 3.785411784, gal: 3.785411784, quart: 0.946352946,
            pint: 0.473176473, cup: 0.2365882365, floz: 0.0295735295625 },
};
const TEMPS = new Set(["c", "celsius", "f", "fahrenheit", "k", "kelvin"]);

function toCelsius(v, u) {
  if (u === "c" || u === "celsius") return v;
  if (u === "f" || u === "fahrenheit") return (v - 32) * (5 / 9);
  return v - 273.15;
}
function fromCelsius(c, u) {
  if (u === "c" || u === "celsius") return c;
  if (u === "f" || u === "fahrenheit") return c * (9 / 5) + 32;
  return c + 273.15;
}
function dimensionOf(unit) {
  if (TEMPS.has(unit)) return "temperature";
  for (const [dim, table] of Object.entries(UNITS)) if (unit in table) return dim;
  return null;
}

/** Open-Meteo, the one external dependency among these routes. No API key.
 *  Bounded by AbortController like fetchHorizon above, so a slow upstream
 *  cannot hold a paid request open indefinitely. */
const OPEN_METEO_TIMEOUT_MS = 8000;
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPEN_METEO_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, timedOut: err?.name === "AbortError" };
  } finally {
    clearTimeout(timer);
  }
}

/** WMO weather interpretation codes, the subset Open-Meteo actually returns. */
const WMO = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "depositing rime fog", 51: "light drizzle", 53: "moderate drizzle",
  55: "dense drizzle", 56: "light freezing drizzle", 57: "dense freezing drizzle",
  61: "slight rain", 63: "moderate rain", 65: "heavy rain",
  66: "light freezing rain", 67: "heavy freezing rain",
  71: "slight snow", 73: "moderate snow", 75: "heavy snow", 77: "snow grains",
  80: "slight rain showers", 81: "moderate rain showers", 82: "violent rain showers",
  85: "slight snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with slight hail", 99: "thunderstorm with heavy hail",
};

const HASH_INPUT_MAX_LEN = 500;

app.get(
  "/hash",
  handlePaidRoute(
    "GET /hash",
    (req) => {
      const input = req.query.input;
      return {
        input,
        sha256: createHash("sha256").update(input, "utf8").digest("hex"),
        md5: createHash("md5").update(input, "utf8").digest("hex"),
      };
    },
    (req) => {
      const input = req.query.input;
      if (input === undefined || input === "") {
        throw new InputError(400, "missing required query param: input");
      }
      if (typeof input !== "string") {
        throw new InputError(400, "input must be a single string query param");
      }
      if (input.length > HASH_INPUT_MAX_LEN) {
        throw new InputError(400, `input too long (${input.length} chars) — max ${HASH_INPUT_MAX_LEN}`);
      }
    },
  ),
);

app.get(
  "/timestamp",
  handlePaidRoute("GET /timestamp", async () => {
    const now = new Date();
    const ledgerRes = await fetchHorizon("/ledgers?order=desc&limit=1");
    if (!ledgerRes.ok) {
      const reason = ledgerRes.timedOut
        ? "Horizon did not respond within 10s"
        : ledgerRes.error || `Horizon returned HTTP ${ledgerRes.status}`;
      throw new Error(`horizon_unavailable: ${reason}`);
    }
    const ledger = ledgerRes.body?._embedded?.records?.[0];
    if (!ledger || typeof ledger.sequence !== "number") {
      throw new Error("horizon_unavailable: unexpected /ledgers response shape (no sequence found)");
    }
    return {
      iso8601: now.toISOString(),
      unixSeconds: Math.floor(now.getTime() / 1000),
      stellarLedgerSequence: ledger.sequence,
    };
  }),
);

const BASE64_INPUT_MAX_LEN = 1000;
// Plausible-base64 check: standard alphabet, correctly padded to a multiple
// of 4. Used both to reject obviously-invalid `mode=decode` input up front
// AND, after decoding, to catch Buffer.from's lenient decoding (it silently
// ignores non-base64 characters rather than throwing) by re-encoding the
// decoded bytes and comparing against the (whitespace-stripped) original —
// a round-trip mismatch means the input wasn't really valid base64.
const BASE64_SHAPE_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

app.get(
  "/base64",
  handlePaidRoute(
    "GET /base64",
    (req) => {
      const { input, mode } = req.query;
      if (mode === "encode") {
        return { mode, input, output: Buffer.from(input, "utf8").toString("base64") };
      }
      // mode === "decode", already validated round-trips cleanly.
      return { mode, input, output: Buffer.from(input, "base64").toString("utf8") };
    },
    (req) => {
      const { input, mode } = req.query;
      if (mode === undefined || mode === "") {
        throw new InputError(400, "missing required query param: mode (must be \"encode\" or \"decode\")");
      }
      if (mode !== "encode" && mode !== "decode") {
        throw new InputError(400, `mode must be "encode" or "decode", got "${mode}"`);
      }
      if (input === undefined || input === "") {
        throw new InputError(400, "missing required query param: input");
      }
      if (typeof input !== "string") {
        throw new InputError(400, "input must be a single string query param");
      }
      if (input.length > BASE64_INPUT_MAX_LEN) {
        throw new InputError(400, `input too long (${input.length} chars) — max ${BASE64_INPUT_MAX_LEN}`);
      }
      if (mode === "decode") {
        const stripped = input.replace(/\s+/g, "");
        if (!BASE64_SHAPE_REGEX.test(stripped)) {
          throw new InputError(400, `"${input}" is not valid base64`);
        }
        // Round-trip check: Buffer.from(x, 'base64') silently ignores
        // characters outside the alphabet rather than throwing, so the shape
        // regex above is necessary but re-encoding and comparing is what
        // actually catches lenient-decode garbage.
        const roundTripped = Buffer.from(stripped, "base64").toString("base64");
        if (roundTripped.replace(/=+$/, "") !== stripped.replace(/=+$/, "")) {
          throw new InputError(400, `"${input}" is not valid base64 (failed round-trip check)`);
        }
      }
    },
  ),
);

const WORD_COUNT_INPUT_MAX_LEN = 2000;
// Reading speed assumption: 200 words per minute. This sits inside the
// commonly-cited 200-238 wpm average adult silent-reading range; 200 is used
// specifically because it is the more conservative (slower) end, which is
// the safer bias for an estimate nobody can verify against the reader. This
// is a documented heuristic, not a precise measurement.
const READING_WPM = 200;
// Sentence-boundary heuristic: count runs of `.`/`!`/`?` as one terminator
// each (so "..." or "?!" count once). This is not linguistically precise
// (misses abbreviations like "Mr." as false positives, etc.) — it's a
// reasonable, documented approximation, not a claim of exactness.
const SENTENCE_TERMINATOR_REGEX = /[.!?]+/g;

app.get(
  "/word-count",
  handlePaidRoute(
    "GET /word-count",
    (req) => {
      const text = req.query.text;
      const trimmed = text.trim();
      const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
      const sentenceMatches = text.match(SENTENCE_TERMINATOR_REGEX);
      const sentences = sentenceMatches ? sentenceMatches.length : 0;
      const estimatedReadingTimeSeconds = Math.ceil((words / READING_WPM) * 60);
      return {
        text,
        words,
        characters: text.length,
        sentences,
        estimatedReadingTimeSeconds,
      };
    },
    (req) => {
      const text = req.query.text;
      if (text === undefined || text === "") {
        throw new InputError(400, "missing required query param: text");
      }
      if (typeof text !== "string") {
        throw new InputError(400, "text must be a single string query param");
      }
      if (text.length > WORD_COUNT_INPUT_MAX_LEN) {
        throw new InputError(400, `text too long (${text.length} chars) — max ${WORD_COUNT_INPUT_MAX_LEN}`);
      }
    },
  ),
);

app.get(
  "/uuid",
  handlePaidRoute("GET /uuid", () => {
    // randomUUID() is called fresh on every request — nothing here is cached
    // or memoized, so distinct calls always produce distinct UUIDs.
    const uuid = randomUUID();
    const fingerprint = createHash("sha256").update(uuid, "utf8").digest("hex");
    return { uuid, fingerprint };
  }),
);

// ── Handlers for the eleven corpus-expansion routes ────────────────────────

app.get(
  "/qr",
  handlePaidRoute(
    "GET /qr",
    async (req) => ({
      text: req.query.text,
      dataUrl: await QRCode.toDataURL(req.query.text, { errorCorrectionLevel: "M", margin: 1 }),
    }),
    (req) => { requireStringParam(req, "text", QR_TEXT_MAX); },
  ),
);

app.get(
  "/color",
  handlePaidRoute(
    "GET /color",
    (req) => {
      const rgb = parseColor(req.query.color);
      const { h, s, l } = rgbToHsl(rgb);
      const hex = `#${[rgb.r, rgb.g, rgb.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      return {
        input: req.query.color,
        hex,
        rgb: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
        hsl: `hsl(${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`,
      };
    },
    (req) => {
      const color = requireStringParam(req, "color", 64);
      if (parseColor(color) === null) {
        throw new InputError(400, `"${color}" is not a recognised color (expected #rrggbb, rgb(r,g,b), or hsl(h,s%,l%))`);
      }
    },
  ),
);

app.get(
  "/markdown",
  handlePaidRoute(
    "GET /markdown",
    (req) => ({ html: marked.parse(req.query.markdown) }),
    (req) => { requireStringParam(req, "markdown", MARKDOWN_MAX); },
  ),
);

app.get(
  "/diff",
  handlePaidRoute(
    "GET /diff",
    (req) => {
      const parts = diffLines(req.query.original, req.query.revised);
      let additions = 0;
      let deletions = 0;
      let unchanged = 0;
      let text = "";
      for (const part of parts) {
        const lines = part.value.split("\n").filter((l) => l !== "");
        if (part.added) { additions += lines.length; for (const l of lines) text += `+ ${l}\n`; }
        else if (part.removed) { deletions += lines.length; for (const l of lines) text += `- ${l}\n`; }
        else { unchanged += lines.length; for (const l of lines) text += `  ${l}\n`; }
      }
      return { diff: text, additions, deletions, unchanged };
    },
    (req) => {
      requireStringParam(req, "original", DIFF_SIDE_MAX);
      requireStringParam(req, "revised", DIFF_SIDE_MAX);
    },
  ),
);

app.get(
  "/regex",
  handlePaidRoute(
    "GET /regex",
    (req) => {
      const flags = typeof req.query.flags === "string" && req.query.flags !== "" ? req.query.flags : "g";
      const re = new RegExp(req.query.pattern, flags.includes("g") ? flags : `${flags}g`);
      const matches = [];
      for (const m of req.query.text.matchAll(re)) {
        if (matches.length >= REGEX_MATCH_CAP) break;
        matches.push({ match: m[0], index: m.index, groups: m.slice(1) });
      }
      return { pattern: req.query.pattern, flags, matches, count: matches.length, valid: true };
    },
    (req) => {
      const pattern = requireStringParam(req, "pattern", 500);
      requireStringParam(req, "text", REGEX_TEXT_MAX);
      const flags = req.query.flags;
      if (flags !== undefined && typeof flags !== "string") {
        throw new InputError(400, "flags must be a single string query param");
      }
      if (typeof flags === "string" && !/^[dgimsuvy]*$/.test(flags)) {
        throw new InputError(400, `"${flags}" contains an invalid RegExp flag`);
      }
      try {
        new RegExp(pattern, typeof flags === "string" && flags !== "" ? flags : "g");
      } catch (err) {
        throw new InputError(400, `pattern is not a valid regular expression: ${String(err?.message || err)}`);
      }
    },
  ),
);

app.get(
  "/lorem",
  handlePaidRoute(
    "GET /lorem",
    (req) => {
      const n = req.query.paragraphs === undefined || req.query.paragraphs === "" ? 1 : Number(req.query.paragraphs);
      const paragraphs = [];
      let wordCount = 0;
      for (let i = 0; i < n; i++) {
        const len = 35 + ((i * 7) % 30);
        const words = [];
        for (let w = 0; w < len; w++) words.push(LOREM_WORDS[(i * 17 + w * 3) % LOREM_WORDS.length]);
        wordCount += words.length;
        const sentence = words.join(" ");
        paragraphs.push(sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".");
      }
      return { text: paragraphs.join("\n\n"), wordCount, paragraphs: n };
    },
    (req) => {
      const raw = req.query.paragraphs;
      if (raw === undefined || raw === "") return;
      if (typeof raw !== "string") throw new InputError(400, "paragraphs must be a single string query param");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        throw new InputError(400, `paragraphs must be a whole number between 1 and 10, got "${raw}"`);
      }
    },
  ),
);

app.get(
  "/csv",
  handlePaidRoute(
    "GET /csv",
    (req) => {
      const rows = parseCsv(req.query.csv);
      const headers = rows[0];
      const data = rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
      return { data, rows: data.length, columns: headers.length, headers };
    },
    (req) => {
      const csv = requireStringParam(req, "csv", CSV_MAX);
      const rows = parseCsv(csv);
      if (rows.length < 2) {
        throw new InputError(400, "csv needs a header row and at least one data row");
      }
    },
  ),
);

app.get(
  "/password",
  handlePaidRoute(
    "GET /password",
    (req) => {
      const words = req.query.words === undefined || req.query.words === "" ? 4 : Number(req.query.words);
      const separator = typeof req.query.separator === "string" && req.query.separator !== "" ? req.query.separator : "-";
      const picked = [];
      for (let i = 0; i < words; i++) picked.push(PASSPHRASE_WORDS[randomInt(PASSPHRASE_WORDS.length)]);
      return {
        passphrase: picked.join(separator),
        words,
        separator,
        // Entropy assumes uniform selection WITH replacement from the list,
        // which is what randomInt gives: log2(listSize) bits per word.
        entropy: Number((words * Math.log2(PASSPHRASE_WORDS.length)).toFixed(1)),
        wordlistSize: PASSPHRASE_WORDS.length,
      };
    },
    (req) => {
      const raw = req.query.words;
      if (raw !== undefined && raw !== "") {
        if (typeof raw !== "string") throw new InputError(400, "words must be a single string query param");
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 3 || n > 8) {
          throw new InputError(400, `words must be a whole number between 3 and 8, got "${raw}"`);
        }
      }
      const sep = req.query.separator;
      if (sep !== undefined && (typeof sep !== "string" || sep.length > 4)) {
        throw new InputError(400, "separator must be a string of at most 4 characters");
      }
    },
  ),
);

app.get(
  "/cron",
  handlePaidRoute(
    "GET /cron",
    (req) => {
      const [min, hour, dom, mon, dow] = req.query.expression.trim().split(/\s+/);
      const mins = cronField(min, 0, 59);
      const hours = cronField(hour, 0, 23);
      const doms = cronField(dom, 1, 31);
      const mons = cronField(mon, 1, 12);
      const dows = cronField(dow, 0, 6);

      const timeBit =
        mins.length === 60 && hours.length === 24
          ? "Every minute"
          : hours.length === 24
            ? `At minute ${mins.join(", ")} of every hour`
            : `At ${hours.flatMap((h) => mins.map((m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`)).slice(0, 6).join(", ")}`;
      const dowBit = describeCronField(dows, 7, (d) => CRON_DOW[d]);
      const domBit = describeCronField(doms, 31, (d) => `day ${d}`);
      const monBit = describeCronField(mons, 12, (m) => CRON_MONTH[m - 1]);
      const explanation = [timeBit, dowBit && `on ${dowBit}`, domBit && `on ${domBit}`, monBit && `in ${monBit}`]
        .filter(Boolean)
        .join(", ");

      // Walk forward minute by minute from the next whole minute. Bounded at
      // roughly four years so an unsatisfiable expression terminates.
      const next = [];
      const cursor = new Date();
      cursor.setUTCSeconds(0, 0);
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
      for (let i = 0; i < 2200000 && next.length < 5; i++) {
        if (
          mins.includes(cursor.getUTCMinutes()) &&
          hours.includes(cursor.getUTCHours()) &&
          doms.includes(cursor.getUTCDate()) &&
          mons.includes(cursor.getUTCMonth() + 1) &&
          dows.includes(cursor.getUTCDay())
        ) {
          next.push(cursor.toISOString());
        }
        cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
      }
      return { expression: req.query.expression, explanation, next, timezone: "UTC" };
    },
    (req) => {
      const expr = requireStringParam(req, "expression", 100);
      const fields = expr.trim().split(/\s+/);
      if (fields.length !== 5) {
        throw new InputError(400, `cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
      }
      const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
      fields.forEach((f, i) => {
        if (cronField(f, bounds[i][0], bounds[i][1]) === null) {
          throw new InputError(400, `field ${i + 1} ("${f}") is not a valid cron field`);
        }
      });
    },
  ),
);

app.get(
  "/units",
  handlePaidRoute(
    "GET /units",
    (req) => {
      const value = Number(req.query.value);
      const from = req.query.from.trim().toLowerCase();
      const to = req.query.to.trim().toLowerCase();
      const dim = dimensionOf(from);
      if (dim === "temperature") {
        const result = fromCelsius(toCelsius(value, from), to);
        return { result: Number(result.toFixed(6)), value, from, to, dimension: "temperature" };
      }
      const table = UNITS[dim];
      const result = (value * table[from]) / table[to];
      return {
        result: Number(result.toFixed(6)),
        value,
        from,
        to,
        dimension: dim,
        formula: `x ${Number((table[from] / table[to]).toFixed(6))}`,
      };
    },
    (req) => {
      const raw = requireStringParam(req, "value", 32);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new InputError(400, `value must be a finite number, got "${raw}"`);
      const from = requireStringParam(req, "from", 32).trim().toLowerCase();
      const to = requireStringParam(req, "to", 32).trim().toLowerCase();
      const fromDim = dimensionOf(from);
      const toDim = dimensionOf(to);
      if (fromDim === null) throw new InputError(400, `unknown unit "${from}"`);
      if (toDim === null) throw new InputError(400, `unknown unit "${to}"`);
      if (fromDim !== toDim) {
        throw new InputError(400, `cannot convert ${fromDim} to ${toDim} ("${from}" to "${to}")`);
      }
    },
  ),
);

app.get(
  "/weather",
  handlePaidRoute(
    "GET /weather",
    async (req) => {
      const city = req.query.city.trim();
      const geo = await fetchJson(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&format=json`,
      );
      if (!geo.ok) {
        throw new Error(geo.timedOut ? "geocoding service timed out" : `geocoding service returned ${geo.status}`);
      }
      const place = geo.body?.results?.[0];
      if (!place) throw new Error(`no city found matching "${city}"`);
      const wx = await fetchJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
          `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`,
      );
      if (!wx.ok) {
        throw new Error(wx.timedOut ? "weather service timed out" : `weather service returned ${wx.status}`);
      }
      const c = wx.body.current;
      return {
        city: place.name,
        country: place.country,
        temperature: c.temperature_2m,
        unit: "celsius",
        humidity: c.relative_humidity_2m,
        windSpeed: c.wind_speed_10m,
        conditions: WMO[c.weather_code] ?? `unknown (code ${c.weather_code})`,
        observedAt: c.time,
      };
    },
    (req) => { requireStringParam(req, "city", 100); },
  ),
);

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
  console.error(
    `[seller] also serving: /inspect/:address (${PRICE_ATOMIC_002_USDC} atomic), ` +
      `/stroops /hash /timestamp /base64 /word-count /uuid (${PRICE_ATOMIC_001_USDC} atomic each)`,
  );
});
