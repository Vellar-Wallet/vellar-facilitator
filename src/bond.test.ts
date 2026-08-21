import { describe, expect, it } from "vitest";
import { Account, Keypair } from "@stellar/stellar-sdk";
import { registerSettlement, type BondEscrowOptions, type BondEscrowRpcLike } from "./bond.js";

// register_settlement's live path (simulate → sign → submit → confirm) is proven by the
// deployment record (docs/bond-escrow-deployment.md — a full register_settlement →
// deposit → file_dispute → wait → finalize sequence, every transaction independently
// confirmed on Horizon). These tests pin what this TS wiring layer does BEFORE and AROUND
// that network round-trip: caller-bug validation, which key actually signs, and the
// rejected/infrastructure_error split — mirroring upto.test.ts's own philosophy of testing
// the gate rather than re-proving the network path a real deployment already proved.

const CONTRACT = "CAWQ2FJDPWHOFLYQIPKBU4M6IE4GUROKUKVVZERWQVD2DHP7S2CULTI4"; // the real deployed instance
const adminKp = Keypair.random();
const sponsorKp = Keypair.random(); // NEVER passed to registerSettlement — see "which key signs" below
const PAYER = Keypair.random().publicKey();
const SELLER = Keypair.random().publicKey();
const VALID_PAYMENT_ID = "a".repeat(64); // 32 bytes, hex

function options(overrides: Partial<BondEscrowOptions> = {}): BondEscrowOptions {
  return {
    contractId: CONTRACT,
    adminSecretKey: adminKp.secret(),
    network: "stellar:testnet",
    maxTransactionFeeStroops: 500_000,
    ...overrides,
  };
}

function validParams() {
  return {
    paymentId: VALID_PAYMENT_ID,
    payer: PAYER,
    seller: SELLER,
    resourceKey: "https://example.com/quote",
    amount: "500000",
  };
}

const unreachableServer: BondEscrowRpcLike = {
  getAccount: async () => {
    throw new Error("must never be reached in caller-bug-validation tests");
  },
  simulateTransaction: async () => {
    throw new Error("must never be reached");
  },
  sendTransaction: async () => {
    throw new Error("must never be reached");
  },
  getTransaction: async () => {
    throw new Error("must never be reached");
  },
};

describe("registerSettlement — caller-bug validation, thrown before any network call", () => {
  it("rejects a paymentId that is not 32 bytes", async () => {
    await expect(
      registerSettlement(options(), { ...validParams(), paymentId: "abcd" }, { server: unreachableServer }),
    ).rejects.toThrow(/paymentId must be 32 bytes/);
  });

  it("rejects a paymentId that is not valid hex", async () => {
    await expect(
      registerSettlement(
        options(),
        { ...validParams(), paymentId: "z".repeat(64) },
        { server: unreachableServer },
      ),
    ).rejects.toThrow(/paymentId must be 32 bytes/); // Buffer.from(..., "hex") silently drops invalid chars, shrinking length
  });

  it("rejects a malformed payer address", async () => {
    await expect(
      registerSettlement(options(), { ...validParams(), payer: "not-an-address" }, { server: unreachableServer }),
    ).rejects.toThrow(/not a valid Stellar address/);
  });

  it("rejects a malformed seller address", async () => {
    await expect(
      registerSettlement(options(), { ...validParams(), seller: "not-an-address" }, { server: unreachableServer }),
    ).rejects.toThrow(/not a valid Stellar address/);
  });

  it("rejects a zero or negative amount", async () => {
    await expect(
      registerSettlement(options(), { ...validParams(), amount: "0" }, { server: unreachableServer }),
    ).rejects.toThrow(/amount must be a positive integer/);
    await expect(
      registerSettlement(options(), { ...validParams(), amount: "-1" }, { server: unreachableServer }),
    ).rejects.toThrow(/amount must be a positive integer/);
  });

  it("rejects an empty resourceKey", async () => {
    await expect(
      registerSettlement(options(), { ...validParams(), resourceKey: "" }, { server: unreachableServer }),
    ).rejects.toThrow(/resourceKey must not be empty/);
  });
});

