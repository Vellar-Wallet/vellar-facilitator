import Fastify from "fastify";
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

export function buildServer(
  facilitator: ReturnType<typeof buildFacilitator>,
  catalog: BazaarCatalog,
  trust?: TrustResolver,
) {
  const app = Fastify({ logger: true });
  registerBazaar(facilitator, catalog);

  app.get("/health", async () => ({ status: "ok", service: "vellar-facilitator" }));

  app.get("/supported", async () => facilitator.getSupported());

  app.post<{ Body: FacilitatorRequestBody }>("/verify", async (request, reply) => {
    const { paymentPayload, paymentRequirements } = request.body ?? {};
    if (!paymentPayload || !paymentRequirements) {
      return reply
        .status(400)
        .send({ error: "invalid_body", detail: "paymentPayload and paymentRequirements are required" });
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
    return facilitator.settle(paymentPayload, paymentRequirements);
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

const isDirectRun = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isDirectRun) {
  const config = loadConfig();
  const catalog = new BazaarCatalog(config.catalogFile);
  const { createTrustResolver } = await import("./trust.js");
  const trust = createTrustResolver({
    verificationApiUrl: config.verificationApiUrl,
    rpcUrl: config.rpcUrl ?? "https://soroban-testnet.stellar.org",
  });
  const app = buildServer(buildFacilitator(config), catalog, trust);
  app.listen({ port: config.port, host: config.host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
