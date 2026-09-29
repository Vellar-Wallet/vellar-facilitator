import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { describe, expect, it, vi } from "vitest";
import { registerBazaar } from "./bazaar.js";
import { BazaarCatalog } from "./catalog.js";
import { tmpStore } from "./store.testkit.js";

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

function stubScheme(settleSucceeds: boolean): SchemeNetworkFacilitator {
  return {
    scheme: "exact",
    caipFamily: "stellar:*",
    getExtra: () => undefined,
    getSigners: () => [],
    verify: async () => ({ isValid: true, payer: "CPAYER" }),
    settle: async () => ({
      success: settleSucceeds,
      transaction: "stub-tx-hash",
      network: "stellar:testnet",
      payer: "CPAYER",
      ...(settleSucceeds ? {} : { errorReason: "stub_failure" }),
    }),
  } as unknown as SchemeNetworkFacilitator;
}

function payloadWithDiscovery(over: Partial<PaymentPayload> = {}): PaymentPayload {
  // declareDiscoveryExtension produces the seller's pre-enrichment declaration;
  // the resource-server extension sets `method` before the payload ships. The
  // facilitator sees the enriched form, so the fixture enriches it the same way.
  const extensions = declareDiscoveryExtension({
    input: { city: "lagos" },
    inputSchema: { properties: { city: { type: "string" } }, required: ["city"] },
  }) as Record<string, { info: { input: Record<string, unknown> } }>;
  extensions.bazaar!.info.input.method = "GET";

  return {
    x402Version: 2,
    resource: {
      url: "https://api.example.com/weather?city=lagos",
      description: "Hourly weather data",
      mimeType: "application/json",
      serviceName: "WeatherSvc",
      tags: ["weather", "data"],
    },
    accepted: requirements(),
    payload: { transaction: "AAAA" },
    extensions,
    ...over,
  } as PaymentPayload;
}

async function build(settleSucceeds = true) {
  const catalog = await BazaarCatalog.create();
  const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme(settleSucceeds));
  registerBazaar(facilitator, catalog);
  return { catalog, facilitator };
}

describe("registerBazaar", () => {
  it("advertises the bazaar extension on getSupported()", async () => {
    const { facilitator } = await build();
    expect(facilitator.getSupported().extensions).toContain("bazaar");
  });

  it("catalogs a settled payment that carries the discovery extension", async () => {
    const { catalog, facilitator } = await build();
    await facilitator.settle(payloadWithDiscovery(), requirements());
    expect(catalog.size).toBe(1);
    const item = catalog.list().items[0]!;
    // Canonical URL: origin + pathname — the query string never enters the catalog.
    expect(item.resource).toBe("https://api.example.com/weather");
    expect(item.type).toBe("http");
    expect(item.serviceName).toBe("WeatherSvc");
    expect(item.accepts[0]!.asset).toBe(requirements().asset);
  });

  it("does not catalog when the payload has no discovery extension", async () => {
    const { catalog, facilitator } = await build();
    await facilitator.settle(payloadWithDiscovery({ extensions: {} }), requirements());
    expect(catalog.size).toBe(0);
  });

  it("does not catalog a failed settlement", async () => {
    const { catalog, facilitator } = await build(false);
    await facilitator.settle(payloadWithDiscovery(), requirements());
    expect(catalog.size).toBe(0);
  });

  it("drops a malicious routeTemplate (path traversal) and catalogs under the real path", async () => {
    const { catalog, facilitator } = await build();
    const payload = payloadWithDiscovery();
    const ext = payload.extensions as Record<string, Record<string, unknown>>;
    ext.bazaar!.routeTemplate = "/weather/../admin";
    await facilitator.settle(payload, requirements());
    const item = catalog.list().items[0]!;
    expect(item.resource).toBe("https://api.example.com/weather");
  });

  it("drops a URL-injection routeTemplate and catalogs under the real path", async () => {
    const { catalog, facilitator } = await build();
    const payload = payloadWithDiscovery();
    const ext = payload.extensions as Record<string, Record<string, unknown>>;
    ext.bazaar!.routeTemplate = "https://evil.example/steal";
    await facilitator.settle(payload, requirements());
    const item = catalog.list().items[0]!;
    expect(item.resource).toBe("https://api.example.com/weather");
  });

  it("honors a VALID routeTemplate as the canonical catalog URL", async () => {
    const { catalog, facilitator } = await build();
    const payload = payloadWithDiscovery();
    const ext = payload.extensions as Record<string, Record<string, unknown>>;
    ext.bazaar!.routeTemplate = "/weather/:city";
    await facilitator.settle(payload, requirements());
    const item = catalog.list().items[0]!;
    expect(item.resource).toBe("https://api.example.com/weather/:city");
  });

  it("catalogs an MCP tool resource as type mcp", async () => {
    const { catalog, facilitator } = await build();
    const payload = payloadWithDiscovery({
      resource: { url: "https://mcp.example.com/tools" },
      extensions: declareDiscoveryExtension({
        toolName: "financial_analysis",
        description: "Analyze a ticker",
        inputSchema: { type: "object", properties: { ticker: { type: "string" } } },
      }),
    });
    await facilitator.settle(payload, requirements());
    const item = catalog.list().items[0]!;
    expect(item.type).toBe("mcp");
    expect(catalog.list({ type: "mcp" }).items).toHaveLength(1);
  });

  it("never lets cataloging break settlement, even if the catalog throws", async () => {
    const catalog = await BazaarCatalog.create();
    catalog.upsertFromPayment = () => {
      throw new Error("catalog exploded");
    };
    const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme(true));
    registerBazaar(facilitator, catalog);
    const result = await facilitator.settle(payloadWithDiscovery(), requirements());
    expect(result.success).toBe(true);
  });
});

