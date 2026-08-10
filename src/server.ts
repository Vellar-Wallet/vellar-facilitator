import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { loadConfig } from "./config.js";
import { buildFacilitator } from "./facilitator.js";
import { BazaarCatalog } from "./catalog.js";
import { registerBazaar } from "./bazaar.js";
import {
  annotateTrust,
  filterVerifiedOnly,
  rerankVerifiedFirst,
  type TrustResolver,
} from "./trust.js";
import { createSpendPolicy, type SpendPolicy } from "./policy.js";
import { BalanceGuard } from "./balance.js";

interface FacilitatorRequestBody {
  x402Version?: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

interface ListQuery {
  type?: string;
  payTo?: string;
  scheme?: string;
  network?: string;
  extensions?: string;
  limit?: string;
  offset?: string;
  /** Trust-layer filter: "true" keeps only verification-verified entries. */
  verified_only?: string;
}

interface SearchQuery extends Omit<ListQuery, "offset"> {
  query?: string;
  cursor?: string;
}

export interface HardeningOptions {
  /** Per-IP requests/minute (default 60). /health is always exempt. */
  rateMaxPerMinute?: number;
  /** Max body bytes for /verify and /settle (default 32 KiB). */
  bodyLimitBytes?: number;
}

const DEFAULT_RATE_MAX = 60;
const DEFAULT_BODY_LIMIT = 32 * 1024;

/** Documented limits, exported so their RATIONALE is assertable — see
 * src/config.thresholds.test.ts. Read-only. */
export const SERVER_LIMITS = Object.freeze({
  defaultRateMaxPerMinute: DEFAULT_RATE_MAX,
  defaultBodyLimitBytes: DEFAULT_BODY_LIMIT,
  /** Largest real settlement envelope measured on-chain, in base64 chars. The
   * body limit is derived from this, not picked. */
  measuredMaxEnvelopeChars: 3_400,
});

export async function buildServer(
  facilitator: ReturnType<typeof buildFacilitator>,
  catalog: BazaarCatalog,
  trust?: TrustResolver,
  policy?: SpendPolicy,
  hardening: HardeningOptions = {},
  balanceGuard?: BalanceGuard,
) {
  const bodyLimit = hardening.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  // Fix 2: a body-limit floor for /verify and /settle (well under Fastify's 1 MiB
  // default), sized for real signed settlement XDR with headroom.
  // Audit D4: this service runs behind Render's reverse proxy (render.yaml,
  // type: web), so without trustProxy every request appears to come from the
  // proxy's IP and the per-IP rate limit collapses into a single shared bucket —
  // one noisy client 429s everyone and an IP-rotating attacker is never
  // partitioned.
  //
  // Trust exactly ONE hop, never `true`. X-Forwarded-For is client-writable and
  // Render's proxy APPENDS the true client after whatever the client sent, so
  // `true` would take the attacker-controlled leftmost entry — letting anyone
  // mint a fresh rate-limit bucket per request and evade the limit entirely
  // (strictly worse than the shared-bucket bug). Trusting one hop makes the
  // address Render's proxy actually observed authoritative. Raise this number
  // only if you add more trusted proxies in front of the service.
  const app = Fastify({ logger: true, bodyLimit, trustProxy: 1 });
  registerBazaar(facilitator, catalog);

  // Fix 2: security headers (helmet), an explicit CORS policy, and per-IP rate
  // limiting. /health is exempt so the Render health check cannot be throttled.
  // These are AWAITED before any route is defined so rate-limit's onRoute hook
  // attaches to them — a void/deferred register installs the hook too late for
  // synchronously-added routes.
  await app.register(helmet);
  await app.register(cors, { methods: ["GET", "POST"] });
  await app.register(rateLimit, {
    global: true,
    max: hardening.rateMaxPerMinute ?? DEFAULT_RATE_MAX,
    timeWindow: "1 minute",
    allowList: (req) => req.url === "/health",
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "vellar-facilitator",
    // Spin-down observability. Render destroys the container after 15 min idle,
    // which wipes the catalog — and gives no outside signal that it happened.
    // A RESET uptimeSeconds between two observations is the ground truth for
    // "it slept or redeployed"; catalogSize is the consequence a developer
    // feels. Together they make the keep-alive verifiable from data instead of
    // from someone reporting an empty listing. Neither leaks anything:
    // catalogSize is already derivable from /discovery/resources.
    uptimeSeconds: Math.round(process.uptime()),
    catalogSize: catalog.size,
    // Which build is actually serving. Render injects RENDER_GIT_COMMIT.
    // Without this the only way to answer "is the deploy current?" is to
    // fingerprint behaviour — probing for security headers or an error-message
    // shape — which is archaeology, only works when a release happens to change
    // something externally visible, and let a stale build go unnoticed twice.
    // Now it is a string comparison against `git rev-parse --short HEAD`.
    // Omitted rather than faked when unset, so local runs do not claim a build.
    ...(process.env.RENDER_GIT_COMMIT
      ? { commit: process.env.RENDER_GIT_COMMIT.slice(0, 7) }
      : {}),
    // F3: surfaced so an operator sees a frozen catalog rather than wondering
    // why discovery stopped growing. Settlement is unaffected while frozen.
    ...(catalog.catalogFrozen ? { catalogFrozen: catalog.catalogFrozen } : {}),
  }));

