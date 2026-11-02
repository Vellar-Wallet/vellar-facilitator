import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_RPC,
  defaultRpcFor,
  HORIZON_URL,
  horizonUrlFor,
  NETWORK_PASSPHRASE,
  networkPassphraseFor,
} from "./rpc-defaults.js";

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

describe("NETWORK_PASSPHRASE", () => {
  it("has a passphrase for both networks", () => {
    expect(NETWORK_PASSPHRASE["stellar:testnet"]).toBe("Test SDF Network ; September 2015");
    expect(NETWORK_PASSPHRASE["stellar:pubnet"]).toBe("Public Global Stellar Network ; September 2015");
  });

  it("networkPassphraseFor resolves the same values", () => {
    expect(networkPassphraseFor("stellar:testnet")).toBe(NETWORK_PASSPHRASE["stellar:testnet"]);
    expect(networkPassphraseFor("stellar:pubnet")).toBe(NETWORK_PASSPHRASE["stellar:pubnet"]);
  });

  it("THROWS for an unknown network rather than a wrong default", () => {
    // Deliberately the opposite contract from defaultRpcFor: a passphrase is
    // signed into every transaction, so silently resolving to testnet's for
    // an unrecognised network produces a transaction that verifies against
    // the wrong ledger instead of failing visibly (the RA-10 shape).
    expect(() => networkPassphraseFor("stellar:futurenet")).toThrow(/no passphrase configured/);
  });

  it("testnet and pubnet do NOT share a passphrase", () => {
    expect(NETWORK_PASSPHRASE["stellar:testnet"]).not.toBe(NETWORK_PASSPHRASE["stellar:pubnet"]);
  });
});

describe("no module re-encodes the network passphrases", () => {
  const SOURCES = ["src/upto.ts", "src/bond.ts"];
  const PASSPHRASES = ["Test SDF Network ; September 2015", "Public Global Stellar Network ; September 2015"];

  for (const file of SOURCES) {
    it(`${file} imports the shared map instead of hardcoding a passphrase`, () => {
      const src = readFileSync(file, "utf8");
      for (const p of PASSPHRASES) {
        expect(src, `${file} hardcodes "${p}"; import it from ./rpc-defaults.js`).not.toContain(p);
      }
      expect(src).toMatch(/from "\.\/rpc-defaults\.js"/);
    });
  }

  it("rpc-defaults.ts is the only non-test source holding these passphrases", () => {
    // payability.ts is intentionally NOT in this list: this test lands in a
    // commit before payability.ts exists at all (reviewable refactor on its
    // own), so a hardcoded path here would make this very test fail on that
    // commit. Item 2's own commit re-adds the check once the file exists.
    const offenders = [...SOURCES, "src/server.ts", "src/config.ts", "src/trust.ts", "src/facilitator.ts"]
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return PASSPHRASES.some((p) => src.includes(p));
      });
    expect(offenders).toEqual([]);
  });
});

describe("HORIZON_URL", () => {
  it("has a URL for both networks", () => {
    expect(HORIZON_URL["stellar:testnet"]).toBe("https://horizon-testnet.stellar.org");
    expect(HORIZON_URL["stellar:pubnet"]).toBe("https://horizon.stellar.org");
  });

  it("horizonUrlFor resolves the same values", () => {
    expect(horizonUrlFor("stellar:testnet")).toBe(HORIZON_URL["stellar:testnet"]);
    expect(horizonUrlFor("stellar:pubnet")).toBe(HORIZON_URL["stellar:pubnet"]);
  });

  it("THROWS for an unknown network rather than a wrong default", () => {
    expect(() => horizonUrlFor("stellar:futurenet")).toThrow(/no Horizon URL configured/);
  });

  it("testnet and pubnet do NOT share a URL", () => {
    expect(HORIZON_URL["stellar:testnet"]).not.toBe(HORIZON_URL["stellar:pubnet"]);
  });
});

describe("no module re-encodes the Horizon URLs", () => {
  // payability.ts joins SOURCES in Item 2's own commit — see the matching
  // note in the passphrase enforcement block above for why it is not here.
  const SOURCES = ["src/server.ts"];
  const URLS = ["https://horizon-testnet.stellar.org", "https://horizon.stellar.org"];

  for (const file of SOURCES) {
    it(`${file} imports the shared map instead of hardcoding a Horizon URL`, () => {
      const src = readFileSync(file, "utf8");
      for (const url of URLS) {
        expect(src, `${file} hardcodes ${url}; import it from ./rpc-defaults.js`).not.toContain(url);
      }
    });
  }

  it("rpc-defaults.ts is the only non-test source holding these URLs", () => {
    const offenders = [...SOURCES, "src/upto.ts", "src/bond.ts", "src/config.ts", "src/trust.ts", "src/facilitator.ts"]
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return URLS.some((u) => src.includes(u));
      });
    expect(offenders).toEqual([]);
  });
});
