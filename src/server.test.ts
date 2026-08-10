import { Keypair } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { withBazaar, type DiscoveredResource } from "@x402/extensions/bazaar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { buildFacilitator } from "./facilitator.js";
import { buildServer } from "./server.js";
import { createSpendPolicy } from "./policy.js";
import { BalanceGuard } from "./balance.js";

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

// A structurally VALID transaction envelope. /settle now shreds unparseable XDR
// at the route (so junk can't consume the spend ceiling), so tests that need to
// reach the balance guard / spend policy must carry real XDR.
const VALID_TX_XDR =
  "AAAAAgAAAAARUqIOOVQYwBn0s32MhGQwyoTHPy7SzjfXdweAw6b/4gAAAGQAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAABqdyAuAAAAAAAAAAEAAAAAAAAAAQAAAADrmp8rY1JU7CL78HNaROud45MqVmrrbxOCVuWSEz0eRwAAAAAAAAAAAJiWgAAAAAAAAAAA";

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

function discovered(over: Partial<DiscoveredResource> = {}): DiscoveredResource {
  return {
    resourceUrl: "https://api.example.com/weather",
    description: "Hourly weather data",
    serviceName: "WeatherSvc",
    tags: ["weather"],
    x402Version: 2,
    discoveryInfo: { input: { type: "http", method: "GET" } },
    ...over,
  } as DiscoveredResource;
}

