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
  spend: { rateWindowMs: 60_000, ceilingStroops: 50_000_000, windowMs: 60_000, perUrlMax: 10, perPayToMax: 100, unboundPoolMax: 10 },
  balance: { softFloorStroops: 100_000_000, hardFloorStroops: 20_000_000, intervalMs: 60_000 },
  catalogOwnershipBootstrap: false,
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

// Every hardening test overrides the defaults, so mutations that shipped a
// 100 MB body limit or an effectively-disabled rate limit passed the full suite.
// These exercise buildServer with NO hardening options — the production path.
describe("Fix 2 — production defaults are actually applied", () => {
  it("applies the default 32 KiB body limit when no options are passed", async () => {
    const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog());
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/verify",
        headers: { "content-type": "application/json" },
        payload: { pad: "A".repeat(64 * 1024) }, // > 32 KiB default
      });
      expect(res.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });

  it("applies a bounded default per-IP rate limit when no options are passed", async () => {
    const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog());
    await app.ready();
    try {
      let limited = false;
      // The default must be a real bound; 200 requests from one IP must trip it.
      for (let i = 0; i < 200 && !limited; i++) {
        const res = await app.inject({ method: "GET", url: "/supported", remoteAddress: "9.9.9.9" });
        if (res.statusCode === 429) limited = true;
      }
      expect(limited, "default rate limit must bound a single IP").toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("Fix 2 — security headers", () => {
  // Prompt (Fix 2): "security headers present on all routes" — previously
  // asserted on /health only, which a per-route regression would not catch.
  it("sets helmet headers on every route, not just /health", async () => {
    const app = await server();
    const routes: Array<["GET" | "POST", string]> = [
      ["GET", "/health"],
      ["GET", "/supported"],
      ["GET", "/discovery/resources"],
      ["GET", "/discovery/search?query=x"],
      ["POST", "/verify"],
      ["POST", "/settle"],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject(
        method === "POST"
          ? { method, url, headers: { "content-type": "application/json" }, payload: {} }
          : { method, url },
      );
      expect(res.headers["x-content-type-options"], `${method} ${url}`).toBe("nosniff");
      expect(res.headers["x-frame-options"], `${method} ${url}`).toBeDefined();
    }
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

  // D4 (audit) — behind Render's proxy every request arrives from the proxy's IP,
  // so without trustProxy the per-IP limit collapses into ONE shared bucket:
  // one noisy client 429s everyone, and an IP-rotating attacker is never
  // partitioned. With trustProxy, X-Forwarded-For identifies the real client.
  it("partitions the rate limit by X-Forwarded-For, not the proxy IP (D4)", async () => {
    const app = await server({ rateMax: 2 });
    // Client A exhausts its own bucket through the proxy.
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: "GET",
        url: "/supported",
        remoteAddress: "10.0.0.1", // the proxy
        headers: { "x-forwarded-for": "203.0.113.1" },
      });
    }
    const aBlocked = await app.inject({
      method: "GET",
      url: "/supported",
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    expect(aBlocked.statusCode).toBe(429);

    // Client B, same proxy, different real client — must NOT be affected.
    const bOk = await app.inject({
      method: "GET",
      url: "/supported",
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(bOk.statusCode).toBe(200);
  });

  // A client must NOT be able to mint a fresh bucket by forging X-Forwarded-For.
  // Render's proxy appends the true client IP after any client-supplied value, so
  // trusting exactly ONE hop makes the real client authoritative and the forgery
  // inert. (trustProxy:true would take the attacker-controlled leftmost entry and
  // defeat the rate limit entirely — worse than no trustProxy at all.)
  it("ignores a forged X-Forwarded-For prefix and keys on the real client", async () => {
    const app = await server({ rateMax: 2 });
    const spoof = (n: number) => ({
      method: "GET" as const,
      url: "/supported",
      remoteAddress: "10.0.0.1", // Render's proxy
      // Attacker varies the forged prefix every request; the proxy appends the
      // real client (203.0.113.50) last.
      headers: { "x-forwarded-for": `6.6.6.${n}, 203.0.113.50` },
    });
    await app.inject(spoof(1));
    await app.inject(spoof(2));
    // Same real client despite a different forged prefix → must be rate-limited.
    const third = await app.inject(spoof(3));
    expect(third.statusCode).toBe(429);
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