// Operator Console audit logging (auditStore option) — a first catalog
// accept writes catalog_upsert, a reject writes catalog_rejected, both via
// the SAME outcome out-param EXTENSION-RESPONSES already reads (see
// registerBazaar's own comment on this call site). auditStore is undefined
// in every test above, which is itself the "off by default" case already
// covered: onAfterSettle's behavior is otherwise completely unchanged.
describe("registerBazaar — catalog audit logging", () => {
  // logAuditEvent is deliberately NOT awaited on this path (fire-and-forget,
  // see bazaar.ts's own comment on why) — settle() resolving does not
  // guarantee the write has landed yet, so these tests poll briefly rather
  // than asserting immediately after settle() returns.
  async function waitForAuditRow(store: Awaited<ReturnType<typeof tmpStore>>["store"], action: string) {
    for (let i = 0; i < 50; i++) {
      const { entries } = await store.queryAuditLog({ limit: 10, offset: 0, action });
      if (entries.length > 0) return entries;
      await new Promise((r) => setTimeout(r, 5));
    }
    return [];
  }

  it("writes catalog_upsert on a first successful catalog", async () => {
    const { store } = tmpStore();
    await store.init();
    const catalog = await BazaarCatalog.create(store);
    const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme(true));
    registerBazaar(facilitator, catalog, { auditStore: store });

    await facilitator.settle(payloadWithDiscovery(), requirements());

    const entries = await waitForAuditRow(store, "catalog_upsert");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toMatchObject({
      resourceUrl: "https://api.example.com/weather",
      payTo: requirements().payTo,
    });
    await store.close();
  });

  it("writes catalog_rejected with the real reason when the upsert is refused", async () => {
    const { store } = tmpStore();
    await store.init();
    const catalog = await BazaarCatalog.create(store);
    const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme(true));
    registerBazaar(facilitator, catalog, { auditStore: store });

    // First settle establishes the TOFU binding for this URL to
    // requirements().payTo. A second settle for the SAME URL by a
    // DIFFERENT payTo is refused with unbound_payto (catalog.ts's Fix 0
    // Layer 1) — a real, stable rejection reason reached from inside
    // upsertFromPayment's own funnel, not a contrived early-exit.
    await facilitator.settle(payloadWithDiscovery(), requirements());
    const hijackAttempt = { ...requirements(), payTo: "GDIFFERENTPAYTOACCOUNTNOTBOUNDXXXXXXXXXXXXXXXXXXXXXXXXXXX" };
    await facilitator.settle(payloadWithDiscovery({ accepted: hijackAttempt }), hijackAttempt);

    const entries = await waitForAuditRow(store, "catalog_rejected");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toMatchObject({ reason: "unbound_payto" });
    await store.close();
  });

  it("writes nothing when no auditStore is supplied (the default)", async () => {
    const { store: probeStore } = tmpStore();
    await probeStore.init();
    // catalog itself uses a DIFFERENT, in-memory (no-store) instance —
    // probeStore exists only so this test has somewhere to confirm the
    // absence of rows, proving registerBazaar never reaches for a store it
    // was not given.
    const catalog = await BazaarCatalog.create();
    const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme(true));
    registerBazaar(facilitator, catalog);
    await facilitator.settle(payloadWithDiscovery(), requirements());
    await new Promise((r) => setTimeout(r, 20));
    const { entries } = await probeStore.queryAuditLog({ limit: 10, offset: 0 });
    expect(entries).toHaveLength(0);
    await probeStore.close();
  });

  it("a failing audit write is swallowed and never surfaces to the caller", async () => {
    const { store } = tmpStore();
    await store.init();
    const failingStore = { ...store, appendAuditLog: vi.fn(() => Promise.reject(new Error("db down"))) };
    const catalog = await BazaarCatalog.create(store);
    const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme(true));
    registerBazaar(facilitator, catalog, { auditStore: failingStore as unknown as typeof store });

    const result = await facilitator.settle(payloadWithDiscovery(), requirements());
    expect(result.success).toBe(true);
    // Give the fire-and-forget write's rejection a tick to be handled —
    // proving it does NOT become an unhandled rejection / thrown error.
    await new Promise((r) => setTimeout(r, 20));
    await store.close();
  });
});