describe("facilitator server", () => {
  const catalog = new BazaarCatalog();
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer(buildFacilitator(testConfig), catalog);
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

  it("GET /supported lists the stellar exact scheme, sponsored fees, and the bazaar extension", async () => {
    const res = await app.inject({ method: "GET", url: "/supported" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const kind = body.kinds.find(
      (k: { scheme: string; network: string }) =>
        k.scheme === "exact" && k.network === "stellar:testnet",
    );
    expect(kind).toBeDefined();
    expect(kind.extra?.areFeesSponsored).toBe(true);
    expect(body.extensions).toContain("bazaar");
    expect(body.signers["stellar:*"]).toContain(
      Keypair.fromSecret(testConfig.sponsorSecretKey).publicKey(),
    );
  });

  it("POST /verify and /settle without a body return 400, not a crash", async () => {
    for (const url of ["/verify", "/settle"]) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_body");
    }
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
        paymentRequirements: requirements(),
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    if (res.statusCode === 200) {
      expect(res.json().isValid).toBe(false);
    }
  });

  it("GET /discovery/search without `query` returns 400", async () => {
    const res = await app.inject({ method: "GET", url: "/discovery/search" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_query");
  });
});

describe("Fix 1 — spend policy on /settle", () => {
  function settleBody() {
    return {
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        scheme: "exact",
        network: "stellar:testnet",
        payload: { transaction: VALID_TX_XDR },
      },
      paymentRequirements: requirements(),
    };
  }

  // Re-audit: a garbage payload costs the sponsor NOTHING on-chain, but the
  // spend estimate was reserved before settlement and never refunded — so cheap
  // junk requests could exhaust the global ceiling and refuse all real
  // settlement for a full window (a settlement-outage DoS).
  it("does not let unsubmittable payloads exhaust the spend ceiling", async () => {
    const policy = createSpendPolicy({
      network: "stellar:pubnet",
      perPayToMax: 1000,
      rateWindowMs: 60_000,
      spendCeilingStroops: 2_000_000, // room for ~4 settles at the estimate
      spendWindowMs: 60_000,
      perSettleEstimateStroops: 500_000,
    });
    const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog(), undefined, policy);
    await app.ready();
    try {
      const junk = () => ({
        x402Version: 2,
        paymentPayload: {
          x402Version: 2,
          scheme: "exact",
          network: "stellar:testnet",
          payload: { transaction: "GARBAGE-NOT-XDR" },
        },
        paymentRequirements: requirements(),
      });
      // Fire far more junk than the ceiling would nominally allow.
      for (let i = 0; i < 12; i++) {
        await app.inject({ method: "POST", url: "/settle", payload: junk() });
      }
      // A real settle attempt must NOT be refused for spend_ceiling — the junk
      // spent no sponsor XLM, so it must not have consumed the budget.
      const real = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      if (real.statusCode === 503) {
        expect(real.json().reason).not.toBe("spend_ceiling");
      }
    } finally {
      await app.close();
    }
  });

  // Re-audit: payTo is the policy's bucket key but was never type- or
  // length-validated. A JSON object, or a huge string up to the 32 KB body
  // limit, minted a fresh bucket per request — defeating the per-payTo limit
  // and letting the policy Map grow with attacker-controlled keys.
  it("normalizes non-string and oversized payTo into the shared bucket", async () => {
    const policy = createSpendPolicy({
      network: "stellar:pubnet",
      perPayToMax: 2,
      rateWindowMs: 60_000,
      spendCeilingStroops: 1_000_000_000,
      spendWindowMs: 60_000,
      perSettleEstimateStroops: 1,
    });
    const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog(), undefined, policy);
    await app.ready();
    try {
      const withPayTo = (payTo: unknown) => {
        const b = settleBody();
        (b.paymentRequirements as unknown as { payTo: unknown }).payTo = payTo;
        return b;
      };
      // Each request carries a DIFFERENT non-string/oversized payTo. If these
      // were honored as distinct keys, every one would get a fresh bucket and
      // none would ever be rate-limited.
      await app.inject({ method: "POST", url: "/settle", payload: withPayTo({ a: 1 }) });
      await app.inject({ method: "POST", url: "/settle", payload: withPayTo(["x"]) });
      const third = await app.inject({ method: "POST", url: "/settle", payload: withPayTo("Z".repeat(5000)) });
      expect(third.statusCode).toBe(503);
      expect(third.json().reason).toBe("rate_limited_payto");
      expect(policy.trackedPayTos()).toBe(1); // all collapsed into one bucket
    } finally {
      await app.close();
    }
  });

  // Final audit (HIGH): the refund only ran on the normal-return path. A /settle
  // that makes facilitator.settle() THROW (unregistered x402Version/scheme, or a
  // payload with no `accepted` key) escapes to Fastify as a 500 with the
  // reservation still held — so junk still exhausts the ceiling at zero cost and
  // no sponsor XLM is spent. Prevalidation does not help: one static valid XDR
  // is reused for every request.
  it("refunds the reservation when facilitator.settle throws (zero-cost outage)", async () => {
    const policy = createSpendPolicy({
      network: "stellar:pubnet",
      perPayToMax: 1000,
      rateWindowMs: 60_000,
      spendCeilingStroops: 1_500_000, // 3 slots at 500k
      spendWindowMs: 60_000,
      perSettleEstimateStroops: 500_000,
    });
    const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog(), undefined, policy);
    await app.ready();
    try {
      // Structurally valid XDR, but an x402Version with no registered facilitator
      // => x402Facilitator.settle THROWS before any network work.
      const thrower = () => {
        const b = settleBody();
        (b.paymentPayload as unknown as { x402Version: number }).x402Version = 999;
        return b;
      };
      for (let i = 0; i < 5; i++) {
        await app.inject({ method: "POST", url: "/settle", payload: thrower() });
      }
      // Those cost the sponsor nothing, so they must not have consumed budget.
      const real = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      if (real.statusCode === 503) {
        expect(real.json().reason).not.toBe("spend_ceiling");
      }
    } finally {
      await app.close();
    }
  });

  // Prompt (Fix 1): "unset config preserves current behavior" — with no policy
  // passed, /settle must behave exactly as it did before Fix 1: never refused.
  it("preserves prior behavior when no spend policy is configured", async () => {
    const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog());
    await app.ready();
    try {
      for (let i = 0; i < 8; i++) {
        const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
        expect(res.statusCode).not.toBe(503);
      }
    } finally {
      await app.close();
    }
  });

  it("does not let an empty payTo bypass the spend policy on pubnet (audit D3)", async () => {
    // An empty payTo must still be SUBJECT to the policy, not skip it. Asserted
    // via the per-payTo RATE limit rather than the spend ceiling: spend
    // reservations are refunded when a settle costs nothing (these test payloads
    // never reach the chain), but the rate count is deliberately NOT refunded, so
    // it is the durable evidence that the "<no-payto>" bucket is being enforced.
    const policy = createSpendPolicy({
      network: "stellar:pubnet",
      perPayToMax: 2,
      rateWindowMs: 60_000,
      spendCeilingStroops: 1_000_000_000, // ample: isolate the rate dimension
      spendWindowMs: 60_000,
      perSettleEstimateStroops: 1,
    });
    const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog(), undefined, policy);
    await app.ready();
    try {
      const emptyPayToBody = () => {
        const b = settleBody();
        (b.paymentRequirements as { payTo: string }).payTo = "";
        return b;
      };
      await app.inject({ method: "POST", url: "/settle", payload: emptyPayToBody() });
      await app.inject({ method: "POST", url: "/settle", payload: emptyPayToBody() });
      // Third exceeds rateMax for the shared no-payTo bucket → the policy ran.
      const third = await app.inject({ method: "POST", url: "/settle", payload: emptyPayToBody() });
      expect(third.statusCode).toBe(503);
      expect(third.json().reason).toBe("rate_limited_payto");
      expect(policy.trackedPayTos()).toBe(1); // all collapsed into one bucket
    } finally {
      await app.close();
    }
  });

  it("returns 503 settlement_refused once the per-payTo rate limit trips on pubnet", async () => {
    // Pubnet policy, rateMax 2 so the 3rd settle from one payTo is refused.
    const policy = createSpendPolicy({
      network: "stellar:pubnet",
      perPayToMax: 2,
      rateWindowMs: 60_000,
      spendCeilingStroops: 50_000_000,
      spendWindowMs: 60_000,
      perSettleEstimateStroops: 2_000_000,
    });
    const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog(), undefined, policy);
    await app.ready();
    try {
      // First two are allowed through to the facilitator (which fails on the
      // fake XDR, but the POLICY let them proceed — not a 503).
      for (let i = 0; i < 2; i++) {
        const ok = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
        expect(ok.statusCode).not.toBe(503);
      }
      const blocked = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      expect(blocked.statusCode).toBe(503);
      expect(blocked.json().error).toBe("settlement_refused");
      expect(blocked.json().reason).toBe("rate_limited_payto");
    } finally {
      await app.close();
    }
  });

  it("never returns 503 on testnet (fail-open), even past the limit", async () => {
    const policy = createSpendPolicy({
      network: "stellar:testnet",
      perPayToMax: 1,
      rateWindowMs: 60_000,
      spendCeilingStroops: 1,
      spendWindowMs: 60_000,
      perSettleEstimateStroops: 2_000_000,
    });
    const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog(), undefined, policy);
    await app.ready();
    try {
      for (let i = 0; i < 4; i++) {
        const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
        expect(res.statusCode).not.toBe(503);
      }
    } finally {
      await app.close();
    }
  });
});

