import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { buildFacilitator } from "./facilitator.js";
import { buildServer } from "./server.js";

// /health must make "did the instance stay awake, and does it still have a
// catalog" answerable from DATA rather than from a developer reporting an empty
// listing. Render destroys the container on spin-down, so a process-uptime reset
// is the ground truth for "it slept"; catalogSize is the consequence.

const testConfig = {
  port: 0, host: "127.0.0.1", network: "stellar:testnet" as const, rpcUrl: undefined,
  sponsorSecretKey: Keypair.random().secret(), maxTransactionFeeStroops: 500_000,
  catalogFile: undefined, verificationApiUrl: undefined,
  spend: { rateWindowMs: 60_000, ceilingStroops: 50_000_000, windowMs: 60_000, perUrlMax: 10, perPayToMax: 50, unboundPoolMax: 10 },
  balance: { softFloorStroops: 250_000_000, hardFloorStroops: 100_000_000, intervalMs: 60_000 },
  catalogOwnershipBootstrap: false,
};

describe("/health carries enough to detect a spin-down", () => {
  it("reports process uptime and catalog size", async () => {
    const catalog = new BazaarCatalog();
    const app = await buildServer(buildFacilitator(testConfig), catalog);
    const body = (await app.inject({ method: "GET", url: "/health" })).json();

    expect(body.status).toBe("ok");
    // A reset uptime is the only reliable signal that the container was
    // replaced — Render gives no other outside indication.
    expect(typeof body.uptimeSeconds, "uptimeSeconds must be present").toBe("number");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // The consequence a developer actually feels.
    expect(body.catalogSize, "catalogSize must be present").toBe(0);
    await app.close();
  });

  it("catalogSize tracks the catalog", async () => {
    const catalog = new BazaarCatalog();
    catalog.upsertFromPayment(
      { resourceUrl: "https://a.example/x", x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as never,
      { scheme: "exact", network: "stellar:testnet", asset: "CA", amount: "1", payTo: "GA", maxTimeoutSeconds: 60, extra: {} } as never,
    );
    const app = await buildServer(buildFacilitator(testConfig), catalog);
    const body = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(body.catalogSize).toBe(1);
    await app.close();
  });

  it("reports the deployed commit when the platform provides one", async () => {
    // Render injects RENDER_GIT_COMMIT. Without this, "what is actually
    // deployed?" can only be answered by fingerprinting behaviour — which is
    // how a stale build went unnoticed twice in one session, and only works
    // when a release happens to change something externally visible.
    process.env.RENDER_GIT_COMMIT = "abc1234def5678";
    const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog());
    const body = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(body.commit, "must be short enough to eyeball against git rev-parse").toBe("abc1234");
    await app.close();
    delete process.env.RENDER_GIT_COMMIT;
  });

  it("omits commit entirely when not deployed on a platform that sets it", async () => {
    delete process.env.RENDER_GIT_COMMIT;
    const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog());
    const body = (await app.inject({ method: "GET", url: "/health" })).json();
    expect("commit" in body, "absent rather than a misleading placeholder").toBe(false);
    await app.close();
  });

  it("stays exempt from the rate limit so the pinger cannot throttle real traffic", async () => {
    const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog(), undefined, undefined, {
      rateMaxPerMinute: 2,
    });
    for (let i = 0; i < 8; i++) {
      const r = await app.inject({ method: "GET", url: "/health" });
      expect(r.statusCode, `ping ${i} must not be throttled`).toBe(200);
    }
    await app.close();
  });
});
