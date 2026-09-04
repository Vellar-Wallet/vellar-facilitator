import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { buildFacilitator } from "./facilitator.js";
import { buildServer } from "./server.js";
import { fakeChannelAccountSecretKeys } from "./testChannelPoolKeys.js";
import { registry } from "./metrics.js";

// Tranche 1 deliverable 1.2 (scf-form-response.md: "metrics + structured
// logging, 10+ named metrics") — this file tests the METRICS
// instrumentation specifically: that the right counters/histogram move on
// the right paths, and that /metrics itself returns valid, complete
// Prometheus text. The underlying /settle and /verify HANDLER LOGIC (spend
// policy, balance guard, bond registration, malformed-payload handling) is
// already covered by server.test.ts and server.bondregistration.test.ts —
// not duplicated here. Isolated in its own file, matching the existing
// server.pagination.test.ts / server.policykey.test.ts /
// server.health.test.ts / server.bondregistration.test.ts convention.
//
// RESET MECHANISM (confirmed from prom-client's own type definitions,
// node_modules/prom-client/index.d.ts): Registry has both `clear()` (REMOVES
// all metrics, which would desync src/metrics.ts's own long-lived
// Counter/Gauge/Histogram objects from the registry — they'd still exist as
// JS objects but no longer be attached to it) and `resetMetrics()` (resets
// VALUES, keeps every metric definition registered). resetMetrics() is the
// correct one here: src/metrics.ts registers all 11 metrics plus
// collectDefaultMetrics() exactly once, at module import time, into ONE
// module-level `registry` — the same singleton every test in this file (and
// every real request in the actual app) shares, so counters would otherwise
// accumulate across tests within this one run.

const testConfig = {
  port: 0,
  host: "127.0.0.1",
  network: "stellar:testnet" as const,
  rpcUrl: undefined,
  sponsorSecretKey: Keypair.random().secret(),
  channelAccountSecretKeys: fakeChannelAccountSecretKeys(),
  maxTransactionFeeStroops: 2_000_000,
  channelAccountMinStroops: 5_000_000,
  catalogDbUrl: undefined,
  uptoContractId: undefined,
  bondEscrowContractId: undefined,
  bondEscrowAdminSecretKey: undefined,
  catalogDbAuthToken: undefined,
  verificationApiUrl: undefined,
  spend: { rateWindowMs: 60_000, ceilingStroops: 50_000_000, windowMs: 60_000, perUrlMax: 10, perPayToMax: 100, unboundPoolMax: 10 },
  balance: { softFloorStroops: 100_000_000, hardFloorStroops: 20_000_000, intervalMs: 60_000 },
};

// Same structurally-valid envelope server.test.ts / server.bondregistration.test.ts
// already use — /settle shreds unparseable XDR at the route before ever
// reaching facilitator.settle, so a real test needs real (if fake-signed) XDR.
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

function verifyBody() {
  return settleBody();
}

const METRIC_LINE = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})?\s+-?[0-9.eE+-]+(\s+[0-9]+)?$/m;

