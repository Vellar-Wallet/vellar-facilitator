import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { buildFacilitator } from "./facilitator.js";
import { buildServer } from "./server.js";
import { fakeChannelAccountSecretKeys } from "./testChannelPoolKeys.js";
import { VALID_TX_XDR, distinctValidTxXdr } from "./testSettleXdr.js";

// The /settle idempotency guard (2026-09-19 incident, docs referenced in
// src/server.ts's settleDedup doc comment): a caller sending the SAME signed
// transaction envelope twice — a dashboard double-click, a network-level
// resend, or the client library's own retry racing its first attempt — must
// not independently re-run the whole verify -> sign -> fee-bump -> submit ->
// poll pipeline a second time. The second call should await the first's
// in-flight result instead.
//
// Isolated in its own file, matching this codebase's one-concern-per-file
// test convention (server.policykey.test.ts, server.extension-responses.test.ts,
// server.bondregistration.test.ts, ...).

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
const SETTLED_TX_HASH = "c".repeat(64);

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

function settleBody(txXdr: string = VALID_TX_XDR) {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network: "stellar:testnet",
      payload: { transaction: txXdr },
    },
    paymentRequirements: requirements(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/settle idempotency guard", () => {
  it("a second call with the SAME envelope awaits the first's result instead of re-invoking facilitator.settle", async () => {
    const built = buildFacilitator(testConfig);
    // Resolves only when releaseFirst() is called — lets the test fire the
    // second request WHILE the first is still genuinely in flight, the exact
    // race the 2026-09-19 incident hinged on (req-6t landed 29s into req-6c,
    // well before req-6c's own 34.3s completion).
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const settleSpy = vi.spyOn(built.facilitator, "settle").mockImplementation(async () => {
      await gate;
      return {
        success: true,
        transaction: SETTLED_TX_HASH,
        payer: PAYER,
        network: "stellar:testnet",
      } as never;
    });
    const app = await buildServer(built, await BazaarCatalog.create());
    await app.ready();
    try {
      const body = settleBody();
      const first = app.inject({ method: "POST", url: "/settle", payload: body });
      // Give the first request's handler a tick to reach facilitator.settle()
      // and register itself in settleDedup BEFORE firing the duplicate —
      // matching the real incident's ordering (second request landed while
      // the first was genuinely mid-pipeline, not before it started).
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = app.inject({ method: "POST", url: "/settle", payload: body });

      expect(settleSpy).toHaveBeenCalledTimes(1);
      releaseFirst();

      const [firstRes, secondRes] = await Promise.all([first, second]);
      expect(settleSpy).toHaveBeenCalledTimes(1);
      expect(firstRes.statusCode).toBe(200);
      expect(secondRes.statusCode).toBe(200);
      expect(secondRes.json()).toEqual(firstRes.json());
    } finally {
      await app.close();
    }
  });

  it("a call with a DIFFERENT envelope is never deduped against an unrelated in-flight settle", async () => {
    const built = buildFacilitator(testConfig);
    const settleSpy = vi.spyOn(built.facilitator, "settle").mockImplementation(async (payload) => ({
      success: true,
      transaction: SETTLED_TX_HASH,
      payer: PAYER,
      network: "stellar:testnet",
    } as never));
    const app = await buildServer(built, await BazaarCatalog.create());
    await app.ready();
    try {
      const first = await app.inject({ method: "POST", url: "/settle", payload: settleBody() });
      const second = await app.inject({
        method: "POST",
        url: "/settle",
        payload: settleBody(distinctValidTxXdr(1)),
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      // Both calls genuinely reached the facilitator — no dedup collapsed them.
      expect(settleSpy).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("a rejected/thrown pipeline outcome is also cached and replayed, not silently swallowed", async () => {
    const built = buildFacilitator(testConfig);
    let calls = 0;
    const settleSpy = vi.spyOn(built.facilitator, "settle").mockImplementation(async () => {
      calls++;
      throw new Error("boom");
    });
    const app = await buildServer(built, await BazaarCatalog.create());
    await app.ready();
    try {
      const body = settleBody();
      const [first, second] = await Promise.all([
        app.inject({ method: "POST", url: "/settle", payload: body }),
        app.inject({ method: "POST", url: "/settle", payload: body }),
      ]);
      // Both requests observe the SAME thrown-pipeline outcome (Fastify's
      // default error response for an uncaught throw) — the second did not
      // independently re-invoke facilitator.settle and hit its own throw.
      expect(first.statusCode).toBe(second.statusCode);
      expect(calls).toBe(1);
      void settleSpy;
    } finally {
      await app.close();
    }
  });

  it("a fresh call for the SAME envelope after the dedup entry expires re-runs the pipeline", async () => {
    // Date.now() ONLY (not vi.useFakeTimers(), which also fakes setTimeout —
    // Fastify's own internals rely on real timers, so faking them hangs
    // app.inject entirely). settleDedup's expiry check is a plain
    // Date.now() comparison, so mocking just that is enough.
    const dateNowSpy = vi.spyOn(Date, "now");
    const built = buildFacilitator(testConfig);
    let calls = 0;
    vi.spyOn(built.facilitator, "settle").mockImplementation(async () => {
      calls++;
      return {
        success: true,
        transaction: SETTLED_TX_HASH,
        payer: PAYER,
        network: "stellar:testnet",
      } as never;
    });
    const app = await buildServer(built, await BazaarCatalog.create());
    await app.ready();
    try {
      const body = settleBody();
      const t0 = Date.now();
      dateNowSpy.mockReturnValue(t0);
      await app.inject({ method: "POST", url: "/settle", payload: body });
      expect(calls).toBe(1);
      // Past the dedup TTL (10 minutes) — a replay of the same envelope is
      // no longer treated as "the same in-flight/recent attempt".
      dateNowSpy.mockReturnValue(t0 + 11 * 60 * 1000);
      await app.inject({ method: "POST", url: "/settle", payload: body });
      expect(calls).toBe(2);
    } finally {
      await app.close();
    }
  });
});
