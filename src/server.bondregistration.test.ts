import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { buildFacilitator } from "./facilitator.js";
import { buildServer } from "./server.js";
import type { RegisterSettlementResult } from "./bond.js";
import { fakeChannelAccountSecretKeys } from "./testChannelPoolKeys.js";

// The full live sequence (register_settlement's real network path) is proven by
// docs/bond-escrow-deployment.md — every entry point, real ledger time, every transaction
// independently confirmed on Horizon. This file tests the layer around that call: does
// /settle actually invoke registration when configured, does it stay silent when not, and
// does each of registerSettlement's possible outcomes produce the exact /settle response
// this was specified to produce. registerSettlement itself is mocked — a separate file
// (src/bond.test.ts) covers its own internal behavior.
//
// Isolated in its own file, matching the existing server.pagination.test.ts /
// server.policykey.test.ts / server.health.test.ts convention, specifically so the
// module-level mock of ./bond.js below only ever applies to these tests, never to the much
// larger, already-passing server.test.ts.

vi.mock("./bond.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bond.js")>();
  return { ...actual, registerSettlement: vi.fn() };
});
const { registerSettlement } = await import("./bond.js");
const registerSettlementMock = vi.mocked(registerSettlement);

const testConfig = {
  port: 0,
  host: "127.0.0.1",
  network: "stellar:testnet" as const,
  rpcUrl: undefined,
  sponsorSecretKey: Keypair.random().secret(),
  channelAccountSecretKeys: fakeChannelAccountSecretKeys(),
  maxTransactionFeeStroops: 2_000_000,
  catalogDbUrl: undefined,
  uptoContractId: undefined,
  bondEscrowContractId: undefined,
  bondEscrowAdminSecretKey: undefined,
  catalogDbAuthToken: undefined,
  verificationApiUrl: undefined,
  spend: { rateWindowMs: 60_000, ceilingStroops: 50_000_000, windowMs: 60_000, perUrlMax: 10, perPayToMax: 100, unboundPoolMax: 10 },
  balance: { softFloorStroops: 100_000_000, hardFloorStroops: 20_000_000, intervalMs: 60_000 },
};

const BOND_ESCROW_OPTIONS = {
  contractId: "CAWQ2FJDPWHOFLYQIPKBU4M6IE4GUROKUKVVZERWQVD2DHP7S2CULTI4", // the real deployed instance
  adminSecretKey: Keypair.random().secret(),
  network: "stellar:testnet" as const,
  rpcUrl: undefined,
  maxTransactionFeeStroops: 500_000,
};

const PAYER = Keypair.random().publicKey();
const SETTLED_TX_HASH = "b".repeat(64); // 32 bytes hex — the paymentId registerSettlement would receive

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

// A structurally VALID transaction envelope (same one server.test.ts uses) — /settle
// shreds unparseable XDR at the route before ever reaching facilitator.settle.
const VALID_TX_XDR =
  "AAAAAgAAAAARUqIOOVQYwBn0s32MhGQwyoTHPy7SzjfXdweAw6b/4gAAAGQAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAABqdyAuAAAAAAAAAAEAAAAAAAAAAQAAAADrmp8rY1JU7CL78HNaROud45MqVmrrbxOCVuWSEz0eRwAAAAAAAAAAAJiWgAAAAAAAAAAA";

const RESOURCE_URL = "https://api.example.com/quote";

function settleBody() {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network: "stellar:testnet",
      payload: { transaction: VALID_TX_XDR },
      resource: { url: RESOURCE_URL },
    },
    paymentRequirements: requirements(),
  };
}

/** A successful settle result — the ONE condition under which bond registration runs at
 *  all. Real facilitator.settle is stubbed rather than actually reaching Soroban RPC,
 *  matching how a genuine success is otherwise unreachable in a unit test (no existing test
 *  in server.test.ts achieves success:true either, for the same reason). */
async function appWithStubbedSuccess(bondEscrow?: typeof BOND_ESCROW_OPTIONS) {
  const built = buildFacilitator(testConfig);
  vi.spyOn(built.facilitator, "settle").mockResolvedValue({
    success: true,
    transaction: SETTLED_TX_HASH,
    payer: PAYER,
    network: "stellar:testnet",
  } as never);
  const app = await buildServer(
    built,
    await BazaarCatalog.create(),
    undefined,
    undefined,
    {},
    undefined,
    "stellar:testnet",
    bondEscrow,
  );
  await app.ready();
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
  registerSettlementMock.mockReset();
});