describe("/metrics", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  it("returns HTTP 200 with Content-Type matching registry.contentType", async () => {
    const built = buildFacilitator(testConfig);
    const app = await buildServer(built, await BazaarCatalog.create());
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe(registry.contentType);
    } finally {
      await app.close();
    }
  });

  it("response body is valid Prometheus text (contains at least one correctly-formatted metric line)", async () => {
    const built = buildFacilitator(testConfig);
    const app = await buildServer(built, await BazaarCatalog.create());
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.body).toMatch(METRIC_LINE);
    } finally {
      await app.close();
    }
  });

  it("all 11 named vellar_* metrics are present in the response body", async () => {
    const built = buildFacilitator(testConfig);
    const app = await buildServer(built, await BazaarCatalog.create());
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      const body = res.body;
      // Names only — not asserting specific values here, that's covered by
      // the /settle and /verify instrumentation tests below. This test's
      // job is completeness: every one of the grant's "10+ named metrics"
      // actually shows up on a real scrape, not just that it compiles.
      const expectedNames = [
        "vellar_settle_total",
        "vellar_settle_errors_total",
        "vellar_verify_total",
        "vellar_settle_duration_seconds",
        "vellar_pool_available",
        "vellar_pool_in_use",
        "vellar_pool_disabled",
        "vellar_catalog_size",
        "vellar_rate_limit_rejections_total",
        "vellar_uptime_seconds",
        "vellar_reverify_pending",
      ];
      expect(expectedNames).toHaveLength(11);
      for (const name of expectedNames) {
        expect(body, `expected ${name} to appear in /metrics output`).toContain(name);
      }
    } finally {
      await app.close();
    }
  });

  it("rate limit is active: the 61st request in a minute is rejected, not served", async () => {
    const built = buildFacilitator(testConfig);
    const app = await buildServer(built, await BazaarCatalog.create());
    try {
      let lastStatus = 0;
      for (let i = 0; i < 61; i++) {
        const res = await app.inject({ method: "GET", url: "/metrics" });
        lastStatus = res.statusCode;
      }
      // @fastify/rate-limit's own documented behavior on exceeding the
      // configured max: 429 Too Many Requests (confirmed against its
      // README/source — the same status code the GLOBAL limiter already
      // relies on elsewhere in this codebase, src/hardening.test.ts).
      expect(lastStatus).toBe(429);
    } finally {
      await app.close();
    }
  });
});

describe("/settle metrics instrumentation", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  async function scrapeVellarMetric(app: Awaited<ReturnType<typeof buildServer>>, name: string): Promise<string> {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    const lines = res.body.split("\n").filter((l) => l.startsWith(name));
    return lines.join("\n");
  }

  it("a successful settle increments vellar_settle_total{outcome=\"success\"}", async () => {
    // Real facilitator.settle() cannot return success:true offline (no live
    // Soroban RPC in this test suite) — same constraint
    // server.bondregistration.test.ts's own appWithStubbedSuccess helper
    // documents ("no existing test in server.test.ts achieves success:true
    // either"). Stubbing facilitator.settle directly is the established,
    // correct way to reach this path.
    const built = buildFacilitator(testConfig);
    vi.spyOn(built.facilitator, "settle").mockResolvedValue({
      success: true,
      transaction: "a".repeat(64),
      payer: Keypair.random().publicKey(),
      network: "stellar:testnet",
    } as never);
    const app = await buildServer(built, await BazaarCatalog.create());
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      expect(res.statusCode).toBe(200);
      const metric = await scrapeVellarMetric(app, "vellar_settle_total");
      expect(metric).toContain('vellar_settle_total{outcome="success"} 1');
      expect(metric).not.toContain('outcome="failure"');
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  });

  it("a failed settle increments vellar_settle_total{outcome=\"failure\"} and vellar_settle_errors_total with the correct reason", async () => {
    const built = buildFacilitator(testConfig);
    const app = await buildServer(built, await BazaarCatalog.create());
    try {
      // The 400 invalid_body path — a real, reachable failure with no
      // mocking needed at all.
      const res = await app.inject({ method: "POST", url: "/settle", payload: {} });
      expect(res.statusCode).toBe(400);
      const settleTotal = await scrapeVellarMetric(app, "vellar_settle_total");
      expect(settleTotal).toContain('vellar_settle_total{outcome="failure"} 1');
      const errors = await scrapeVellarMetric(app, "vellar_settle_errors_total");
      // invalid_body is not one of the three named reasons (pool_exhausted /
      // txBadSeq / TRY_AGAIN_LATER) — confirmed by reading src/server.ts:
      // errorReason is only ever set inside those three specific branches,
      // so anything else defaults to "other" in the finally block.
      expect(errors).toContain('vellar_settle_errors_total{reason="other"} 1');
    } finally {
      await app.close();
    }
  });

  it("the duration histogram is observed on /settle even on the early-return 400 path", async () => {
    const built = buildFacilitator(testConfig);
    const app = await buildServer(built, await BazaarCatalog.create());
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: {} });
      expect(res.statusCode).toBe(400);
      const histogram = await scrapeVellarMetric(app, "vellar_settle_duration_seconds_count");
      // Exactly one observation — the 400 never reached facilitator.settle()
      // at all, confirming the histogram covers the WHOLE handler, not just
      // the path that calls the facilitator.
      expect(histogram).toContain("vellar_settle_duration_seconds_count 1");
    } finally {
      await app.close();
    }
  });

  // NOT UNIT-TESTABLE OFFLINE — investigated, not assumed. Draining the real
  // pool (via built.pool.acquire() in a loop) and firing a real /settle
  // request was tried first; it reaches ExactStellarScheme._verify() and
  // throws there (TypeError, Cannot read properties of undefined), because
  // _verify() genuinely simulates the transaction against live Soroban RPC
  // before settle() ever calls selectSigner — the same reason no other test
  // in this codebase reaches a genuine facilitator.settle() success either
  // (see server.bondregistration.test.ts's own appWithStubbedSuccess
  // comment). Mocking facilitator.settle to skip that step also skips
  // selectSigner entirely — poolExhausted is a flag set INSIDE
  // facilitator.ts's own selectSigner closure
  // (channelAcquisitionStore.getStore().poolExhausted = true, private to
  // that module, never exported), reachable only through a real,
  // unmocked settle() call. A mocked settle() cannot exercise it no matter
  // what the mock returns or throws.
  //
  // Exporting a test-only seam into facilitator.ts (e.g. the
  // AsyncLocalStorage itself, or a helper to set the flag directly) to make
  // this one case reachable offline was explicitly considered and
  // rejected — production-code surface area added solely to satisfy one
  // test is exactly the kind of thing that outlives its own justification.
  //
  // REAL EVIDENCE THIS PATH WORKS, instead: the channel-pool load test run
  // on 2026-08-31 (load-test-results-2026-08-31T11-15-47-630Z.json) — during
  // that run's FIRST attempt, before the double-acquisition bug
  // (src/facilitator.ts's own withChannelAcquisitionCapture doc comment)
  // was found and fixed, the real pool genuinely exhausted under real load
  // and produced real 503 pool_exhausted responses from server.ts's own
  // classification logic — the exact code path this test would otherwise
  // exercise, proven correct end-to-end against a real running instance,
  // not simulated.
});

