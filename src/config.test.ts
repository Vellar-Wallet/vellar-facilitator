import { describe, expect, it } from "vitest";
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

  // The invariant that matters: the ceiling must clear the real cost of a
  // policy-governed smart-account settlement. Measured on testnet from the
  // dedicated facilitator sponsor's own history, the worst REAL settlement was
  // 127,808 stroops (higher-fee txs on dev accounts are contract deploys and
  // add_signer calls, which never flow through /settle). 500k is ~3.9x that and
  // 2.5x the documented 200k floor — while cutting worst-case sponsor drain per
  // settle from 0.2 XLM to 0.05 XLM.
  it("fee ceiling default clears the worst observed real settlement (127,808 stroops)", () => {
    const config = loadConfig({ SPONSOR_SECRET_KEY: SECRET });
    expect(config.maxTransactionFeeStroops).toBeGreaterThan(127_808);
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
      rateMax: 30,
      rateWindowMs: 60_000,
      ceilingStroops: 50_000_000,
      windowMs: 60_000,
    });
    const over = loadConfig({
      SPONSOR_SECRET_KEY: SECRET,
      SETTLE_RATE_MAX: "10",
      SPEND_CEILING_STROOPS: "1000000",
    });
    expect(over.spend.rateMax).toBe(10);
    expect(over.spend.ceilingStroops).toBe(1_000_000);
  });

  it("defaults sponsor balance floors and honors overrides", () => {
    const def = loadConfig({ SPONSOR_SECRET_KEY: SECRET });
    expect(def.balance).toEqual({
      softFloorStroops: 100_000_000,
      hardFloorStroops: 20_000_000,
      intervalMs: 60_000,
    });
    const over = loadConfig({ SPONSOR_SECRET_KEY: SECRET, SPONSOR_HARD_FLOOR_STROOPS: "5000000" });
    expect(over.balance.hardFloorStroops).toBe(5_000_000);
  });

  it("rejects a non-positive spend limit", () => {
    expect(() => loadConfig({ SPONSOR_SECRET_KEY: SECRET, SETTLE_RATE_MAX: "0" })).toThrow(
      /SETTLE_RATE_MAX/,
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
