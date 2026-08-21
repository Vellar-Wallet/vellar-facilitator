import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { loadConfig } from "./config.js";
import { buildFacilitator } from "./facilitator.js";
import { LibsqlCatalogStore } from "./store.js";
import { installRpcStatusCapture, withRpcStatusCapture } from "./rpcstatus.js";
import { withSkewRetry } from "./retry.js";
import { BazaarCatalog } from "./catalog.js";
import { registerBazaar } from "./bazaar.js";
import { verifyResourceOwnership } from "./ownership.js";
import {
  annotateTrust,
  filterVerifiedOnly,
  rerankVerifiedFirst,
  type TrustResolver,
} from "./trust.js";
import { createSpendPolicy, type SpendPolicy } from "./policy.js";
import { BalanceGuard } from "./balance.js";
import { registerSettlement, type BondEscrowOptions } from "./bond.js";

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
  /** CAIP-2 network id, echoed in conformant error bodies (G-13, spec §5.3
   *  marks it Required). The production call site passes config.network; the
   *  default keeps the many test call sites terse and is asserted to match. */
  network: string = "stellar:testnet",
  /** Set only when config.bondEscrowContractId is configured — undefined means
   *  bonding is entirely inactive and /settle behaves exactly as it did before this
   *  existed. See the bond-registration block in /settle for the full behavior. */
  bondEscrow?: BondEscrowOptions,
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
    // Boot-time re-proof probes still in flight. ALWAYS present, zero included:
    // after a restart a latched entry serves proven-unconfirmed until its probe
    // resolves, and a reader who sees the gray badge needs to distinguish "a
    // probe is running, check back shortly" (n > 0) from "nothing is coming,
    // this is the settled state" (0) without reading source.
    reverifyPending: catalog.reverifyPending,
    // Non-zero means those sellers advertise an address the facilitator cannot
    // fetch, so their entries are permanently unverified — distinct from "not
    // verified yet", which every entry reads as while VERIFICATION_API_URL is
    // unset. Omitted at zero so a healthy catalog stays quiet.
    ...(catalog.unverifiableCount > 0 ? { unverifiableEntries: catalog.unverifiableCount } : {}),
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
      return reply.status(400).send(
        verifyError("invalid_body", {
          error: "invalid_body",
          detail: "paymentPayload and paymentRequirements are required",
        }),
      );
    }
    // Fix 2: shed obviously-malformed payloads at the route, before spending an
    // RPC simulation. /verify is the free amplification path (an invalid payload
    // still costs one simulation upstream), so reject anything whose transaction
    // isn't parseable XDR without a network round-trip.
    if (!isParseableTransactionXdr(paymentPayload)) {
      return reply.status(400).send(
        verifyError("invalid_payload", {
          error: "invalid_payload",
          detail: "payload.transaction is not a parseable transaction envelope",
        }),
      );
    }
    return withSkewRetry(
      () => facilitator.verify(paymentPayload, paymentRequirements),
      (r) => (r as { invalidReason?: string }).invalidReason,
      (m) => request.log.warn(m),
    );
  });

  app.post<{ Body: FacilitatorRequestBody }>("/settle", async (request, reply) => {
    const { paymentPayload, paymentRequirements } = request.body ?? {};
    if (!paymentPayload || !paymentRequirements) {
      return reply.status(400).send(
        settleError(network, "invalid_body", {
          error: "invalid_body",
          detail: "paymentPayload and paymentRequirements are required",
        }),
      );
    }
    // Re-audit: shed unsubmittable payloads BEFORE reserving spend budget,
    // symmetric with /verify. Junk costs the sponsor no XLM, so it must not be
    // able to consume the global ceiling and refuse real settlement.
    if (!isParseableTransactionXdr(paymentPayload)) {
      return reply.status(400).send(
        settleError(network, "invalid_payload", {
          error: "invalid_payload",
          detail: "payload.transaction is not a parseable transaction envelope",
        }),
      );
    }
    // Fix 3: refuse settle when the sponsor is below the hard balance floor —
    // fees would fail on-chain anyway. Discovery is unaffected. A failed/absent
    // balance check leaves settle allowed (fail open).
    if (balanceGuard && !balanceGuard.settleAllowed()) {
      request.log.error({ balanceStatus: balanceGuard.status() }, "[balance] settle refused: sponsor below hard floor");
      return reply.status(503).send(
        settleError(network, "sponsor_balance_low", {
          error: "settlement_refused",
          reason: "sponsor_balance_low",
        }),
      );
    }
    // Canonical resource URL — hoisted above the spend-policy block so bond
    // registration (below) can reuse the same derivation rather than recomputing
    // it independently, which is exactly how a resource-key canonicalization bug
    // gets a second, silently-drifting copy. Cheap and pure (URL parsing only),
    // so computing it unconditionally costs nothing when neither consumer needs it.
    const rawResourceUrl =
      (paymentPayload as unknown as { resource?: { url?: string } }).resource?.url ?? "";
    const resourceUrl = BazaarCatalog.canonicalResourceKey(rawResourceUrl);
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
        return reply.status(503).send(
          settleError(network, verdict.reason ?? "spend_policy", {
            error: "settlement_refused",
            reason: verdict.reason,
          }),
        );
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
    let rpcStatus;
    try {
      // The capture slot must wrap the settle call itself: the RPC response we
      // want is produced deep inside @x402/stellar, which discards it before
      // returning. See src/rpcstatus.ts.
      const captured = await withSkewRetry(
        () => withRpcStatusCapture(() => facilitator.settle(paymentPayload, paymentRequirements)),
        (c) => (c.value as { errorReason?: string }).errorReason,
        (m) => request.log.warn(m),
      );
      result = captured.value;
      rpcStatus = captured.rpcStatus;
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
    // Surface what the RPC actually said. Without this a caller sees
    // `settle_exact_stellar_transaction_submission_failed` and cannot tell
    // TRY_AGAIN_LATER (retry — nothing reached a ledger) from ERROR/txBadSeq
    // (do not retry, the payload is stale). Additive: the x402-required fields
    // are untouched.
    if (result.success === false && rpcStatus) {
      request.log.warn({ rpcStatus }, "[settle] submission refused by the RPC");
      return { ...result, rpcStatus };
    }
    // Bond registration — synchronous, awaited, BEFORE /settle reports success.
    // docs/proposal-provider-bond.md, Section 6: this is the one call that gives a
    // payer standing to dispute a bond, so a settlement that succeeds without it
    // is a settlement no buyer can ever get recourse for — exactly the gap this
    // whole system exists to close. Only reached when bondEscrow is configured
    // (both-or-neither with the admin key, enforced in config.ts) and the
    // settlement itself actually succeeded — nothing to register standing
    // against for a failed settle.
    if (bondEscrow && result.success === true) {
      try {
        const seller = BazaarCatalog.canonicalPayTo(paymentRequirements.payTo);
        // Both of these SHOULD be impossible on a successful settlement — a real
        // payment cannot have settled without a real payer and a real payTo — but
        // "should be impossible" is exactly the case this system's own posture
        // (name it, don't hide it) says to handle explicitly rather than assume.
        if (!seller || !result.payer) {
          request.log.error(
            { transaction: result.transaction, payer: result.payer, payTo: paymentRequirements.payTo },
            "[bond] settlement succeeded but is missing a payer or seller address — cannot register",
          );
          return reply.status(503).send(
            settleError(network, "bond_registration_unavailable", {
              error: "bond_registration_failed",
              reason: "missing_payer_or_seller",
              // The real settlement outcome, not hidden behind the 503 — money
              // moved even though this response reports failure.
              transaction: result.transaction,
            }),
          );
        }
        const registration = await registerSettlement(bondEscrow, {
          // A Stellar transaction hash is already exactly 32 bytes and already
          // unique per settlement — a ready-made payment_id, per bond.ts's own
          // doc-comment on the field.
          paymentId: result.transaction,
          // Not run through canonicalPayTo, unlike seller below: SDK-derived from parsed
          // transaction XDR, not a merchant-typed string, so it shouldn't carry the
          // whitespace/casing exposure that canonicalization exists for. If that
          // assumption ever breaks, bond.ts's own address validation throws -> 503, a
          // loud failure, not a silent wrong-value bug.
          payer: result.payer,
          seller,
          resourceKey: resourceUrl,
          amount: result.amount ?? paymentRequirements.amount,
        });

        if (registration.outcome === "infrastructure_error") {
          request.log.error(
            { transaction: result.transaction, detail: registration.detail },
            "[bond] registration failed (infrastructure) — refusing to report settle success without it",
          );
          return reply.status(503).send(
            settleError(network, "bond_registration_unavailable", {
              error: "bond_registration_failed",
              reason: registration.detail,
              transaction: result.transaction,
            }),
          );
        }
        if (registration.outcome === "rejected") {
          if (registration.contractErrorCode === 3 /* SettlementAlreadyRegistered */) {
            // Unexpected, but not fatal: dispute standing already exists for this
            // paymentId (a prior registration attempt must have succeeded even
            // though this request didn't observe it — e.g. a retried settle, or a
            // submission that landed after we'd already stopped waiting on a prior
            // attempt). The outcome this call cares about — standing exists — is
            // already true. Logged loudly because it is still worth an operator's
            // attention, not because the settle needs to fail over it.
            request.log.warn(
              { transaction: result.transaction },
              "[bond] SettlementAlreadyRegistered — standing already exists for this paymentId, letting settle succeed",
            );
          } else {
            request.log.error(
              { transaction: result.transaction, detail: registration.detail, code: registration.contractErrorCode },
              "[bond] registration rejected by the contract — unexpected, refusing to report settle success",
            );
            return reply.status(500).send(
              settleError(network, "bond_registration_rejected", {
                error: "bond_registration_failed",
                reason: registration.detail,
                contractErrorCode: registration.contractErrorCode,
                transaction: result.transaction,
              }),
            );
          }
        }
      } catch (err) {
        // Anything thrown here (including bond.ts's own caller-bug validation,
        // which should be unreachable given the guards above, but "should be
        // unreachable" is not a substitute for handling it) is treated the same
        // as an infrastructure failure: fail loud, never let it crash the
        // request uncaught, never silently report success without registration.
        request.log.error(
          { transaction: result.transaction, err: err instanceof Error ? err.message : err },
          "[bond] registration threw — refusing to report settle success without it",
        );
        return reply.status(503).send(
          settleError(network, "bond_registration_unavailable", {
            error: "bond_registration_failed",
            reason: err instanceof Error ? err.message : String(err),
            transaction: result.transaction,
          }),
        );
      }
    }
    return result;
  });

  /**
   * verified_only asks a question only a deployment with a verdict source can
   * answer. Without one, every verdict is the constant "unknown", so the filter
   * can never match — and the old behaviour, a silent `items: []`, was a
   * correct-LOOKING answer to a question the system could not answer. A caller
   * read it as "nothing here is verified" when the truth was "this deployment
   * cannot tell". Refused loudly instead, naming the field that does work.
   *
   * Also covers the no-trust-layer case, which was quietly WORSE: with no
   * resolver at all, verified_only was ignored entirely and the caller who
   * asked for verified-only entries got every entry, unfiltered.
   */
  const verifiedOnlyRefusal = () => ({
    error: "verified_only_unavailable",
    reason: "no_verdict_source_configured",
    detail:
      "This deployment has no verification API configured, so every verification " +
      "verdict is \"unknown\" and a verified_only filter can never match anything. " +
      "An empty list here would describe the deployment, not the resources. " +
      "For a per-resource trust signal that does work, read trust.ownerVerified.",
  });
  const verifiedOnlyUnanswerable = () => !trust || !trust.hasVerdictSource;

  app.get<{ Querystring: ListQuery }>("/discovery/resources", async (request, reply) => {
    const q = request.query;
    if (q.verified_only === "true" && verifiedOnlyUnanswerable()) {
      return reply.status(400).send(verifiedOnlyRefusal());
    }
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
    let items = await annotateTrust(
      response.items,
      trust,
      (url) => catalog.isVerifiedOwner(url),
      (url) => catalog.isEverVerified(url),
    );
    if (q.verified_only === "true") {
      const before = items.length;
      items = filterVerifiedOnly(items);
      // `total` must describe what the caller can actually page through. The
      // catalog computes it before the trust layer exists, so a verified_only
      // filter applied afterwards used to leave `items: []` sitting next to
      // `total: 1` — a response that contradicts itself, which invites a client
      // to distrust every other number in it. Reduced by what this page dropped.
      const dropped = before - items.length;
      return {
        ...response,
        items,
        pagination: { ...response.pagination, total: Math.max(0, response.pagination.total - dropped) },
      };
    }
    return { ...response, items };
  });

  app.get<{ Querystring: SearchQuery }>("/discovery/search", async (request, reply) => {
    const q = request.query;
    if (typeof q.query !== "string" || q.query.length === 0) {
      return reply
        .status(400)
        .send({ error: "invalid_query", detail: "the `query` parameter is required" });
    }
    if (q.verified_only === "true" && verifiedOnlyUnanswerable()) {
      return reply.status(400).send(verifiedOnlyRefusal());
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
      (url) => catalog.isEverVerified(url),
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
/**
 * G-13 — x402 conformance for facilitator error responses.
 *
 * `x402-specification-v2.md` §5.3 marks `success`, `transaction` and `network`
 * REQUIRED on a SettleResponse (`transaction` is the empty string when
 * settlement failed), and §5.4 marks `isValid` REQUIRED on a VerifyResponse.
 * Our refusals returned `{error, reason}` and omitted all of them.
 *
 * That is not an ergonomics problem, it is non-conformance, and it had a
 * concrete cost: `HTTPFacilitatorClient` requires `"success" in data` before it
 * will build a structured `SettleError` (`@x402/core/http`, index.js:1120).
 * Without the field it throws a GENERIC error instead, whose message happens to
 * carry the body as text — which is why every facilitator refusal reached the
 * seller as an unexplained empty 402 until the seller was patched to dig the
 * reason out of an error string. Conformance fixes that at the source, for every
 * client, not just the one seller we control.
 *
 * The legacy `error`/`reason` fields are KEPT alongside. Extra fields are
 * permitted, and removing them would break anything already reading them —
 * including our own seller. This change is strictly additive.
 */
function settleError(network: string, errorReason: string, extra: Record<string, unknown> = {}) {
  return { success: false, transaction: "", network, errorReason, ...extra };
}
function verifyError(invalidReason: string, extra: Record<string, unknown> = {}) {
  return { isValid: false, invalidReason, ...extra };
}

export function policyBucketKey(payTo: unknown): string {
  // Delegates to the SAME derivation the catalog uses. It used to reimplement
  // the rule, which is how the two drifted: identical intent, two copies, no
  // test that they agreed. See BazaarCatalog.canonicalPayTo.
  return BazaarCatalog.canonicalPayTo(payTo) ?? "<no-payto>";
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

// Install before anything can settle. Announces itself loudly — see rpcstatus.ts.
installRpcStatusCapture();

const isDirectRun = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isDirectRun) {
  const config = loadConfig();
  // Durable catalog. Unset CATALOG_DB_URL means in-memory only — the catalog
  // works, and nothing survives a restart, which is exactly the state this
  // milestone exists to end. Say so at boot rather than letting an operator
  // discover it from an empty /discovery/resources after a deploy.
  const store = config.catalogDbUrl
    ? new LibsqlCatalogStore(config.catalogDbUrl, config.catalogDbAuthToken)
    : undefined;
  if (!store) {
    console.warn(
      "[catalog] CATALOG_DB_URL is not set — running IN-MEMORY. Listings and ownership bindings will be " +
        "lost on every restart and every idle spin-down. Set CATALOG_DB_URL to a libSQL/Turso database.",
    );
  }
  const catalog = await BazaarCatalog.create(store);
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

  // Bond registration is opt-in by contract ID, same convention as uptoContractId
  // above — unset means bonding is entirely inactive, /settle unchanged. The
  // both-or-neither invariant already enforced in config.ts guarantees the admin
  // key is present whenever the contract ID is.
  const bondEscrow: BondEscrowOptions | undefined = config.bondEscrowContractId
    ? {
        contractId: config.bondEscrowContractId,
        adminSecretKey: config.bondEscrowAdminSecretKey!,
        network: config.network,
        rpcUrl: config.rpcUrl,
        maxTransactionFeeStroops: config.maxTransactionFeeStroops,
      }
    : undefined;
  if (!bondEscrow) {
    console.warn(
      "[bond] BOND_ESCROW_CONTRACT_ID is not set — settlements will NOT be registered with the bond " +
        "contract. No payer gets dispute standing for any settlement. This is expected until the bond " +
        "system is deployed and configured; see docs/bond-escrow-deployment.md.",
    );
  }

  const app = await buildServer(
    buildFacilitator(config),
    catalog,
    trust,
    policy,
    {},
    balanceGuard,
    config.network,
    bondEscrow,
  );
  // P3 — sponsor funding asserted AT BOOT, with the fix in the error. The
  // polling balance guard exists for drain DURING operation; this exists for
  // the setup mistake, which otherwise surfaces mid-payment as an
  // "Unexpected settlement error: Account not found" that reads like a code
  // defect (it cost this repo a diagnosis round on 2026-08-12). Pattern from
  // Turnpike's boot preflight, Apache-2.0, credited. Fail fast, fail
  // explaining itself.
  try {
    await assertSponsorFunded(horizonUrl, sponsorPub);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  app.listen({ port: config.port, host: config.host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
  // Boot-time re-proof, UNAWAITED and after listen() on purpose: the badge is
  // per-process while the latch is durable, so every restart serves
  // proven-unconfirmed for entries that were verified — until this pass
  // re-fetches each one's live 402 through the same SSRF-guarded prober the
  // settle path uses. The prober's cold-start retry ladder can run minutes
  // against a sleeping seller, and a reviewer's first request must never wait
  // on it. Progress is observable as `reverifyPending` on /health. See
  // reverifyLatchedAtBoot for why this cannot GRANT verification, only
  // re-display it.
  void catalog.reverifyLatchedAtBoot(verifyResourceOwnership);
}

/** Boot-time sponsor preflight. Exported for tests; never called by buildServer
 *  (hundreds of test servers must not touch Horizon). */
export async function assertSponsorFunded(horizonUrl: string, publicKey: string): Promise<void> {
  let res: Response;
  try {
    // Bounded: errors were always caught and fail-open, but a black-holing
    // Horizon HANGS rather than errors, and an unbounded fetch here stalls
    // boot indefinitely. 5s is generous for one account GET; on abort the
    // TimeoutError lands in the same catch and the same fail-open applies.
    res = await fetch(`${horizonUrl}/accounts/${publicKey}`, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    // Horizon unreachable is NOT a config error — warn and let the polling
    // guard take over, same fail-open stance it has always had.
    console.warn(`[boot] sponsor preflight skipped — Horizon unreachable: ${String(err)}`);
    return;
  }
  if (res.status === 404) {
    throw new Error(
      `Sponsor account ${publicKey} does not exist on this network, so it cannot sponsor settlement fees.\n` +
        `  Fund it:  curl "https://friendbot.stellar.org/?addr=${publicKey}"\n` +
        `  (testnet only — on pubnet, fund it from a real account)`,
    );
  }
  if (!res.ok) {
    console.warn(`[boot] sponsor preflight inconclusive (Horizon HTTP ${res.status}) — polling guard will retry`);
    return;
  }
  const body = (await res.json()) as { balances?: Array<{ asset_type?: string; balance?: string }> };
  const native = body.balances?.find((b) => b.asset_type === "native");
  if (!native || Number(native.balance) <= 0) {
    throw new Error(
      `Sponsor account ${publicKey} holds no XLM, so it cannot pay settlement fees.\n` +
        `  Fund it:  curl "https://friendbot.stellar.org/?addr=${publicKey}"`,
    );
  }
  // The happy path SAYS SO. A check silent on success reads identically to a
  // check that did not run — the operator's exact observation on the first
  // production boot after this control merged (compounded that day by the
  // running build predating the merge, so silence truly meant absent). One
  // line makes silent-pass, loud-fail, and not-deployed three different
  // states. Same lesson as every silent skip in the register.
  console.warn(`[boot] sponsor preflight ok — ${publicKey.slice(0, 8)}… holds ${native.balance} XLM`);
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