describe("/verify metrics instrumentation", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  async function scrapeVellarMetric(app: Awaited<ReturnType<typeof buildServer>>, name: string): Promise<string> {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    const lines = res.body.split("\n").filter((l) => l.startsWith(name));
    return lines.join("\n");
  }

  it("a successful verify increments vellar_verify_total{outcome=\"success\"}", async () => {
    const built = buildFacilitator(testConfig);
    vi.spyOn(built.facilitator, "verify").mockResolvedValue({
      isValid: true,
      payer: Keypair.random().publicKey(),
    } as never);
    const app = await buildServer(built, await BazaarCatalog.create());
    try {
      const res = await app.inject({ method: "POST", url: "/verify", payload: verifyBody() });
      expect(res.statusCode).toBe(200);
      expect(res.json().isValid).toBe(true);
      const metric = await scrapeVellarMetric(app, "vellar_verify_total");
      expect(metric).toContain('vellar_verify_total{outcome="success"} 1');
      expect(metric).not.toContain('outcome="failure"');
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  });

  it("a failed verify increments vellar_verify_total{outcome=\"failure\"}", async () => {
    const built = buildFacilitator(testConfig);
    const app = await buildServer(built, await BazaarCatalog.create());
    try {
      // The 400 invalid_body path — real, no mocking needed.
      const res = await app.inject({ method: "POST", url: "/verify", payload: {} });
      expect(res.statusCode).toBe(400);
      const metric = await scrapeVellarMetric(app, "vellar_verify_total");
      expect(metric).toContain('vellar_verify_total{outcome="failure"} 1');
    } finally {
      await app.close();
    }
  });
});
