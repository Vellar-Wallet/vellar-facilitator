import { Keypair } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { withBazaar, type DiscoveredResource } from "@x402/extensions/bazaar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { buildFacilitator } from "./facilitator.js";
import { buildServer } from "./server.js";

const testConfig = {
  port: 0,
  host: "127.0.0.1",
  network: "stellar:testnet" as const,
  rpcUrl: undefined,
  sponsorSecretKey: Keypair.random().secret(),
  maxTransactionFeeStroops: 2_000_000,
  catalogFile: undefined,
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
  const app = buildServer(buildFacilitator(testConfig), catalog);

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

describe("discovery wire conformance (canonical withBazaar client, unmodified)", () => {
  const catalog = new BazaarCatalog();
  const app = buildServer(buildFacilitator(testConfig), catalog);
  let bazaar: ReturnType<typeof withBazaar<HTTPFacilitatorClient>>["extensions"]["bazaar"];

  beforeAll(async () => {
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