describe("/settle — bond registration is entirely inactive when unconfigured", () => {
  it("never calls registerSettlement when bondEscrow is undefined, even on a real success", async () => {
    const app = await appWithStubbedSuccess(undefined);
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      expect(registerSettlementMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("/settle — bond registration outcomes, each producing the specified response", () => {
  it("outcome 'registered' — settle reports success normally", async () => {
    registerSettlementMock.mockResolvedValue({
      outcome: "registered",
      transaction: "c".repeat(64),
    } satisfies RegisterSettlementResult);
    const app = await appWithStubbedSuccess(BOND_ESCROW_OPTIONS);
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.transaction).toBe(SETTLED_TX_HASH);
      expect(registerSettlementMock).toHaveBeenCalledWith(BOND_ESCROW_OPTIONS, {
        paymentId: SETTLED_TX_HASH,
        payer: PAYER,
        seller: requirements().payTo,
        // Canonicalized per BazaarCatalog.canonicalResourceKey — origin + normalized path,
        // proving the real canonicalization ran, not just a raw passthrough of RESOURCE_URL.
        resourceKey: "https://api.example.com/quote",
        amount: requirements().amount,
      });
    } finally {
      await app.close();
    }
  });

  it("outcome 'infrastructure_error' — 503, names bond registration, keeps the real transaction hash", async () => {
    registerSettlementMock.mockResolvedValue({
      outcome: "infrastructure_error",
      detail: "ECONNREFUSED",
    } satisfies RegisterSettlementResult);
    const app = await appWithStubbedSuccess(BOND_ESCROW_OPTIONS);
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBe("bond_registration_failed");
      expect(body.reason).toBe("ECONNREFUSED");
      // The real settlement outcome is not hidden behind the 503 — money moved.
      expect(body.transaction).toBe(SETTLED_TX_HASH);
    } finally {
      await app.close();
    }
  });

  it("outcome 'rejected' with SettlementAlreadyRegistered — NOT fatal, settle still succeeds", async () => {
    registerSettlementMock.mockResolvedValue({
      outcome: "rejected",
      detail: "SettlementAlreadyRegistered",
      contractErrorCode: 3,
    } satisfies RegisterSettlementResult);
    const app = await appWithStubbedSuccess(BOND_ESCROW_OPTIONS);
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.transaction).toBe(SETTLED_TX_HASH);
    } finally {
      await app.close();
    }
  });

  it("outcome 'rejected' with any other code — 500, carries the parsed error code", async () => {
    registerSettlementMock.mockResolvedValue({
      outcome: "rejected",
      detail: "InvalidAmount",
      contractErrorCode: 4,
    } satisfies RegisterSettlementResult);
    const app = await appWithStubbedSuccess(BOND_ESCROW_OPTIONS);
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBe("bond_registration_failed");
      expect(body.reason).toBe("InvalidAmount");
      expect(body.contractErrorCode).toBe(4);
      expect(body.transaction).toBe(SETTLED_TX_HASH);
    } finally {
      await app.close();
    }
  });

  it("a rejected result with NO contractErrorCode (an auth-shaped trap) is treated as 'any other' — 500, not silently swallowed", async () => {
    registerSettlementMock.mockResolvedValue({
      outcome: "rejected",
      detail: "HostError: Error(Auth, InvalidAction)",
    } satisfies RegisterSettlementResult);
    const app = await appWithStubbedSuccess(BOND_ESCROW_OPTIONS);
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).contractErrorCode).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("registerSettlement throwing is caught and reported as 503, never crashes the request", async () => {
    registerSettlementMock.mockRejectedValue(new Error("[bond] paymentId must be 32 bytes"));
    const app = await appWithStubbedSuccess(BOND_ESCROW_OPTIONS);
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.reason).toContain("paymentId must be 32 bytes");
      expect(body.transaction).toBe(SETTLED_TX_HASH);
    } finally {
      await app.close();
    }
  });
});

describe("/settle — the missing_payer_or_seller guard", () => {
  it("returns 503 with reason missing_payer_or_seller when result.payer is undefined on a stubbed success", async () => {
    // "Should be impossible on a successful settlement" per the code's own comment — this
    // forces the branch anyway, since "should be impossible" earned an explicit guard
    // rather than being assumed, and an explicit guard is worth an explicit test.
    //
    // A dedicated inline stub, not the shared appWithStubbedSuccess helper: a default
    // parameter there can't distinguish "omitted" from "explicitly undefined" (JS applies
    // the default either way), so this needs its own setup rather than a payer-override
    // argument that would silently do nothing.
    const built = buildFacilitator(testConfig);
    vi.spyOn(built.facilitator, "settle").mockResolvedValue({
      success: true,
      transaction: SETTLED_TX_HASH,
      payer: undefined,
      network: "stellar:testnet",
    } as never);
    const app = await buildServer(
      built,
      await BazaarCatalog.create(),
      undefined,
      undefined,
      {},
      undefined,
      "stellar:testnet",
      BOND_ESCROW_OPTIONS,
    );
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBe("bond_registration_failed");
      expect(body.reason).toBe("missing_payer_or_seller");
      expect(body.transaction).toBe(SETTLED_TX_HASH);
      expect(registerSettlementMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("/settle — bond registration is skipped on a failed settlement", () => {
  it("does not call registerSettlement when the settlement itself did not succeed", async () => {
    const built = buildFacilitator(testConfig);
    vi.spyOn(built.facilitator, "settle").mockResolvedValue({
      success: false,
      transaction: "",
      network: "stellar:testnet",
      errorReason: "settle_exact_stellar_transaction_failed",
    } as never);
    const app = await buildServer(
      built,
      await BazaarCatalog.create(),
      undefined,
      undefined,
      {},
      undefined,
      "stellar:testnet",
      BOND_ESCROW_OPTIONS,
    );
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      expect(res.statusCode).toBe(200); // failed settle is still a conformant 200 x402 response
      expect(JSON.parse(res.body).success).toBe(false);
      expect(registerSettlementMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
