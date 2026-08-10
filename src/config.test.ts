import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

const SECRET = "SBJP6HHFTABK2GXVVFAKY6C4B7DDNB5PIEQXKUNL2ZAOBPWFOUOSTLVNMA";

describe("loadConfig", () => {
  it("throws without SPONSOR_SECRET_KEY", () => {
    expect(() => loadConfig({})).toThrow(/SPONSOR_SECRET_KEY is required/);
  });

  it("defaults to testnet, port 4100, and a policy-sized fee ceiling", () => {
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
  it("fee ceiling default clears both the measured bid and the cited worst-case bid", () => {
    const config = loadConfig({ SPONSOR_SECRET_KEY: SECRET });
    expect(config.maxTransactionFeeStroops).toBeGreaterThan(32_655); // measured bid
    expect(config.maxTransactionFeeStroops).toBeGreaterThan(127_808); // cited, unverified
    expect(config.maxTransactionFeeStroops).toBeGreaterThanOrEqual(200_000); // documented floor
  });

  it("selects pubnet when STELLAR_NETWORK=pubnet", () => {
    const config = loadConfig({ SPONSOR_SECRET_KEY: SECRET, STELLAR_NETWORK: "pubnet" });
    expect(config.network).toBe("stellar:pubnet");
  });

  it("honors PORT, STELLAR_RPC_URL, MAX_TX_FEE_STROOPS overrides", () => {
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

  it("defaults spend-policy limits and honors overrides", () => {
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

  it("defaults sponsor balance floors and honors overrides", () => {
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
  it("ships defaults where the hard floor outlasts a full spend window", () => {
    const c = loadConfig({ SPONSOR_SECRET_KEY: SECRET });
    expect(c.balance.hardFloorStroops).toBeGreaterThan(c.spend.ceilingStroops);
  });

  it("warns when an operator configures a floor a spend window can breach", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig({
      SPONSOR_SECRET_KEY: SECRET,
      SPEND_CEILING_STROOPS: "50000000", // 5 XLM per window
      SPONSOR_HARD_FLOOR_STROOPS: "20000000", // 2 XLM — cannot hold
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/hard floor.*spend ceiling|cannot hold/i));
    warn.mockRestore();
  });

  it("rejects a non-positive spend limit", () => {
    // SETTLE_RATE_MAX is retired (it shadowed SETTLE_PER_PAYTO_MAX); validation
    // coverage moves to the surviving name rather than disappearing with it.
    expect(() => loadConfig({ SPONSOR_SECRET_KEY: SECRET, SETTLE_PER_PAYTO_MAX: "0" })).toThrow(
      /SETTLE_PER_PAYTO_MAX/,
    );
    expect(() => loadConfig({ SPONSOR_SECRET_KEY: SECRET, SPEND_CEILING_STROOPS: "-1" })).toThrow(
      /SPEND_CEILING_STROOPS/,
    );
  });

  it("rejects a non-integer or non-positive fee ceiling", () => {
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
});