  app.get("/supported", async () => facilitator.getSupported());

  app.post<{ Body: FacilitatorRequestBody }>("/verify", async (request, reply) => {
    const { paymentPayload, paymentRequirements } = request.body ?? {};
    if (!paymentPayload || !paymentRequirements) {
      return reply
        .status(400)
        .send({ error: "invalid_body", detail: "paymentPayload and paymentRequirements are required" });
    }
    // Fix 2: shed obviously-malformed payloads at the route, before spending an
    // RPC simulation. /verify is the free amplification path (an invalid payload
    // still costs one simulation upstream), so reject anything whose transaction
    // isn't parseable XDR without a network round-trip.
    if (!isParseableTransactionXdr(paymentPayload)) {
      return reply
        .status(400)
        .send({ error: "invalid_payload", detail: "payload.transaction is not a parseable transaction envelope" });
    }
    return facilitator.verify(paymentPayload, paymentRequirements);
  });

  app.post<{ Body: FacilitatorRequestBody }>("/settle", async (request, reply) => {
    const { paymentPayload, paymentRequirements } = request.body ?? {};
    if (!paymentPayload || !paymentRequirements) {
      return reply
        .status(400)
        .send({ error: "invalid_body", detail: "paymentPayload and paymentRequirements are required" });
    }
    // Re-audit: shed unsubmittable payloads BEFORE reserving spend budget,
    // symmetric with /verify. Junk costs the sponsor no XLM, so it must not be
    // able to consume the global ceiling and refuse real settlement.
    if (!isParseableTransactionXdr(paymentPayload)) {
      return reply
        .status(400)
        .send({ error: "invalid_payload", detail: "payload.transaction is not a parseable transaction envelope" });
    }
    // Fix 3: refuse settle when the sponsor is below the hard balance floor —
    // fees would fail on-chain anyway. Discovery is unaffected. A failed/absent
    // balance check leaves settle allowed (fail open).
    if (balanceGuard && !balanceGuard.settleAllowed()) {
      request.log.error({ balanceStatus: balanceGuard.status() }, "[balance] settle refused: sponsor below hard floor");
      return reply.status(503).send({ error: "settlement_refused", reason: "sponsor_balance_low" });
    }
    // Fix 1: consult the spend policy before spending sponsor XLM. On pubnet a
    // tripped per-payTo rate limit or global spend ceiling refuses with 503; on
    // testnet it logs what would have tripped and proceeds (fail-open).
    //
    // Audit D3: run the policy UNCONDITIONALLY — never gate it on payTo being
    // truthy, or a client sending an empty payTo would skip the global spend
    // ceiling (the fail-closed backstop), not just the per-payTo limit. A missing
    // payTo maps to a single shared bucket so it can't get free settles.
    let reservation: number | undefined;
    if (policy) {
      const payToKey = policyBucketKey(paymentRequirements.payTo);
      // F12: budget against the DURABLE ownership binding, not verifiedOwner —
      // verifiedOwner is not persisted and resets on restart, so keying on it
      // would drop every merchant into the shared unbound pool after a reboot.
      // G-3: canonicalize to the catalog's own key (`origin + pathname`). The
      // payload carries the RAW url, so without this a merchant on
      // `/quote?symbol=AAPL` reads as unbound on every settle and lands in the
      // shared unbound pool — and the per-URL budget could be multiplied by
      // simply varying the query string.
      const rawResourceUrl =
        (paymentPayload as unknown as { resource?: { url?: string } }).resource?.url ?? "";
      const resourceUrl = BazaarCatalog.canonicalResourceKey(rawResourceUrl);
      const verdict = policy.checkSettle({
        resourceUrl,
        payTo: payToKey,
        bound: rawResourceUrl !== "" && catalog.isBound(resourceUrl, payToKey),
      });
      reservation = verdict.reservation;
      if (!verdict.allowed) {
        request.log.warn(
          { payTo: payToKey, reason: verdict.reason },
          "[policy] settle refused",
        );
        return reply
          .status(503)
          .send({ error: "settlement_refused", reason: verdict.reason });
      }
      if (verdict.wouldReject) {
        request.log.warn(
          { payTo: payToKey, wouldReject: verdict.wouldReject },
          "[policy] settle would be refused on pubnet",
        );
      }
    }
    // Final audit (HIGH): facilitator.settle can THROW, not just return
    // success:false — @x402/core throws for an unregistered x402Version/scheme/
    // network, and @x402/stellar re-throws when `accepted` is absent. Those paths
    // spend ZERO sponsor XLM, but without this try/catch the reservation stayed
    // held and cheap junk could still exhaust the global ceiling and lock out all
    // real settlement. Prevalidation does not cover it: one static valid XDR is
    // reused for every request.
    let result;
    try {
      result = await facilitator.settle(paymentPayload, paymentRequirements);
    } catch (err) {
      policy?.refundUnspent(reservation);
      throw err;
    }
    // Release the reservation when the settlement never reached the chain.
    // @x402/stellar returns an empty `transaction` when it failed before
    // submission (verification/signing/send), meaning ZERO sponsor XLM was spent.
    // A non-empty hash means it was submitted and fees were charged, even if the
    // transaction then failed, so that reservation correctly stands.
    if (policy && result.success === false && !result.transaction) {
      policy.refundUnspent(reservation);
    }
    return result;
  });

