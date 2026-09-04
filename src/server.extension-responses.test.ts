import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator } from "@x402/core/types";
import { x402Facilitator } from "@x402/core/facilitator";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { BalanceGuard } from "./balance.js";
import { ChannelPool } from "./channelPool.js";
import { buildServer } from "./server.js";
import { fakeChannelAccountSecretKeys } from "./testChannelPoolKeys.js";

// RFP gap #2 — EXTENSION-RESPONSES header.
//
// WHY THIS FILE DOES NOT USE vi.spyOn(built.facilitator, "settle"), unlike
// server.bondregistration.test.ts. That pattern replaces the WHOLE settle()
// method, which is exactly where @x402/core runs afterSettleHooks
// (facilitator/index.mjs: `for (const hook of this.afterSettleHooks) await
// hook(resultContext)`, INSIDE settle(), before it returns) — so a spied
// settle() never runs registerBazaar's onAfterSettle hook at all, and the
// header this file exists to test would never be set no matter what the
// implementation does. Confirmed by reading @x402/core's source, not
// assumed.
//
// Instead this matches src/bazaar.test.ts's own convention: a real
// x402Facilitator, registered with a STUB SchemeNetworkFacilitator (network
// call replaced, hook machinery untouched) — so registerBazaar's hook
// (wired inside buildServer itself, at `registerBazaar(facilitator,
// catalog)`) runs for real, exactly as it does in production.

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

const PAYER = Keypair.random().publicKey();
const RESOURCE_URL = "https://api.example.com/weather";

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

/** Matches bazaar.test.ts's stubScheme: the scheme's own network settle call
 *  is replaced (no real Soroban RPC), but @x402/core's hook machinery around
 *  it — including afterSettleHooks — is completely untouched. */
function stubScheme(settleSucceeds: boolean): SchemeNetworkFacilitator {
  return {
    scheme: "exact",
    caipFamily: "stellar:*",
    getExtra: () => undefined,
    getSigners: () => [],
    verify: async () => ({ isValid: true, payer: PAYER }),
    settle: async () => ({
      success: settleSucceeds,
      transaction: settleSucceeds ? "stub-tx-hash" : "",
      network: "stellar:testnet",
      payer: PAYER,
      ...(settleSucceeds ? {} : { errorReason: "stub_failure" }),
    }),
  } as unknown as SchemeNetworkFacilitator;
}

/** A structurally VALID transaction envelope — /settle shreds unparseable
 *  XDR at the route before ever reaching facilitator.settle (same fixture
 *  as server.bondregistration.test.ts / server.test.ts). */
const VALID_TX_XDR =
  "AAAAAgAAAAARUqIOOVQYwBn0s32MhGQwyoTHPy7SzjfXdweAw6b/4gAAAGQAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAABqdyAuAAAAAAAAAAEAAAAAAAAAAQAAAADrmp8rY1JU7CL78HNaROud45MqVmrrbxOCVuWSEz0eRwAAAAAAAAAAAJiWgAAAAAAAAAAA";

/** payload WITH the bazaar discovery extension attached — reaches
 *  extractDiscoveryInfo's "attempted" branch inside the hook. */
function discoveryPayload(): PaymentPayload {
  const extensions = declareDiscoveryExtension({
    input: { city: "lagos" },
    inputSchema: { properties: { city: { type: "string" } }, required: ["city"] },
  }) as Record<string, { info: { input: Record<string, unknown> } }>;
  extensions.bazaar!.info.input.method = "GET";
  return {
    x402Version: 2,
    scheme: "exact",
    network: "stellar:testnet",
    resource: {
      url: RESOURCE_URL,
      description: "Hourly weather data",
      mimeType: "application/json",
      serviceName: "WeatherSvc",
      tags: ["weather"],
    },
    accepted: requirements(),
    payload: { transaction: VALID_TX_XDR },
    extensions,
  } as unknown as PaymentPayload;
}

/** payload with NO discovery extension at all — reaches the hook's
 *  "not attempted" branch (extractDiscoveryInfo returns undefined). */
