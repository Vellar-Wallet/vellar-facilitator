import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFacilitator } from "./facilitator.js";
import { buildServer } from "./server.js";

const testConfig = {
  port: 0,
  host: "127.0.0.1",
  network: "stellar:testnet" as const,
  rpcUrl: undefined,
  sponsorSecretKey: Keypair.random().secret(),
  maxTransactionFeeStroops: 2_000_000,
};

describe("facilitator server", () => {
  const app = buildServer(buildFacilitator(testConfig));

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health responds ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "vellar-facilitator" });
  });

  it("GET /supported lists the stellar exact scheme with sponsored fees", async () => {
    const res = await app.inject({ method: "GET", url: "/supported" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const kind = body.kinds.find(
      (k: { scheme: string; network: string }) =>
        k.scheme === "exact" && k.network === "stellar:testnet",
    );
    expect(kind).toBeDefined();
    expect(kind.extra?.areFeesSponsored).toBe(true);
    expect(body.signers["stellar:*"]).toContain(
      Keypair.fromSecret(testConfig.sponsorSecretKey).publicKey(),
    );
  });

  it("POST /verify without a body returns 400, not a crash", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/verify",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("POST /settle without a body returns 400, not a crash", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/settle",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("POST /verify with a malformed payload returns an invalid verdict, not a 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/verify",
      headers: { "content-type": "application/json" },
      payload: {
        x402Version: 2,
        paymentPayload: {
          x402Version: 2,
          scheme: "exact",
          network: "stellar:testnet",
          payload: { transaction: "not-a-real-transaction" },
        },
        paymentRequirements: {
          scheme: "exact",
          network: "stellar:testnet",
          maxAmountRequired: "1000000",
          asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          payTo: Keypair.random().publicKey(),
          resource: "https://example.com/paid",
          description: "test",
          mimeType: "application/json",
          maxTimeoutSeconds: 60,
        },
      },
    });
    // The scheme should reject it as an invalid payment, not crash the server.
    expect(res.statusCode).toBeLessThan(500);
    if (res.statusCode === 200) {
      expect(res.json().isValid).toBe(false);
    }
  });
});
