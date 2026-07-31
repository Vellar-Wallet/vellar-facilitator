import Fastify from "fastify";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { loadConfig } from "./config.js";
import { buildFacilitator } from "./facilitator.js";
import { BazaarCatalog } from "./catalog.js";
import { registerBazaar } from "./bazaar.js";

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
}

interface SearchQuery extends Omit<ListQuery, "offset"> {
  query?: string;
  cursor?: string;
}

export function buildServer(
  facilitator: ReturnType<typeof buildFacilitator>,
  catalog: BazaarCatalog,
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
    return catalog.list({
      ...(q.type !== undefined ? { type: q.type } : {}),
      ...(q.payTo !== undefined ? { payTo: q.payTo } : {}),
      ...(q.scheme !== undefined ? { scheme: q.scheme } : {}),
      ...(q.network !== undefined ? { network: q.network } : {}),
      ...(q.extensions !== undefined ? { extensions: q.extensions } : {}),
      ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
      ...(q.offset !== undefined ? { offset: Number(q.offset) } : {}),
    });
  });

  app.get<{ Querystring: SearchQuery }>("/discovery/search", async (request, reply) => {
    const q = request.query;
    if (typeof q.query !== "string" || q.query.length === 0) {
      return reply
        .status(400)
        .send({ error: "invalid_query", detail: "the `query` parameter is required" });
    }
    return catalog.search({
      query: q.query,
      ...(q.type !== undefined ? { type: q.type } : {}),
      ...(q.payTo !== undefined ? { payTo: q.payTo } : {}),
      ...(q.scheme !== undefined ? { scheme: q.scheme } : {}),
      ...(q.network !== undefined ? { network: q.network } : {}),
      ...(q.extensions !== undefined ? { extensions: q.extensions } : {}),
      ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    });
  });

  return app;
}

const isDirectRun = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isDirectRun) {
  const config = loadConfig();
  const catalog = new BazaarCatalog(config.catalogFile);
  const app = buildServer(buildFacilitator(config), catalog);
  app.listen({ port: config.port, host: config.host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
