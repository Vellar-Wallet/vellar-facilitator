import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

const SECRET = "SBJP6HHFTABK2GXVVFAKY6C4B7DDNB5PIEQXKUNL2ZAOBPWFOUOSTLVNMA";
// A real, publicly-documented testnet contract address (docs/upto-deployment.md) — used
// here only as a syntactically valid C… value, not to imply this config points at it.
const VALID_CONTRACT_ID = "CDHPA64M73TUTEM4MMHIWIXINBQXH7JJXFGZMGH22VJWFJFROMR6QV2S";

describe("loadConfig", () => {
  it("throws without SPONSOR_SECRET_KEY", async () => {
    expect(() => loadConfig({})).toThrow(/SPONSOR_SECRET_KEY is required/);
  });

  it("defaults to testnet, port 4100, and a policy-sized fee ceiling", async () => {
    const config = loadConfig({ SPONSOR_SECRET_KEY: SECRET });
    expect(config.network).toBe("stellar:testnet");
    expect(config.port).toBe(4100);
    expect(config.maxTransactionFeeStroops).toBe(500_000);
    expect(config.rpcUrl).toBeUndefined();
  });

  // The invariant that matters: the ceiling must clear the BID — the
  // simulation-derived fee (minResourceFee + BASE_FEE) that @x402/stellar
  // compares against. It never sees the CHARGED fee, so sizing this against the
  // charge would tighten it by ~31% against a number it does not consume. See
  // the three-quantities note in src/config.ts.
  //
  // Two bids, with their provenance deliberately kept distinct:
  //   32,655  MEASURED, two independent simulations of the walkthrough wallet.
  //           Hashless, and necessarily so — an unsubmitted bid leaves no chain
  //           record. 500k clears it 15.3x.
  //  127,808  CITED as the worst case for a heavier policy contract. NO HASH and
  //          never re-derived; retained because it is conservative, NOT because
  //          it is verified. 500k clears it 3.9x.
  // Plus 2.5x the documented 200k floor, and worst-case sponsor drain per settle
  // capped at 0.05 XLM.
  it("fee ceiling default clears both the measured bid and the cited worst-case bid", async () => {
    const config = loadConfig({ SPONSOR_SECRET_KEY: SECRET });
    expect(config.maxTransactionFeeStroops).toBeGreaterThan(32_655); // measured bid
    expect(config.maxTransactionFeeStroops).toBeGreaterThan(127_808); // cited, unverified
    expect(config.maxTransactionFeeStroops).toBeGreaterThanOrEqual(200_000); // documented floor
  });

  it("selects pubnet when STELLAR_NETWORK=pubnet", async () => {
    const config = loadConfig({ SPONSOR_SECRET_KEY: SECRET, STELLAR_NETWORK: "pubnet" });
    expect(config.network).toBe("stellar:pubnet");
  });

  it("honors PORT, STELLAR_RPC_URL, MAX_TX_FEE_STROOPS overrides", async () => {
    const config = loadConfig({
      SPONSOR_SECRET_KEY: SECRET,
      PORT: "5000",
      STELLAR_RPC_URL: "https://rpc.example.com",
      MAX_TX_FEE_STROOPS: "500000",
    });
    expect(config.port).toBe(5000);
    expect(config.rpcUrl).toBe("https://rpc.example.com");
    expect(config.maxTransactionFeeStroops).toBe(500_000);
  });

  it("defaults spend-policy limits and honors overrides", async () => {
    const def = loadConfig({ SPONSOR_SECRET_KEY: SECRET });
    expect(def.spend).toEqual({
      rateWindowMs: 60_000,
      ceilingStroops: 50_000_000,
      perUrlMax: 10,
      perPayToMax: 50,
      unboundPoolMax: 10,
      windowMs: 60_000,
    });
    const over = loadConfig({
      SPONSOR_SECRET_KEY: SECRET,
      SETTLE_PER_PAYTO_MAX: "10",
      SPEND_CEILING_STROOPS: "1000000",
    });
    expect(over.spend.perPayToMax).toBe(10);
    expect(over.spend.ceilingStroops).toBe(1_000_000);
  });

  it("defaults sponsor balance floors and honors overrides", async () => {
    const def = loadConfig({ SPONSOR_SECRET_KEY: SECRET });
    expect(def.balance).toEqual({
      softFloorStroops: 250_000_000, // 25 XLM warn
      hardFloorStroops: 100_000_000, // 10 XLM refuse — must exceed the 5 XLM window ceiling
      intervalMs: 60_000,
    });
    const over = loadConfig({ SPONSOR_SECRET_KEY: SECRET, SPONSOR_HARD_FLOOR_STROOPS: "5000000" });
    expect(over.balance.hardFloorStroops).toBe(5_000_000);
  });

  // Re-audit: the sponsor hard floor must exceed the maximum XLM one spend
  // window can drain, or the balance check (which is up to one interval stale)
  // can read "above floor" and then be drained straight through it.
  it("ships defaults where the hard floor outlasts a full spend window", async () => {
    const c = loadConfig({ SPONSOR_SECRET_KEY: SECRET });
    expect(c.balance.hardFloorStroops).toBeGreaterThan(c.spend.ceilingStroops);
  });

  it("warns when an operator configures a floor a spend window can breach", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig({
      SPONSOR_SECRET_KEY: SECRET,
      SPEND_CEILING_STROOPS: "50000000", // 5 XLM per window
      SPONSOR_HARD_FLOOR_STROOPS: "20000000", // 2 XLM — cannot hold
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/hard floor.*spend ceiling|cannot hold/i));
    warn.mockRestore();
  });

  it("rejects a non-positive spend limit", async () => {
    // SETTLE_RATE_MAX is retired (it shadowed SETTLE_PER_PAYTO_MAX); validation
    // coverage moves to the surviving name rather than disappearing with it.
    expect(() => loadConfig({ SPONSOR_SECRET_KEY: SECRET, SETTLE_PER_PAYTO_MAX: "0" })).toThrow(
      /SETTLE_PER_PAYTO_MAX/,
    );
    expect(() => loadConfig({ SPONSOR_SECRET_KEY: SECRET, SPEND_CEILING_STROOPS: "-1" })).toThrow(
      /SPEND_CEILING_STROOPS/,
    );
  });

  it("rejects a non-integer or non-positive fee ceiling", async () => {
    expect(() => loadConfig({ SPONSOR_SECRET_KEY: SECRET, MAX_TX_FEE_STROOPS: "abc" })).toThrow(
      /MAX_TX_FEE_STROOPS/,
    );
    expect(() => loadConfig({ SPONSOR_SECRET_KEY: SECRET, MAX_TX_FEE_STROOPS: "0" })).toThrow(
      /MAX_TX_FEE_STROOPS/,
    );
    expect(() => loadConfig({ SPONSOR_SECRET_KEY: SECRET, MAX_TX_FEE_STROOPS: "-5" })).toThrow(
      /MAX_TX_FEE_STROOPS/,
    );
  });

  describe("bond-escrow", () => {
    const ADMIN_SECRET = Keypair.random().secret();

    it("defaults both to undefined when unset — bonding entirely inactive", async () => {
      const config = loadConfig({ SPONSOR_SECRET_KEY: SECRET });
      expect(config.bondEscrowContractId).toBeUndefined();
      expect(config.bondEscrowAdminSecretKey).toBeUndefined();
    });

    it("accepts both set together", async () => {
      const config = loadConfig({
        SPONSOR_SECRET_KEY: SECRET,
        BOND_ESCROW_CONTRACT_ID: VALID_CONTRACT_ID,
        BOND_ESCROW_ADMIN_SECRET_KEY: ADMIN_SECRET,
      });
      expect(config.bondEscrowContractId).toBe(VALID_CONTRACT_ID);
      expect(config.bondEscrowAdminSecretKey).toBe(ADMIN_SECRET);
    });

    it("rejects a malformed contract ID — wrong prefix, wrong length, and garbage", async () => {
      expect(() =>
        loadConfig({
          SPONSOR_SECRET_KEY: SECRET,
          BOND_ESCROW_CONTRACT_ID: "not-a-contract-id",
          BOND_ESCROW_ADMIN_SECRET_KEY: ADMIN_SECRET,
        }),
      ).toThrow(/BOND_ESCROW_CONTRACT_ID/);
      expect(() =>
        loadConfig({
          SPONSOR_SECRET_KEY: SECRET,
          // A valid-looking secret key in the contract-ID slot — wrong prefix (S, not C).
          BOND_ESCROW_CONTRACT_ID: ADMIN_SECRET,
          BOND_ESCROW_ADMIN_SECRET_KEY: ADMIN_SECRET,
        }),
      ).toThrow(/BOND_ESCROW_CONTRACT_ID/);
      expect(() =>
        loadConfig({
          SPONSOR_SECRET_KEY: SECRET,
          BOND_ESCROW_CONTRACT_ID: VALID_CONTRACT_ID.slice(0, -1), // one char short
          BOND_ESCROW_ADMIN_SECRET_KEY: ADMIN_SECRET,
        }),
      ).toThrow(/BOND_ESCROW_CONTRACT_ID/);
    });

    it("rejects a malformed admin secret key — wrong prefix and wrong length", async () => {
      expect(() =>
        loadConfig({
          SPONSOR_SECRET_KEY: SECRET,
          BOND_ESCROW_CONTRACT_ID: VALID_CONTRACT_ID,
          BOND_ESCROW_ADMIN_SECRET_KEY: "not-a-secret-key",
        }),
      ).toThrow(/BOND_ESCROW_ADMIN_SECRET_KEY/);
      expect(() =>
        loadConfig({
          SPONSOR_SECRET_KEY: SECRET,
          BOND_ESCROW_CONTRACT_ID: VALID_CONTRACT_ID,
          // A valid-looking contract ID in the secret-key slot — wrong prefix (C, not S).
          BOND_ESCROW_ADMIN_SECRET_KEY: VALID_CONTRACT_ID,
        }),
      ).toThrow(/BOND_ESCROW_ADMIN_SECRET_KEY/);
    });

    it("rejects the contract ID set without the admin key", async () => {
      expect(() =>
        loadConfig({ SPONSOR_SECRET_KEY: SECRET, BOND_ESCROW_CONTRACT_ID: VALID_CONTRACT_ID }),
      ).toThrow(/BOND_ESCROW_CONTRACT_ID.*BOND_ESCROW_ADMIN_SECRET_KEY|must be set together/);
    });

    it("rejects the admin key set without the contract ID", async () => {
      expect(() =>
        loadConfig({ SPONSOR_SECRET_KEY: SECRET, BOND_ESCROW_ADMIN_SECRET_KEY: ADMIN_SECRET }),
      ).toThrow(/BOND_ESCROW_CONTRACT_ID.*BOND_ESCROW_ADMIN_SECRET_KEY|must be set together/);
    });

    it("treats an empty string the same as unset for both", async () => {
      const config = loadConfig({
        SPONSOR_SECRET_KEY: SECRET,
        BOND_ESCROW_CONTRACT_ID: "",
        BOND_ESCROW_ADMIN_SECRET_KEY: "",
      });
      expect(config.bondEscrowContractId).toBeUndefined();
      expect(config.bondEscrowAdminSecretKey).toBeUndefined();
    });
  });
});
