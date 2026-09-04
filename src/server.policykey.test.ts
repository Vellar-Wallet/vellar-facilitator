import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { buildFacilitator } from "./facilitator.js";
import { buildServer } from "./server.js";
import type { SettleIdentity } from "./policy.js";
import { fakeChannelAccountSecretKeys } from "./testChannelPoolKeys.js";

// G-3 at the ROUTE. src/catalog.canonicalkey.test.ts proves the catalog helper
// canonicalizes; it does NOT prove /settle uses it. Without this file, reverting
// the route to the raw payload url leaves the whole suite green — the RA-12
// decorative-test failure mode. This asserts on the identity the route actually
// hands the spend policy.

const PAY = "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A";
const CANONICAL = "https://api.merchant.example/quote";
const ASSET = "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND";

const VALID_TX_XDR =
  "AAAAAgAAAAARUqIOOVQYwBn0s32MhGQwyoTHPy7SzjfXdweAw6b/4gAAAGQAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAABqdyAuAAAAAAAAAAEAAAAAAAAAAQAAAADrmp8rY1JU7CL78HNaROud45MqVmrrbxOCVuWSEz0eRwAAAAAAAAAAAJiWgAAAAAAAAAAA";

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

function reqs(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: ASSET,
    amount: "1000000",
    payTo: PAY,
    maxTimeoutSeconds: 60,
    extra: {},
  } as PaymentRequirements;
}

/** Records what the route asked the policy, then allows the settle. */
function spyPolicy() {
  const seen: SettleIdentity[] = [];
  const policy = {
    checkSettle(id: SettleIdentity) {
      seen.push(id);
      return { allowed: true, reservation: 1 };
    },
    refundUnspent() {},
  };
  return { seen, policy };
}

async function settleWith(rawUrl: string) {
  const catalog = await BazaarCatalog.create();
  // The merchant is bound under the CANONICAL key, as extractDiscoveryInfo
  // would have stored it.
  await catalog.upsertFromPayment(
    { resourceUrl: CANONICAL, x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as DiscoveredResource,
    reqs(),
  );
  const { seen, policy } = spyPolicy();
  const app = await buildServer(
    buildFacilitator(testConfig),
    catalog,
    undefined,
    policy as never,
  );
  await app.inject({
    method: "POST",
    url: "/settle",
    payload: {
      paymentPayload: {
        x402Version: 2,
        resource: { url: rawUrl },
        payload: { transaction: VALID_TX_XDR },
      },
      paymentRequirements: reqs(),
    },
  });
  await app.close();
  return seen;
}

describe("G-3 — /settle hands the policy the CANONICAL resource key", () => {
  it("strips the query string, so a bound merchant is scored BOUND", async () => {
    const seen = await settleWith(`${CANONICAL}?symbol=AAPL&ts=1`);
    expect(seen, "the policy must have been consulted").toHaveLength(1);
    expect(seen[0]!.resourceUrl, "budget key must be canonical").toBe(CANONICAL);
    expect(
      seen[0]!.bound,
      "a query string must not drop a bound merchant into the unbound pool",
    ).toBe(true);
  });

  it("collapses query variants onto ONE budget key", async () => {
    // Otherwise the per-URL budget is trivially multiplied by varying the query.
    const a = await settleWith(`${CANONICAL}?i=1`);
    const b = await settleWith(`${CANONICAL}?i=2`);
    expect(a[0]!.resourceUrl).toBe(b[0]!.resourceUrl);
  });

  it("does not mark an unrelated resource bound", async () => {
    const seen = await settleWith("https://evil.example/quote?i=1");
    expect(seen[0]!.resourceUrl).toBe("https://evil.example/quote");
    expect(seen[0]!.bound).toBe(false);
  });

  it("still consults the policy when the payload carries no resource url", async () => {
    // D3: the policy must run unconditionally, or an omitted url would skip the
    // global ceiling entirely.
    const seen = await settleWith("");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.bound).toBe(false);
  });
});