  app.get<{ Querystring: ListQuery }>("/discovery/resources", async (request) => {
    const q = request.query;
    const response = catalog.list({
      ...(q.type !== undefined ? { type: q.type } : {}),
      ...(q.payTo !== undefined ? { payTo: q.payTo } : {}),
      ...(q.scheme !== undefined ? { scheme: q.scheme } : {}),
      ...(q.network !== undefined ? { network: q.network } : {}),
      ...(q.extensions !== undefined ? { extensions: q.extensions } : {}),
      ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
      ...(q.offset !== undefined ? { offset: Number(q.offset) } : {}),
    });
    if (!trust) return response;
    let items = await annotateTrust(response.items, trust, (url) => catalog.isVerifiedOwner(url));
    if (q.verified_only === "true") items = filterVerifiedOnly(items);
    return { ...response, items };
  });

  app.get<{ Querystring: SearchQuery }>("/discovery/search", async (request, reply) => {
    const q = request.query;
    if (typeof q.query !== "string" || q.query.length === 0) {
      return reply
        .status(400)
        .send({ error: "invalid_query", detail: "the `query` parameter is required" });
    }
    const response = catalog.search({
      query: q.query,
      ...(q.type !== undefined ? { type: q.type } : {}),
      ...(q.payTo !== undefined ? { payTo: q.payTo } : {}),
      ...(q.scheme !== undefined ? { scheme: q.scheme } : {}),
      ...(q.network !== undefined ? { network: q.network } : {}),
      ...(q.extensions !== undefined ? { extensions: q.extensions } : {}),
      ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    });
    if (!trust) return response;
    // Annotate, then verified-first within the relevance ranking (stable), or
    // hard-filter when the caller asked for verified_only.
    let resources = await annotateTrust(
      response.resources,
      trust,
      (url) => catalog.isVerifiedOwner(url),
    );
    resources = q.verified_only === "true"
      ? filterVerifiedOnly(resources)
      : rerankVerifiedFirst(resources);
    return { ...response, resources };
  });

  return app;
}

