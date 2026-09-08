import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_RPC, defaultRpcFor } from "./rpc-defaults.js";

// Issue #88. Three modules used to encode this pair independently and agreed
// only because f1d078b checked them by hand. The point of these tests is not
// that the map has the right contents, which is one assertion, but that NOTHING
// ELSE re-encodes it. A test that only checked DEFAULT_RPC's values would pass
// happily while a fourth copy drifted in some other file.
describe("DEFAULT_RPC", () => {
  it("has a default for both networks", () => {
    expect(DEFAULT_RPC["stellar:testnet"]).toBe("https://soroban-testnet.stellar.org");
    expect(DEFAULT_RPC["stellar:pubnet"]).toBe("https://mainnet.sorobanrpc.com");
  });

  it("defaultRpcFor resolves the same values", () => {
    expect(defaultRpcFor("stellar:testnet")).toBe(DEFAULT_RPC["stellar:testnet"]);
    expect(defaultRpcFor("stellar:pubnet")).toBe(DEFAULT_RPC["stellar:pubnet"]);
  });

  it("returns undefined for an unknown network rather than a wrong default", () => {
    // Silently falling back to testnet for an unrecognised network is how a
    // pubnet deployment ends up resolving trust against testnet.
    expect(defaultRpcFor("stellar:futurenet")).toBeUndefined();
  });

  it("testnet and pubnet do NOT share a URL", () => {
    // Guards the copy-paste failure this refactor is meant to make impossible:
    // one line edited, the other left pointing at the wrong network.
    expect(DEFAULT_RPC["stellar:testnet"]).not.toBe(DEFAULT_RPC["stellar:pubnet"]);
  });
});

// The enforcement half. This is what catches drift, and it works by reading the
// source rather than by importing, because a module that re-declares the URL
// locally would not expose anything for an import-based test to compare.
describe("no module re-encodes the RPC URLs", () => {
  const SOURCES = ["src/upto.ts", "src/bond.ts", "src/server.ts"];
  const URLS = ["https://soroban-testnet.stellar.org", "https://mainnet.sorobanrpc.com"];

  for (const file of SOURCES) {
    it(`${file} imports the shared map instead of hardcoding a URL`, () => {
      const src = readFileSync(file, "utf8");
      for (const url of URLS) {
        expect(src, `${file} hardcodes ${url}; import it from ./rpc-defaults.js`).not.toContain(url);
      }
      expect(src).toMatch(/from "\.\/rpc-defaults\.js"/);
    });
  }

  it("rpc-defaults.ts is the only non-test source holding these URLs", () => {
    // A fourth copy added anywhere under src/ fails here, which is the drift
    // the issue was filed about.
    const offenders = [...SOURCES, "src/config.ts", "src/trust.ts", "src/facilitator.ts"]
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return URLS.some((u) => src.includes(u));
      });
    expect(offenders).toEqual([]);
  });
});
