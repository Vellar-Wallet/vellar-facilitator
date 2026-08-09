import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { registerBazaar } from "./bazaar.js";
import { BazaarCatalog } from "./catalog.js";
import { verifyResourceOwnership } from "./ownership.js";

// Fix 0 Layer 2 — the settlement hook triggers 402-challenge verification
// asynchronously (fire-and-forget). Settlement must return immediately and must
// never fail because verification is slow, hostile, or errors.

function requirements(payTo = "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A"): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND",
    amount: "1000000",
    payTo,
    maxTimeoutSeconds: 60,
    extra: {},
  } as PaymentRequirements;
}

function stubScheme(): SchemeNetworkFacilitator {
  return {
    scheme: "exact",
    caipFamily: "stellar:*",
    getExtra: () => undefined,
    getSigners: () => [],
    verify: async () => ({ isValid: true, payer: "CPAYER" }),
    settle: async () => ({ success: true, transaction: "stub-tx-hash", network: "stellar:testnet", payer: "CPAYER" }),
  } as unknown as SchemeNetworkFacilitator;
}

function payloadWithDiscovery(): PaymentPayload {
  const extensions = declareDiscoveryExtension({
    input: { city: "lagos" },
    inputSchema: { properties: { city: { type: "string" } } },
  }) as Record<string, { info: { input: Record<string, unknown> } }>;
  extensions.bazaar!.info.input.method = "GET";
  return {
    x402Version: 2,
    resource: { url: "https://api.example.com/weather", serviceName: "WeatherSvc" },
    accepted: requirements(),
    payload: { transaction: "AAAA" },
    extensions,
  } as PaymentPayload;
}

// The binding itself, end to end: a REAL 402 server, the REAL verifier (no
// injected verifyOwnership), through registerBazaar's settle hook, asserting the
// catalog's ownership binding is actually populated. Everything F3's tombstones
// preserve depends on this working — and the re-audit found it silently did not.
describe("Layer 2 populates the ownership binding for real (no mocks)", () => {
  it("sets verifiedOwner from a live 402 challenge", async () => {
    const payTo = "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A";
    const challenge = Buffer.from(JSON.stringify({ accepts: [{ payTo }] }), "utf8").toString("base64");
    const server = http.createServer((_q, res) => {
      res.writeHead(402, { "PAYMENT-REQUIRED": challenge });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const url = `http://owner.test:${port}/quote`;

    try {
      const catalog = new BazaarCatalog();
      const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme());
      // Real verifier — only the transport relaxations and DNS are injected.
      registerBazaar(facilitator, catalog, {
        verifyOwnership: (resourceUrl, settledPayTo) =>
          verifyResourceOwnership(resourceUrl, settledPayTo, {
            lookupFn: async () => ({ address: "127.0.0.1", family: 4 }),
            __insecureTestTransport: true,
          }),
      });

      const payload = payloadWithDiscovery();
      (payload as unknown as { resource: { url: string } }).resource.url = url;
      await facilitator.settle(payload, requirements(payTo));
      // Let the fire-and-forget verification complete.
      await new Promise((r) => setTimeout(r, 150));

      expect(catalog.size).toBe(1);
      expect(catalog.isVerifiedOwner(url), "the binding must actually be populated").toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("leaves the binding unset when the live challenge names a different payTo", async () => {
    const challenge = Buffer.from(
      JSON.stringify({ accepts: [{ payTo: "GSOMEONE_ELSE" }] }),
      "utf8",
    ).toString("base64");
    const server = http.createServer((_q, res) => {
      res.writeHead(402, { "PAYMENT-REQUIRED": challenge });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const url = `http://owner.test:${port}/quote`;

    try {
      const catalog = new BazaarCatalog();
      const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme());
      registerBazaar(facilitator, catalog, {
        verifyOwnership: (resourceUrl, settledPayTo) =>
          verifyResourceOwnership(resourceUrl, settledPayTo, {
            lookupFn: async () => ({ address: "127.0.0.1", family: 4 }),
            __insecureTestTransport: true,
          }),
      });
      const payload = payloadWithDiscovery();
      (payload as unknown as { resource: { url: string } }).resource.url = url;
      await facilitator.settle(payload, requirements());
      await new Promise((r) => setTimeout(r, 150));
      expect(catalog.isVerifiedOwner(url)).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("registerBazaar — Layer 2 async ownership verification", () => {
  it("does not delay or fail settlement when the verifier hangs", async () => {
    const catalog = new BazaarCatalog();
    // A verifier that never resolves — models a hostile/slow endpoint.
    const hangingVerify = vi.fn(() => new Promise<never>(() => {}));
    const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme());
    registerBazaar(facilitator, catalog, { verifyOwnership: hangingVerify });

    const started = Date.now();
    const result = await facilitator.settle(payloadWithDiscovery(), requirements());
    const elapsed = Date.now() - started;

    expect(result.success).toBe(true); // settlement succeeded
    expect(elapsed).toBeLessThan(500); // returned immediately, did not await the hang
    expect(catalog.size).toBe(1); // resource cataloged
    expect(hangingVerify).toHaveBeenCalledOnce(); // verification was kicked off
    expect(catalog.isVerifiedOwner("https://api.example.com/weather")).toBe(false); // still pending
  });

  it("marks the owner verified when the async 402 check returns match", async () => {
    const catalog = new BazaarCatalog();
    const verify = vi.fn(async () => "match" as const);
    const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme());
    registerBazaar(facilitator, catalog, { verifyOwnership: verify });

    await facilitator.settle(payloadWithDiscovery(), requirements());
    // Let the fire-and-forget microtask settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(verify).toHaveBeenCalledWith("https://api.example.com/weather", requirements().payTo);
    expect(catalog.isVerifiedOwner("https://api.example.com/weather")).toBe(true);
  });

  it("leaves the owner unverified on a mismatch verdict", async () => {
    const catalog = new BazaarCatalog();
    const verify = vi.fn(async () => "mismatch" as const);
    const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme());
    registerBazaar(facilitator, catalog, { verifyOwnership: verify });

    await facilitator.settle(payloadWithDiscovery(), requirements());
    await new Promise((r) => setTimeout(r, 0));

    expect(catalog.isVerifiedOwner("https://api.example.com/weather")).toBe(false);
  });

  it("never throws into settlement if the verifier rejects", async () => {
    const catalog = new BazaarCatalog();
    const verify = vi.fn(async () => {
      throw new Error("boom");
    });
    const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme());
    registerBazaar(facilitator, catalog, { verifyOwnership: verify });

    const result = await facilitator.settle(payloadWithDiscovery(), requirements());
    await new Promise((r) => setTimeout(r, 0));
    expect(result.success).toBe(true);
    expect(catalog.isVerifiedOwner("https://api.example.com/weather")).toBe(false);
  });
});