describe("Fix 3 — sponsor balance guard on /settle", () => {
  function settleBody() {
    return {
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        scheme: "exact",
        network: "stellar:testnet",
        payload: { transaction: VALID_TX_XDR },
      },
      paymentRequirements: requirements(),
    };
  }

  it("returns 503 sponsor_balance_low when below the hard floor, but /discovery still serves", async () => {
    const guard = new BalanceGuard({
      fetchBalanceStroops: async () => 1_000_000, // 0.1 XLM, below 2 XLM hard floor
      softFloorStroops: 10 * 10_000_000,
      hardFloorStroops: 2 * 10_000_000,
      intervalMs: 60_000,
    });
    await guard.refresh();
    const catalog = new BazaarCatalog();
    const app = await buildServer(buildFacilitator(testConfig), catalog, undefined, undefined, {}, guard);
    await app.ready();
    try {
      const settle = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      expect(settle.statusCode).toBe(503);
      expect(settle.json().reason).toBe("sponsor_balance_low");
      // Discovery is unaffected.
      const disc = await app.inject({ method: "GET", url: "/discovery/resources" });
      expect(disc.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("does not refuse settle when the balance check has never succeeded (fail open)", async () => {
    const guard = new BalanceGuard({
      fetchBalanceStroops: async () => {
        throw new Error("horizon down");
      },
      softFloorStroops: 10 * 10_000_000,
      hardFloorStroops: 2 * 10_000_000,
      intervalMs: 60_000,
    });
    await guard.refresh(); // errors → unknown → allowed
    const app = await buildServer(buildFacilitator(testConfig), new BazaarCatalog(), undefined, undefined, {}, guard);
    await app.ready();
    try {
      const settle = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      expect(settle.statusCode).not.toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe("discovery wire conformance (canonical withBazaar client, unmodified)", () => {
  const catalog = new BazaarCatalog();
  let app: Awaited<ReturnType<typeof buildServer>>;
  let bazaar: ReturnType<typeof withBazaar<HTTPFacilitatorClient>>["extensions"]["bazaar"];

  beforeAll(async () => {
    app = await buildServer(buildFacilitator(testConfig), catalog);
    catalog.upsertFromPayment(discovered(), requirements());
    catalog.upsertFromPayment(
      discovered({
        resourceUrl: "https://api.example.com/prices",
        serviceName: "PriceFeed",
        tags: ["prices"],
        description: "token prices",
      }),
      requirements(),
    );
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    const client = withBazaar(new HTTPFacilitatorClient({ url: `http://127.0.0.1:${address.port}` }));
    bazaar = client.extensions.bazaar;
  });

  afterAll(async () => {
    await app.close();
  });

  it("listResources returns the catalog through the official client", async () => {
    const res = await bazaar.listResources();
    expect(res.x402Version).toBe(2);
    expect(res.items).toHaveLength(2);
    expect(res.pagination.total).toBe(2);
  });

  it("listResources filters pass through (type, limit)", async () => {
    const res = await bazaar.listResources({ type: "http", limit: 1 });
    expect(res.items).toHaveLength(1);
    expect(res.pagination.limit).toBe(1);
    expect(res.pagination.total).toBe(2);
  });

  it("search returns relevance-ranked results through the official client", async () => {
    const res = await bazaar.search({ query: "weather" });
    expect(res.x402Version).toBe(2);
    expect(res.resources).toHaveLength(1);
    expect(res.resources[0]!.resource).toBe("https://api.example.com/weather");
    expect(res.partialResults).toBe(false);
  });
});
