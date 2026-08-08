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
    expect(config.maxTransactionFeeStroops).toBe(2_000_000);
    expect(config.rpcUrl).toBeUndefined();
  });

  it("fee ceiling default clears the policy-governed payment cost (~140k stroops)", () => {
    const config = loadConfig({ SPONSOR_SECRET_KEY: SECRET });
    expect(config.maxTransactionFeeStroops).toBeGreaterThan(140_000);
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
