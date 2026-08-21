import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it  } from "vitest";
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
  catalogDbUrl: undefined,
  catalogDbAuthToken: undefined, verificationApiUrl: undefined,
  spend: { rateWindowMs: 60_000, ceilingStroops: 50_000_000, windowMs: 60_000, perUrlMax: 10, perPayToMax: 50, unboundPoolMax: 10 },
  balance: { softFloorStroops: 250_000_000, hardFloorStroops: 100_000_000, intervalMs: 60_000 },
};

describe("/health carries enough to detect a spin-down", () => {
  it("reports process uptime and catalog size", async () => {
    const catalog = await BazaarCatalog.create();
    const app = await buildServer(buildFacilitator(testConfig), catalog);
    const body = (await app.inject({ method: "GET", url: "/health" })).json();

    expect(body.status).toBe("ok");
    // A reset uptime is the only reliable signal that the container was
    // replaced — Render gives no other outside indication.
    expect(typeof body.uptimeSeconds, "uptimeSeconds must be present").toBe("number");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // The consequence a developer actually feels.
    expect(body.catalogSize, "catalogSize must be present").toBe(0);
    // ALWAYS present, zero included: after a restart a latched entry serves
    // proven-unconfirmed until its boot re-proof resolves, and a reader must
    // be able to distinguish "probe in flight, check back" (n > 0) from "this
    // is the settled state" (0) without reading source.
    expect(body.reverifyPending, "reverifyPending must be present even at zero").toBe(0);
    await app.close();
  });

  it("catalogSize tracks the catalog", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(
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
    const app = await buildServer(buildFacilitator(testConfig), await BazaarCatalog.create());
    const body = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(body.commit, "must be short enough to eyeball against git rev-parse").toBe("abc1234");
    await app.close();
    delete process.env.RENDER_GIT_COMMIT;
  });

  it("omits commit entirely when not deployed on a platform that sets it", async () => {
    delete process.env.RENDER_GIT_COMMIT;
    const app = await buildServer(buildFacilitator(testConfig), await BazaarCatalog.create());
    const body = (await app.inject({ method: "GET", url: "/health" })).json();
    expect("commit" in body, "absent rather than a misleading placeholder").toBe(false);
    await app.close();
  });

  it("stays exempt from the rate limit so the pinger cannot throttle real traffic", async () => {
    const app = await buildServer(buildFacilitator(testConfig), await BazaarCatalog.create(), undefined, undefined, {
      rateMaxPerMinute: 2,
    });
    for (let i = 0; i < 8; i++) {
      const r = await app.inject({ method: "GET", url: "/health" });
      expect(r.statusCode, `ping ${i} must not be throttled`).toBe(200);
    }
    await app.close();
  });
});

describe("/health surfaces structurally unverifiable entries", () => {
  it("reports the count when a seller advertises an unfetchable address", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(
      { resourceUrl: "http://localhost:10000/quote", x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as never,
      { scheme: "exact", network: "stellar:testnet", asset: "CA", amount: "1", payTo: "GA", maxTimeoutSeconds: 60, extra: {} } as never,
    );
    const app = await buildServer(buildFacilitator(testConfig), catalog);
    const body = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(body.unverifiableEntries, "the seller.mjs failure must be visible").toBe(1);
    await app.close();
  });

  it("stays quiet when every entry is fetchable", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(
      { resourceUrl: "https://seller.example/quote", x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as never,
      { scheme: "exact", network: "stellar:testnet", asset: "CA", amount: "1", payTo: "GA", maxTimeoutSeconds: 60, extra: {} } as never,
    );
    const app = await buildServer(buildFacilitator(testConfig), catalog);
    const body = (await app.inject({ method: "GET", url: "/health" })).json();
    expect("unverifiableEntries" in body, "a healthy catalog must not add noise").toBe(false);
    await app.close();
  });
});


// P3 — boot-time sponsor preflight (unit; start() itself never runs in tests).
import { assertSponsorFunded } from "./server.js";
import { vi as vi2 } from "vitest";

describe("assertSponsorFunded — fail fast, fail explaining itself", () => {
  const G = "GBUCR6H22CZC5OYHBJIEUS2JFZBOB63AHEGTCV6UEPMD2TMLKG2ZMIW4";
  afterEach(() => vi2.unstubAllGlobals());

  it("a 404 dies naming the friendbot command", async () => {
    vi2.stubGlobal("fetch", async () => ({ status: 404, ok: false }) as Response);
    await expect(assertSponsorFunded("https://h.example", G)).rejects.toThrow(/friendbot.*addr=G/);
  });

  it("zero XLM dies naming the friendbot command", async () => {
    vi2.stubGlobal("fetch", async () => ({
      status: 200, ok: true,
      json: async () => ({ balances: [{ asset_type: "native", balance: "0.0000000" }] }),
    }) as unknown as Response);
    await expect(assertSponsorFunded("https://h.example", G)).rejects.toThrow(/holds no XLM/);
  });

  it("an unreachable Horizon does NOT block boot — the polling guard owns that", async () => {
    vi2.stubGlobal("fetch", async () => { throw new Error("ECONNREFUSED"); });
    await expect(assertSponsorFunded("https://h.example", G)).resolves.toBeUndefined();
  });

  it("a funded sponsor passes silently", async () => {
    vi2.stubGlobal("fetch", async () => ({
      status: 200, ok: true,
      json: async () => ({ balances: [{ asset_type: "native", balance: "9999.5" }] }),
    }) as unknown as Response);
    await expect(assertSponsorFunded("https://h.example", G)).resolves.toBeUndefined();
  });

  it("the fetch is bounded by an abort signal — a black-holing Horizon cannot stall boot", async () => {
    // Errors were always caught and fail-open, but a hang is not an error until
    // something bounds it. Assert the bound exists rather than waiting out a
    // real 5s timeout.
    let seenSignal: unknown;
    vi2.stubGlobal("fetch", async (_url: unknown, init?: { signal?: unknown }) => {
      seenSignal = init?.signal;
      return {
        status: 200, ok: true,
        json: async () => ({ balances: [{ asset_type: "native", balance: "1.0" }] }),
      } as unknown as Response;
    });
    await assertSponsorFunded("https://h.example", G);
    expect(seenSignal, "preflight fetch must carry an AbortSignal").toBeInstanceOf(AbortSignal);
  });

  it("an aborted (timed-out) fetch fails open like any other unreachable Horizon", async () => {
    vi2.stubGlobal("fetch", async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(assertSponsorFunded("https://h.example", G)).resolves.toBeUndefined();
  });
});