describe("registerSettlement — which key signs", () => {
  it("derives the signing/source identity from adminSecretKey, never a sponsor key", async () => {
    // getAccount(admin.publicKey()) is the first network call registerSettlement makes,
    // reached even when simulation subsequently fails — genuinely exercising the code path
    // that decides whose account this call is built from and who will sign it, not just
    // asserting the two keypairs happen to differ.
    let accountRequestedFor: string | undefined;
    const server: BondEscrowRpcLike = {
      getAccount: async (address) => {
        accountRequestedFor = address;
        return new Account(address, "0");
      },
      simulateTransaction: async () =>
        ({ error: "HostError: Error(Auth, InvalidAction)", events: [], id: "1", latestLedger: 1 }) as never,
      sendTransaction: async () => {
        throw new Error("must not be reached — simulation already failed");
      },
      getTransaction: async () => {
        throw new Error("must not be reached");
      },
    };
    await registerSettlement(options(), validParams(), { server });
    expect(accountRequestedFor).toBe(adminKp.publicKey());
    expect(accountRequestedFor).not.toBe(sponsorKp.publicKey());
  });

  it("a config built with the sponsor key in adminSecretKey's slot would sign with the sponsor — proving the field is what's read, not a hidden default", async () => {
    // Not an endorsement of doing this — the opposite: it shows registerSettlement has no
    // independent notion of "the real admin," it trusts whatever secret is in
    // opts.adminSecretKey completely. The separation this codebase relies on is enforced by
    // src/config.ts validating two distinct env vars into two distinct fields (see
    // config.test.ts's bond-escrow describe block), not by anything in this file refusing a
    // wrong key — worth being honest that the guarantee lives one layer up.
    let accountRequestedFor: string | undefined;
    const server: BondEscrowRpcLike = {
      getAccount: async (address) => {
        accountRequestedFor = address;
        return new Account(address, "0");
      },
      simulateTransaction: async () =>
        ({ error: "HostError: Error(Auth, InvalidAction)", events: [], id: "1", latestLedger: 1 }) as never,
      sendTransaction: async () => {
        throw new Error("must not be reached");
      },
      getTransaction: async () => {
        throw new Error("must not be reached");
      },
    };
    await registerSettlement(options({ adminSecretKey: sponsorKp.secret() }), validParams(), { server });
    expect(accountRequestedFor).toBe(sponsorKp.publicKey());
  });

  it("BondEscrowOptions has no field a sponsor key could be passed through — structural guarantee", () => {
    // TypeScript-level proof: this compiles only because `sponsorSecretKey` is not a key of
    // BondEscrowOptions at all. If someone ever adds one, this line stops compiling and the
    // test suite catches the regression at typecheck time, not just at review time.
    const opts = options();
    // @ts-expect-error — BondEscrowOptions has no sponsorSecretKey field, by design.
    opts.sponsorSecretKey = sponsorKp.secret();
    expect(opts.adminSecretKey).toBe(adminKp.secret());
  });
});

describe("registerSettlement — rejected vs infrastructure_error", () => {
  function serverWithSimError(errorMessage: string): BondEscrowRpcLike {
    return {
      getAccount: async (address) => new Account(address, "0"),
      simulateTransaction: async () =>
        ({ error: errorMessage, events: [], id: "1", latestLedger: 1 }) as never,
      sendTransaction: async () => {
        throw new Error("must not be reached — simulation already failed");
      },
      getTransaction: async () => {
        throw new Error("must not be reached");
      },
    };
  }

  it("maps a recognized Error(Contract, #N) to a named rejection with its code", async () => {
    const result = await registerSettlement(options(), validParams(), {
      server: serverWithSimError("HostError: Error(Contract, #3)"),
    });
    expect(result).toEqual({
      outcome: "rejected",
      detail: "SettlementAlreadyRegistered",
      contractErrorCode: 3,
    });
  });

  it("maps NotInitialized (#2) and InvalidAmount (#4) too", async () => {
    const notInit = await registerSettlement(options(), validParams(), {
      server: serverWithSimError("HostError: Error(Contract, #2)"),
    });
    expect(notInit).toEqual({ outcome: "rejected", detail: "NotInitialized", contractErrorCode: 2 });

    const invalidAmount = await registerSettlement(options(), validParams(), {
      server: serverWithSimError("HostError: Error(Contract, #4)"),
    });
    expect(invalidAmount).toEqual({
      outcome: "rejected",
      detail: "InvalidAmount",
      contractErrorCode: 4,
    });
  });

  it("falls back to a generic 'unknown contract error' for an unrecognized code, not a crash", async () => {
    const result = await registerSettlement(options(), validParams(), {
      server: serverWithSimError("HostError: Error(Contract, #99)"),
    });
    expect(result).toEqual({
      outcome: "rejected",
      detail: "unknown contract error #99",
      contractErrorCode: 99,
    });
  });

  it("treats an auth-shaped trap (no Error(Contract,...) match) as rejected with the raw detail", async () => {
    const result = await registerSettlement(options(), validParams(), {
      server: serverWithSimError("HostError: Error(Auth, InvalidAction)"),
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.contractErrorCode).toBeUndefined();
      expect(result.detail).toContain("Error(Auth, InvalidAction)");
    }
  });

  it("reports a thrown network exception as infrastructure_error, not rejected", async () => {
    const server: BondEscrowRpcLike = {
      getAccount: async () => {
        throw new Error("ECONNREFUSED");
      },
      simulateTransaction: unreachableServer.simulateTransaction,
      sendTransaction: unreachableServer.sendTransaction,
      getTransaction: unreachableServer.getTransaction,
    };
    const result = await registerSettlement(options(), validParams(), { server });
    expect(result.outcome).toBe("infrastructure_error");
    if (result.outcome === "infrastructure_error") {
      expect(result.detail).toContain("ECONNREFUSED");
    }
  });

  // NOT independently unit-tested here, and deliberately not faked with a placeholder
  // assertion: everything past a successful simulation — assembleTransaction's fee/resource
  // handling, a real submission, polling to confirmation, and the true happy path — needs a
  // genuinely SDK-shaped SimulateTransactionSuccessResponse (real transactionData XDR, a
  // real footprint) to exercise honestly. Hand-building that XDR just to satisfy a mock
  // would be effort spent reproducing what a real RPC already does, for a test that still
  // wouldn't prove anything a hand-crafted mock couldn't be made to say. upto.test.ts made
  // the same call for the same reason (see this file's header comment) and instead points at
  // a real deployment record as the proof. This file does the same:
  // docs/bond-escrow-deployment.md's full register_settlement → deposit → file_dispute →
  // wait → finalize sequence, every transaction independently confirmed on Horizon, is that
  // proof for the submission/confirmation/happy-path behavior this describe block would
  // otherwise need to fake.
});
