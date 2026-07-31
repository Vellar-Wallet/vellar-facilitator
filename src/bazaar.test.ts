import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { registerBazaar } from "./bazaar.js";
import { BazaarCatalog } from "./catalog.js";

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

function build(settleSucceeds = true) {
  const catalog = new BazaarCatalog();
  const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme(settleSucceeds));
  registerBazaar(facilitator, catalog);
  return { catalog, facilitator };
}

describe("registerBazaar", () => {
  it("advertises the bazaar extension on getSupported()", () => {
    const { facilitator } = build();
    expect(facilitator.getSupported().extensions).toContain("bazaar");
  });

  it("catalogs a settled payment that carries the discovery extension", async () => {
    const { catalog, facilitator } = build();
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
    const { catalog, facilitator } = build();
    await facilitator.settle(payloadWithDiscovery({ extensions: {} }), requirements());
    expect(catalog.size).toBe(0);
  });

  it("does not catalog a failed settlement", async () => {
    const { catalog, facilitator } = build(false);
    await facilitator.settle(payloadWithDiscovery(), requirements());
    expect(catalog.size).toBe(0);
  });

  it("drops a malicious routeTemplate (path traversal) and catalogs under the real path", async () => {
    const { catalog, facilitator } = build();
    const payload = payloadWithDiscovery();
    const ext = payload.extensions as Record<string, Record<string, unknown>>;
    ext.bazaar!.routeTemplate = "/weather/../admin";
    await facilitator.settle(payload, requirements());
    const item = catalog.list().items[0]!;
    expect(item.resource).toBe("https://api.example.com/weather");
  });

  it("drops a URL-injection routeTemplate and catalogs under the real path", async () => {
    const { catalog, facilitator } = build();
    const payload = payloadWithDiscovery();
    const ext = payload.extensions as Record<string, Record<string, unknown>>;
    ext.bazaar!.routeTemplate = "https://evil.example/steal";
    await facilitator.settle(payload, requirements());
    const item = catalog.list().items[0]!;
    expect(item.resource).toBe("https://api.example.com/weather");
  });

  it("honors a VALID routeTemplate as the canonical catalog URL", async () => {
    const { catalog, facilitator } = build();
    const payload = payloadWithDiscovery();
    const ext = payload.extensions as Record<string, Record<string, unknown>>;
    ext.bazaar!.routeTemplate = "/weather/:city";
    await facilitator.settle(payload, requirements());
    const item = catalog.list().items[0]!;
    expect(item.resource).toBe("https://api.example.com/weather/:city");
  });

  it("catalogs an MCP tool resource as type mcp", async () => {
    const { catalog, facilitator } = build();
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
    const catalog = new BazaarCatalog();
    catalog.upsertFromPayment = () => {
      throw new Error("catalog exploded");
    };
    const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme(true));
    registerBazaar(facilitator, catalog);
    const result = await facilitator.settle(payloadWithDiscovery(), requirements());
    expect(result.success).toBe(true);
  });
});
