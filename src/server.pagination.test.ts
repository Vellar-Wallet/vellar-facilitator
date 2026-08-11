import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { BazaarCatalog } from "./catalog.js";
import { buildFacilitator } from "./facilitator.js";
import { buildServer } from "./server.js";
import { createTrustResolver } from "./trust.js";

// `pagination.total` must describe what the caller can actually page through.
//
// The catalog computes `total` before the trust layer exists, so a
// `verified_only` filter applied afterwards left `items: []` sitting beside
// `total: 1` — a response that contradicts itself. Small, and the cost is not
// small: a client that catches one number lying has no reason to trust the
// settlement counts either.

const testConfig = {
  port: 0, host: "127.0.0.1", network: "stellar:testnet" as const, rpcUrl: undefined,
  sponsorSecretKey: Keypair.random().secret(), maxTransactionFeeStroops: 500_000,
  catalogDbUrl: undefined, catalogDbAuthToken: undefined, verificationApiUrl: undefined,
  spend: { rateWindowMs: 60_000, ceilingStroops: 50_000_000, windowMs: 60_000, perUrlMax: 10, perPayToMax: 50, unboundPoolMax: 10 },
  balance: { softFloorStroops: 250_000_000, hardFloorStroops: 100_000_000, intervalMs: 60_000 },
};

function disc(url: string): DiscoveredResource {
  return {
    resourceUrl: url,
    x402Version: 2,
    discoveryInfo: { input: { type: "http", method: "GET" } },
  } as unknown as DiscoveredResource;
}
function reqs(payTo: string): PaymentRequirements {
  return {
    scheme: "exact", network: "stellar:testnet", asset: "CASSET",
    amount: "1", payTo, maxTimeoutSeconds: 60,
  } as unknown as PaymentRequirements;
}

describe("pagination.total counts what the caller can page through", () => {
  it("verified_only reduces total, not just items", async () => {
    // MUTATION THAT MUST BREAK THIS: return `{ ...response, items }` without
    // adjusting pagination. `total` then reports the unfiltered count and the
    // response contradicts itself — which is the bug this fixes, and exactly
    // what the hosted instance did (`items: []` alongside `total: 1`).
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(disc("https://a.example/one"), reqs("GA"));
    await catalog.upsertFromPayment(disc("https://b.example/two"), reqs("GB"));

    // No verification API configured, which is the deployed reality: every
    // verdict is "unknown", so verified_only filters everything out.
    const trust = createTrustResolver({ verificationApiUrl: undefined, rpcUrl: "https://rpc.invalid" });
    const app = await buildServer(buildFacilitator(testConfig), catalog, trust);

    const unfiltered = (await app.inject({ method: "GET", url: "/discovery/resources" })).json();
    expect(unfiltered.items.length, "precondition: two entries").toBe(2);
    expect(unfiltered.pagination.total).toBe(2);

    const filtered = (
      await app.inject({ method: "GET", url: "/discovery/resources?verified_only=true" })
    ).json();
    expect(filtered.items.length, "nothing is verified here").toBe(0);
    expect(
      filtered.pagination.total,
      "total must agree with items — a self-contradicting page teaches clients to trust nothing in it",
    ).toBe(0);
  });

  it("an unfiltered request is untouched", async () => {
    // MUTATION: apply the reduction unconditionally. Ordinary paging then
    // under-reports and clients stop early, silently missing resources.
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(disc("https://a.example/one"), reqs("GA"));
    const trust = createTrustResolver({ verificationApiUrl: undefined, rpcUrl: "https://rpc.invalid" });
    const app = await buildServer(buildFacilitator(testConfig), catalog, trust);

    const body = (await app.inject({ method: "GET", url: "/discovery/resources" })).json();
    expect(body.items.length).toBe(1);
    expect(body.pagination.total, "unfiltered total is the catalog count").toBe(1);
  });
});
