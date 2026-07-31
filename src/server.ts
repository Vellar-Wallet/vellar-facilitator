import Fastify from "fastify";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { loadConfig } from "./config.js";
import { buildFacilitator } from "./facilitator.js";

interface FacilitatorRequestBody {
  x402Version?: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export function buildServer(facilitator: ReturnType<typeof buildFacilitator>) {
  const app = Fastify({ logger: true });

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

  return app;
}

const isDirectRun = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isDirectRun) {
  const config = loadConfig();
  const app = buildServer(buildFacilitator(config));
  app.listen({ port: config.port, host: config.host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
