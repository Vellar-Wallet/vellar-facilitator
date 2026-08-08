import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { buildFacilitator } from "./facilitator.js";
import { buildServer } from "./server.js";

// Fix 2 — baseline hardening: per-IP rate limiting (/verify limited at least as
// tightly as /settle, /health exempt), security headers (helmet), per-route body
// limits, and cheap structural pre-validation on /verify that sheds garbage XDR
// before an RPC simulation is spent.

const testConfig = {
  port: 0,
  host: "127.0.0.1",
  network: "stellar:testnet" as const,
  rpcUrl: undefined,
  sponsorSecretKey: Keypair.random().secret(),
  maxTransactionFeeStroops: 2_000_000,
  catalogFile: undefined,
  verificationApiUrl: undefined,
  spend: { rateMax: 30, rateWindowMs: 60_000, ceilingStroops: 50_000_000, windowMs: 60_000 },
};

function requirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND",
    amount: "1000000",
    payTo: "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A",
    maxTimeoutSeconds: 60,
    extra: {},
  } as PaymentRequirements;
}

let apps: Array<{ close: () => Promise<void> }> = [];
async function server(overrides?: { rateMax?: number; bodyLimit?: number }) {
  const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog(), undefined, undefined, {
    rateMaxPerMinute: overrides?.rateMax ?? 1000,
    bodyLimitBytes: overrides?.bodyLimit ?? 32 * 1024,
  });
  await app.ready();
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

describe("Fix 2 — security headers", () => {
  it("sets helmet headers on responses", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/health" });
    // helmet sets these by default.
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
  });
});

describe("Fix 2 — rate limiting", () => {
  it("returns 429 once the per-IP limit is exceeded", async () => {
    const app = await server({ rateMax: 3 });
    let sawLimited = false;
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({ method: "GET", url: "/supported", remoteAddress: "9.9.9.9" });
      if (res.statusCode === 429) sawLimited = true;
    }
    expect(sawLimited).toBe(true);
  });

  it("never rate-limits /health (Render health check must not trip)", async () => {
    const app = await server({ rateMax: 1 });
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe("Fix 2 — body limit", () => {
  it("returns 413 for an oversized /verify body", async () => {
    const app = await server({ bodyLimit: 1024 });
    const big = "A".repeat(4096);
    const res = await app.inject({
      method: "POST",
      url: "/verify",
      headers: { "content-type": "application/json" },
      payload: { paymentPayload: { payload: { transaction: big } }, paymentRequirements: requirements() },
    });
    expect(res.statusCode).toBe(413);
  });
});

describe("Fix 2 — /verify structural pre-validation", () => {
  it("rejects a non-base64 / non-XDR transaction with 400 before any RPC work", async () => {
    const app = await server();
    const res = await app.inject({
      method: "POST",
      url: "/verify",
      headers: { "content-type": "application/json" },
      payload: {
        paymentPayload: {
          x402Version: 2,
          scheme: "exact",
          network: "stellar:testnet",
          payload: { transaction: "!!! not base64 XDR !!!" },
        },
        paymentRequirements: requirements(),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_payload");
  });
});
