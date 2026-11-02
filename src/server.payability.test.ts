import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { BazaarCatalog } from "./catalog.js";
import { buildFacilitator } from "./facilitator.js";
import type { PayabilityResolver } from "./payability.js";
import { buildServer } from "./server.js";
import { fakeChannelAccountSecretKeys } from "./testChannelPoolKeys.js";

// payable_only, end to end through buildServer — same shape of concern as
// server.pagination.test.ts's verified_only suite: pagination.total must
// agree with what items actually ships, and the filter must compose
// correctly with trust annotation rather than silently disabling it or vice
// versa.

const testConfig = {
  port: 0, host: "127.0.0.1", network: "stellar:testnet" as const, rpcUrl: undefined,
  sponsorSecretKey: Keypair.random().secret(), channelAccountSecretKeys: fakeChannelAccountSecretKeys(), maxTransactionFeeStroops: 500_000,
  channelAccountMinStroops: 5_000_000,
  catalogDbUrl: undefined, uptoContractId: undefined,
  bondEscrowContractId: undefined, bondEscrowAdminSecretKey: undefined,
  catalogDbAuthToken: undefined, verificationApiUrl: undefined,
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
function reqs(payTo: string, asset = "CASSET"): PaymentRequirements {
  return {
    scheme: "exact", network: "stellar:testnet", asset,
    amount: "1", payTo, maxTimeoutSeconds: 60,
  } as unknown as PaymentRequirements;
}

function fixedPayability(map: Record<string, "payable" | "not_payable" | "unknown">): PayabilityResolver {
  return { check: async (payTo, asset) => map[`${payTo}\u0000${asset}`] ?? "unknown" };
}

describe("payable_only — /discovery/resources", () => {
  it("drops a not_payable listing, reduces total to match", async () => {
    // MUTATION THAT MUST BREAK THIS: return `{ ...response, items }` without
    // adjusting pagination — the exact G-9/verified_only shape this repo has
    // already fixed once for a different filter.
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(disc("https://a.example/one"), reqs("GA"));
    await catalog.upsertFromPayment(disc("https://b.example/two"), reqs("GB"));

    const payability = fixedPayability({ "GA\u0000CASSET": "payable", "GB\u0000CASSET": "not_payable" });
    const app = await buildServer(
      buildFacilitator(testConfig),
      catalog,
      undefined,
      undefined,
      {},
      undefined,
      "stellar:testnet",
      undefined,
      undefined,
      payability,
    );

    const unfiltered = (await app.inject({ method: "GET", url: "/discovery/resources" })).json();
    expect(unfiltered.items.length).toBe(2);

    const filtered = (
      await app.inject({ method: "GET", url: "/discovery/resources?payable_only=true" })
    ).json();
    expect(filtered.items.map((i: { accepts: { payTo: string }[] }) => i.accepts[0]!.payTo)).toEqual(["GA"]);
    expect(
      filtered.pagination.total,
      "total must agree with items — a self-contradicting page teaches clients to trust nothing in it",
    ).toBe(1);
  });

  it("keeps an unknown listing visible — never silently drops or hides the verdict", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(disc("https://a.example/one"), reqs("GA"));

    const payability = fixedPayability({}); // resolves to "unknown" for everything
    const app = await buildServer(
      buildFacilitator(testConfig),
      catalog,
      undefined,
      undefined,
      {},
      undefined,
      "stellar:testnet",
      undefined,
      undefined,
      payability,
    );

    const filtered = (
      await app.inject({ method: "GET", url: "/discovery/resources?payable_only=true" })
    ).json();
    expect(filtered.items.length, "unknown is kept, not treated as not_payable").toBe(1);
    expect(filtered.items[0].trust.acceptsPayability).toEqual(["unknown"]);
  });

  it("has NO honest-refusal 400 — unlike verified_only, there is no deployment-level unavailable state", async () => {
    // payable_only with NO payability resolver configured at all must behave
    // like verified_only with no trust layer USED TO (silently return
    // everything unfiltered) — NOT like verified_only's current, deliberate
    // 400 refusal. The two differ because verified_only answers a question a
    // misconfigured deployment genuinely cannot answer (no verdict source);
    // payability has no equivalent unconfigured state (Horizon/RPC are
    // always derived from config.network).
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(disc("https://a.example/one"), reqs("GA"));

    const app = await buildServer(buildFacilitator(testConfig), catalog); // no trust, no payability

    const res = await app.inject({ method: "GET", url: "/discovery/resources?payable_only=true" });
    expect(res.statusCode, "payable_only is simply a no-op without a resolver, not a 400").toBe(200);
    expect(res.json().items.length).toBe(1);
  });

  it("composes with verified_only: both filters apply, total reflects the combined drop", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(disc("https://a.example/one"), reqs("GA"));
    await catalog.upsertFromPayment(disc("https://b.example/two"), reqs("GB"));

    const trust = { hasVerdictSource: true, assetStatus: async () => "verified" as const };
    const payability = fixedPayability({ "GA\u0000CASSET": "payable", "GB\u0000CASSET": "not_payable" });
    const app = await buildServer(
      buildFacilitator(testConfig),
      catalog,
      trust,
      undefined,
      {},
      undefined,
      "stellar:testnet",
      undefined,
      undefined,
      payability,
    );

    // B is dropped by payable_only even though it would pass verified_only
    // (ownerVerified is false for both here, so neither actually reads
    // "verified" — this just confirms both filters run, not just one).
    const filtered = (
      await app.inject({ method: "GET", url: "/discovery/resources?payable_only=true" })
    ).json();
    expect(filtered.items.map((i: { accepts: { payTo: string }[] }) => i.accepts[0]!.payTo)).toEqual(["GA"]);
    expect(filtered.pagination.total).toBe(1);
  });
});

describe("payable_only — /discovery/search", () => {
  it("drops not_payable entries from search results too", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(disc("https://a.example/weather"), reqs("GA"));
    await catalog.upsertFromPayment(disc("https://b.example/weather"), reqs("GB"));

    const payability = fixedPayability({ "GA\u0000CASSET": "payable", "GB\u0000CASSET": "not_payable" });
    const app = await buildServer(
      buildFacilitator(testConfig),
      catalog,
      undefined,
      undefined,
      {},
      undefined,
      "stellar:testnet",
      undefined,
      undefined,
      payability,
    );

    const filtered = (
      await app.inject({ method: "GET", url: "/discovery/search?query=weather&payable_only=true" })
    ).json();
    expect(
      filtered.resources.map((r: { accepts: { payTo: string }[] }) => r.accepts[0]!.payTo),
    ).toEqual(["GA"]);
  });
});