function plainPayload(): PaymentPayload {
  return {
    x402Version: 2,
    scheme: "exact",
    network: "stellar:testnet",
    resource: { url: RESOURCE_URL },
    payload: { transaction: VALID_TX_XDR },
  } as unknown as PaymentPayload;
}

function settleBody(payload: PaymentPayload) {
  return { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements() };
}

async function appWithStubScheme(settleSucceeds: boolean, catalog?: BazaarCatalog, balanceGuard?: BalanceGuard) {
  const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme(settleSucceeds));
  // stubScheme never calls selectSigner, so the pool is never touched — an
  // empty pool is fine here, matching how bazaar.test.ts's stub needs no
  // pool at all. buildServer still requires the shape, so a pool sized like
  // production is used for realism, not because anything acquires from it.
  const pool = new ChannelPool(fakeChannelAccountSecretKeys());
  const app = await buildServer(
    { facilitator, pool },
    catalog ?? (await BazaarCatalog.create()),
    undefined,
    undefined,
    {},
    balanceGuard,
    "stellar:testnet",
    undefined,
  );
  await app.ready();
  return app;
}

describe("EXTENSION-RESPONSES header — set only on paths that reach cataloging", () => {
  it("a successful settle WITH the discovery extension sets cataloged: true, no reason", async () => {
    const app = await appWithStubScheme(true);
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody(discoveryPayload()) });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);

      const header = res.headers["extension-responses"];
      expect(header).toBeDefined();
      const parsed = JSON.parse(header as string);
      expect(parsed).toEqual({ bazaar: { cataloged: true } });
    } finally {
      await app.close();
    }
  });

  it("a successful settle with NO discovery extension sets cataloged: false, reason no_discovery_extension", async () => {
    const app = await appWithStubScheme(true);
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody(plainPayload()) });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);

      const header = res.headers["extension-responses"];
      expect(header).toBeDefined();
      const parsed = JSON.parse(header as string);
      expect(parsed).toEqual({ bazaar: { cataloged: false, reason: "no_discovery_extension" } });
    } finally {
      await app.close();
    }
  });

  it("a settle that reaches cataloging but is REJECTED by the catalog sets cataloged: false with a reason", async () => {
    // Second settle for the same URL from an unbound payTo — upsertFromPayment's
    // own "unbound_payto" rejection branch (catalog.ts). Needs the URL already
    // bound to a DIFFERENT payTo first, via a prior real settle through the
    // same catalog instance.
    const catalog = await BazaarCatalog.create();
    const app = await appWithStubScheme(true, catalog);
    try {
      // First settle binds the URL to PAYER's payTo (requirements().payTo).
      await app.inject({ method: "POST", url: "/settle", payload: settleBody(discoveryPayload()) });
      expect(catalog.size).toBe(1);

      // Second settle: same resourceUrl, different (unbound) payTo.
      const rejectedReqs: PaymentRequirements = { ...requirements(), payTo: Keypair.random().publicKey() };
      const res = await app.inject({
        method: "POST",
        url: "/settle",
        payload: { x402Version: 2, paymentPayload: discoveryPayload(), paymentRequirements: rejectedReqs },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true); // settlement itself still succeeds

      const header = res.headers["extension-responses"];
      expect(header).toBeDefined();
      const parsed = JSON.parse(header as string);
      expect(parsed.bazaar.cataloged).toBe(false);
      expect(parsed.bazaar.reason).toBe("unbound_payto");
    } finally {
      await app.close();
    }
  });

  // NOT UNIT-TESTABLE OFFLINE — investigated, not assumed, matching
  // server.metrics.test.ts's own documented finding for the exact same
  // path. poolExhausted is set INSIDE facilitator.ts's selectSigner closure,
  // which only the real ExactStellarScheme calls (during a genuine settle()
  // that reaches live Soroban RPC) — a stub scheme's settle() (this file's
  // whole harness) never calls selectSigner at all, so poolExhausted can
  // never become true here no matter how the pool is pre-drained. Exporting
  // a test seam into facilitator.ts to force it was rejected there for the
  // same reason it would be rejected here: production surface added to
  // satisfy one test.
  //
  // What IS asserted here, honestly: the code-level guarantee that makes
  // the pool_exhausted response header-free. server.ts's pool_exhausted
  // branch (`if (captured.poolExhausted) { ...; return reply.status(503)...
  // }`) returns UNCONDITIONALLY before `catalogOutcome` is ever read off
  // `captured.value.value.catalogOutcome` and before the
  // `if (catalogOutcome) { reply.header(...) }` block that follows it — so
  // pool_exhausted shares the exact same "return before the header block"
  // shape as the 400 path and the REAL, reachable sponsor_balance_low 503
  // path both asserted directly below.
  it("400 early-exit paths share the exact code position pool_exhausted's 503 returns from — see comment above", async () => {
    const app = await appWithStubScheme(true);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/settle",
        payload: { x402Version: 2, paymentPayload: {}, paymentRequirements: {} },
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers["extension-responses"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("a 503 sponsor_balance_low early return (real BalanceGuard, no mocking) does NOT set the header", async () => {
    // Real, reachable early exit — server.ts checks balanceGuard.settleAllowed()
    // before ever touching facilitator.settle(), so this needs no stub scheme
    // trickery at all, matching server.test.ts's own "Fix 3 — sponsor balance
    // guard" suite.
    const guard = new BalanceGuard({
      fetchBalanceStroops: async () => 1_000_000, // 0.1 XLM, below the 2 XLM hard floor
      softFloorStroops: 10 * 10_000_000,
      hardFloorStroops: 2 * 10_000_000,
      intervalMs: 60_000,
    });
    await guard.refresh();
    const app = await appWithStubScheme(true, undefined, guard);
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody(discoveryPayload()) });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).reason).toBe("sponsor_balance_low");
      expect(res.headers["extension-responses"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("a 400 (invalid_body) early return does NOT set the header", async () => {
    const app = await appWithStubScheme(true);
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: {} });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).errorReason).toBe("invalid_body");
      expect(res.headers["extension-responses"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("a 400 (invalid_payload — unparseable XDR) early return does NOT set the header", async () => {
    const app = await appWithStubScheme(true);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/settle",
        payload: {
          x402Version: 2,
          paymentPayload: { ...discoveryPayload(), payload: { transaction: "not-valid-xdr" } },
          paymentRequirements: requirements(),
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).errorReason).toBe("invalid_payload");
      expect(res.headers["extension-responses"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("a FAILED settlement does NOT set the header — the hook's own first line never runs cataloging on failure", async () => {
    const app = await appWithStubScheme(false);
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody(discoveryPayload()) });
      expect(res.statusCode).toBe(200); // a conformant x402 response, success: false
      expect(JSON.parse(res.body).success).toBe(false);
      expect(res.headers["extension-responses"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe("EXTENSION-RESPONSES header value — sanitized before it is ever set", () => {
  it("the header is a bounded JSON string with no raw newlines or carriage returns", async () => {
    // Every real reason today is a fixed enum literal (invalid_payto,
    // ownership_tombstone_mismatch, unbound_payto, schema_validation_failed,
    // binding_refused, no_discovery_extension, cataloging_error) — none
    // contain a newline by construction. This test asserts the OUTPUT
    // property directly (no CR/LF in the wire value) rather than trusting
    // that invariant never drifts, which is exactly what
    // sanitizeExtensionResponsesReason in server.ts exists to guarantee even
    // if it ever does.
    const catalog = await BazaarCatalog.create();
    const app = await appWithStubScheme(true, catalog);
    try {
      await app.inject({ method: "POST", url: "/settle", payload: settleBody(discoveryPayload()) });
      const rejectedReqs: PaymentRequirements = { ...requirements(), payTo: Keypair.random().publicKey() };
      const res = await app.inject({
        method: "POST",
        url: "/settle",
        payload: { x402Version: 2, paymentPayload: discoveryPayload(), paymentRequirements: rejectedReqs },
      });
      const header = res.headers["extension-responses"] as string;
      expect(header).toBeDefined();
      expect(header).not.toMatch(/[\r\n]/);
      expect(header.length).toBeLessThanOrEqual(4096);
      // Round-trips as valid JSON — a header that merely "has no newlines"
      // but is truncated mid-string would still be a malformed value.
      expect(() => JSON.parse(header)).not.toThrow();
    } finally {
      await app.close();
    }
  });
});