/**
 * Re-audit: derive the spend-policy bucket key from a client-supplied payTo.
 * payTo is attacker-controlled and was previously used raw, so a JSON object or
 * a multi-kilobyte string (up to the body limit) minted a fresh bucket on every
 * request — defeating the per-payTo rate limit and growing the policy Map with
 * attacker-chosen keys. Anything that is not a plausibly-shaped Stellar address
 * string collapses into one shared bucket, which cannot earn free settles.
 */
const MAX_PAYTO_KEY_LEN = 128;
function policyBucketKey(payTo: unknown): string {
  if (typeof payTo !== "string") return "<no-payto>";
  const trimmed = payTo.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PAYTO_KEY_LEN) return "<no-payto>";
  return trimmed;
}

/**
 * Fix 2: cheap structural check that `payload.transaction` is a base64 Stellar
 * transaction envelope, without a network round-trip. Parses XDR only — it does
 * NOT validate signatures, sequence, or fees (that is the scheme's re-simulation
 * job). A malformed/garbage string is rejected here so it never reaches an RPC
 * simulation. The passphrase is irrelevant to XDR structure, so any value works.
 */
function isParseableTransactionXdr(payload: PaymentPayload): boolean {
  const tx = (payload as { payload?: { transaction?: unknown } }).payload?.transaction;
  if (typeof tx !== "string" || tx.length === 0) return false;
  try {
    TransactionBuilder.fromXDR(tx, "Test SDF Network ; September 2015");
    return true;
  } catch {
    return false;
  }
}

const isDirectRun = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isDirectRun) {
  const config = loadConfig();
  const catalog = new BazaarCatalog(config.catalogFile, {
    bootstrapOwnership: config.catalogOwnershipBootstrap,
  });
  const { createTrustResolver } = await import("./trust.js");
  const trust = createTrustResolver({
    verificationApiUrl: config.verificationApiUrl,
    rpcUrl: config.rpcUrl ?? "https://soroban-testnet.stellar.org",
  });
  // Per-settle spend is estimated at the fee ceiling (worst case) since the real
  // simulated fee is not exposed on the verify response — over-counting fails safe.
  const policy = createSpendPolicy({
    network: config.network,
    rateWindowMs: config.spend.rateWindowMs,
    spendCeilingStroops: config.spend.ceilingStroops,
    spendWindowMs: config.spend.windowMs,
    perSettleEstimateStroops: config.maxTransactionFeeStroops,
    perUrlMax: config.spend.perUrlMax,
    perPayToMax: config.spend.perPayToMax,
    unboundPoolMax: config.spend.unboundPoolMax,
  });
  // Fix 3: sponsor balance guard. Derive the sponsor public key and poll its XLM
  // balance from Horizon. The first check is not awaited (startup is not blocked);
  // a failed check leaves settle allowed (fail open).
  const { Keypair } = await import("@stellar/stellar-sdk");
  const sponsorPub = Keypair.fromSecret(config.sponsorSecretKey).publicKey();
  const horizonUrl =
    config.network === "stellar:pubnet"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org";
  const balanceGuard = new BalanceGuard({
    fetchBalanceStroops: () => fetchXlmBalanceStroops(horizonUrl, sponsorPub),
    softFloorStroops: config.balance.softFloorStroops,
    hardFloorStroops: config.balance.hardFloorStroops,
    intervalMs: config.balance.intervalMs,
  });
  balanceGuard.start();

  const app = await buildServer(buildFacilitator(config), catalog, trust, policy, {}, balanceGuard);
  app.listen({ port: config.port, host: config.host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}

/** Fetch the account's native (XLM) balance from Horizon, in stroops. Throws on
 * any error (the guard catches and degrades to "unknown"). */
async function fetchXlmBalanceStroops(horizonUrl: string, publicKey: string): Promise<number> {
  const res = await fetch(`${horizonUrl}/accounts/${publicKey}`);
  if (!res.ok) throw new Error(`Horizon HTTP ${res.status}`);
  const body = (await res.json()) as { balances?: Array<{ asset_type?: string; balance?: string }> };
  const native = body.balances?.find((b) => b.asset_type === "native");
  if (!native?.balance) throw new Error("no native balance on sponsor account");
  // Horizon reports XLM with 7 decimals; convert to integer stroops.
  return Math.round(Number(native.balance) * 10_000_000);
}
