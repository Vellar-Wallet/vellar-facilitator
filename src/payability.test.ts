import { rpc, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  annotatePayability,
  createPayabilityResolver,
  filterPayableOnly,
  PAYABILITY_LIMITS,
  type PayabilityResolver,
} from "./payability.js";
import type { TrustedDiscoveryResource } from "./trust.js";

const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const NATIVE_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
// Real, StrKey-valid fixtures — resolveClassicIdentity validates the issuer
// with StrKey.isValidEd25519PublicKey, so an invented-looking address (even
// one that LOOKS like a Stellar key) is correctly rejected as non_sac.
const CLASSIC_PAYTO = "GBKULCJJH57KVSYQTWRIJO7VP2SJ4H5OBKO4OPW73CBNJUQ5ZZZ4TQJC";
const CONTRACT_PAYTO = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";
const ISSUER = "GCHBSDF3DTUX2L4I3KKQULNRCQWC5RLIDVAGIKUKUGPVBLUWSNF6G7K2";
const NONEXISTENT_PAYTO = "GAIDTQ5EZL4LVVDKLBGF73WX7IP3UIN7XWGPZ5KUTIDW472FF4IU4CEJ";

function scString(value: string): xdr.ScVal {
  return xdr.ScVal.scvString(value);
}

/** A fake rpcServer.simulateTransaction returning a successful string retval. */
function simOk(value: string) {
  return vi.fn(async (): Promise<rpc.Api.SimulateTransactionResponse> =>
    ({
      id: "1",
      latestLedger: 1,
      events: [],
      _parsed: true,
      transactionData: {} as never,
      minResourceFee: "100",
      result: { retval: scString(value) },
    }) as unknown as rpc.Api.SimulateTransactionSuccessResponse,
  );
}

/** A fake simulateTransaction returning a simulation ERROR (e.g. no such function). */
function simError(message = "trying to invoke non-existent contract function") {
  return vi.fn(async (): Promise<rpc.Api.SimulateTransactionResponse> =>
    ({
      id: "1",
      latestLedger: 1,
      events: [],
      _parsed: true,
      error: message,
    }) as unknown as rpc.Api.SimulateTransactionErrorResponse,
  );
}

/** A fake simulateTransaction that throws, simulating a network/RPC failure. */
function simThrows() {
  return vi.fn(async () => {
    throw new Error("network error");
  });
}

function horizonAccount(balances: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string; is_authorized?: boolean }>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ balances }),
  } as unknown as Response;
}

function horizon404() {
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
}

describe("createPayabilityResolver — classic asset identity resolution", () => {
  it("resolves a classic-asset SAC via name(), then checks the Horizon trustline", async () => {
    const rpcServer = { simulateTransaction: simOk(`USDC:${ISSUER}`) };
    const fetchFn = vi.fn(async () =>
      horizonAccount([{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, is_authorized: true }]),
    );
    const resolver = createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer,
      fetchFn,
    });
    expect(await resolver.check(CLASSIC_PAYTO, USDC_SAC)).toBe("payable");
  });

  it("native SAC: payTo is payable whenever the account exists, no trustline check", async () => {
    const rpcServer = { simulateTransaction: simOk("native") };
    const fetchFn = vi.fn(async () => horizonAccount([{ asset_type: "native" }]));
    const resolver = createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer,
      fetchFn,
    });
    expect(await resolver.check(CLASSIC_PAYTO, NATIVE_SAC)).toBe("payable");
  });

  it("a C... payTo never needs a classic trustline, for either native or classic-asset SACs", async () => {
    const rpcServer = { simulateTransaction: simOk(`USDC:${ISSUER}`) };
    const fetchFn = vi.fn();
    const resolver = createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer,
      fetchFn,
    });
    expect(await resolver.check(CONTRACT_PAYTO, USDC_SAC)).toBe("payable");
    expect(fetchFn, "a contract payTo never needs Horizon at all").not.toHaveBeenCalled();
  });

  it("a non-SAC contract (no name() function) resolves to unknown, never not_payable", async () => {
    const rpcServer = { simulateTransaction: simError() };
    const resolver = createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer,
    });
    expect(await resolver.check(CLASSIC_PAYTO, "CNOTASAC000000000000000000000000000000000000000000000")).toBe(
      "unknown",
    );
  });

  it("caches a resolved classic identity permanently — name() is simulated only once per asset", async () => {
    const sim = simOk(`USDC:${ISSUER}`);
    const fetchFn = vi.fn(async () =>
      horizonAccount([{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, is_authorized: true }]),
    );
    const resolver = createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer: { simulateTransaction: sim },
      fetchFn,
    });
    await resolver.check(CLASSIC_PAYTO, USDC_SAC);
    await resolver.check(ISSUER, USDC_SAC); // different payTo, SAME asset
    expect(sim, "name() simulated once, reused for every payTo against this asset").toHaveBeenCalledTimes(1);
  });

  it("a transient RPC failure resolving name() is NOT cached — the next call retries", async () => {
    let attempt = 0;
    const sim = vi.fn(async (): Promise<rpc.Api.SimulateTransactionResponse> => {
      attempt++;
      if (attempt === 1) throw new Error("rpc down");
      return {
        id: "1",
        latestLedger: 1,
        events: [],
        _parsed: true,
        transactionData: {} as never,
        minResourceFee: "100",
        result: { retval: scString(`USDC:${ISSUER}`) },
      } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
    });
    const fetchFn = vi.fn(async () =>
      horizonAccount([{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, is_authorized: true }]),
    );
    const resolver = createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer: { simulateTransaction: sim },
      fetchFn,
      // Isolates what this test actually checks (the IDENTITY cache) from
      // the outer verdict cache's own unknown-TTL, which would otherwise
      // mask a real identity-cache bug by returning the first "unknown"
      // from its own cache rather than re-resolving.
      unknownCacheTtlMs: 0,
    });
    expect(await resolver.check(CLASSIC_PAYTO, USDC_SAC), "first attempt degrades to unknown, not cached as non_sac").toBe(
      "unknown",
    );
    expect(await resolver.check(CLASSIC_PAYTO, USDC_SAC), "second attempt succeeds — the failure was not cached").toBe(
      "payable",
    );
    expect(sim).toHaveBeenCalledTimes(2);
  });
});

describe("createPayabilityResolver — Horizon trustline + authorization", () => {
  function resolverWith(fetchFn: ReturnType<typeof vi.fn>) {
    return createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer: { simulateTransaction: simOk(`USDC:${ISSUER}`) },
      fetchFn,
    });
  }

  it("trustline present and authorized -> payable", async () => {
    const fetchFn = vi.fn(async () =>
      horizonAccount([{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, is_authorized: true }]),
    );
    expect(await resolverWith(fetchFn).check(CLASSIC_PAYTO, USDC_SAC)).toBe("payable");
  });

  it("trustline absent -> not_payable", async () => {
    const fetchFn = vi.fn(async () => horizonAccount([{ asset_type: "native" }]));
    expect(await resolverWith(fetchFn).check(CLASSIC_PAYTO, USDC_SAC)).toBe("not_payable");
  });

  it("trustline present but NOT authorized -> not_payable", async () => {
    const fetchFn = vi.fn(async () =>
      horizonAccount([{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, is_authorized: false }]),
    );
    expect(await resolverWith(fetchFn).check(CLASSIC_PAYTO, USDC_SAC)).toBe("not_payable");
  });

  it("Horizon down / non-200 -> unknown, never not_payable", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response);
    expect(await resolverWith(fetchFn).check(CLASSIC_PAYTO, USDC_SAC)).toBe("unknown");
  });

  it("Horizon times out / throws -> unknown, never not_payable", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("timeout");
    });
    expect(await resolverWith(fetchFn).check(CLASSIC_PAYTO, USDC_SAC)).toBe("unknown");
  });

  it("account never funded (404) -> unknown, never not_payable", async () => {
    const fetchFn = vi.fn(async () => horizon404());
    expect(await resolverWith(fetchFn).check(NONEXISTENT_PAYTO, USDC_SAC)).toBe("unknown");
  });

  it("native asset, account never funded (404) -> unknown, never payable or not_payable", async () => {
    const fetchFn = vi.fn(async () => horizon404());
    const resolver = createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer: { simulateTransaction: simOk("native") },
      fetchFn,
    });
    expect(await resolver.check(NONEXISTENT_PAYTO, NATIVE_SAC)).toBe("unknown");
  });
});

describe("createPayabilityResolver — verdict cache, TTL asymmetry", () => {
  it("a payable/not_payable verdict is reused within the (longer) cacheTtlMs", async () => {
    const fetchFn = vi.fn(async () =>
      horizonAccount([{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, is_authorized: true }]),
    );
    const resolver = createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer: { simulateTransaction: simOk(`USDC:${ISSUER}`) },
      fetchFn,
      cacheTtlMs: 60_000,
    });
    await resolver.check(CLASSIC_PAYTO, USDC_SAC);
    await resolver.check(CLASSIC_PAYTO, USDC_SAC);
    expect(fetchFn, "second call within TTL reuses the cached verdict").toHaveBeenCalledTimes(1);
  });

  it("an unknown verdict expires sooner than a resolved one (unknownCacheTtlMs)", async () => {
    let fail = true;
    const fetchFn = vi.fn(async () => {
      if (fail) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      return horizonAccount([{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, is_authorized: true }]);
    });
    const resolver = createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer: { simulateTransaction: simOk(`USDC:${ISSUER}`) },
      fetchFn,
      cacheTtlMs: 60_000,
      unknownCacheTtlMs: 0, // immediate expiry, deterministic without real timers
    });
    expect(await resolver.check(CLASSIC_PAYTO, USDC_SAC)).toBe("unknown");
    fail = false;
    expect(
      await resolver.check(CLASSIC_PAYTO, USDC_SAC),
      "unknown must not be held for the long TTL — a fresh attempt runs immediately",
    ).toBe("payable");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("documented constants: unknownCacheTtlMs is shorter than defaultCacheTtlMs", () => {
    expect(PAYABILITY_LIMITS.unknownCacheTtlMs).toBeLessThan(PAYABILITY_LIMITS.defaultCacheTtlMs);
  });
});

function item(accepts: Array<{ payTo: string; asset: string }>): TrustedDiscoveryResource {
  return {
    resource: "https://api.example.com/r",
    type: "http",
    x402Version: 2,
    accepts: accepts.map((a) => ({
      scheme: "exact",
      network: "stellar:testnet",
      asset: a.asset,
      amount: "1",
      payTo: a.payTo,
      maxTimeoutSeconds: 60,
      extra: {},
    })) as never,
    lastUpdated: new Date().toISOString(),
  };
}

function fixedPayability(map: Record<string, "payable" | "not_payable" | "unknown">): PayabilityResolver {
  return { check: async (payTo, asset) => map[`${payTo}\u0000${asset}`] ?? "unknown" };
}

describe("annotatePayability — per-accepts, index-aligned", () => {
  it("one verdict per accepts entry, in order", async () => {
    const resolver = fixedPayability({
      "GA\u0000CA": "payable",
      "GB\u0000CB": "not_payable",
    });
    const [annotated] = await annotatePayability(
      [item([{ payTo: "GA", asset: "CA" }, { payTo: "GB", asset: "CB" }])],
      resolver,
    );
    expect(annotated!.trust!.acceptsPayability).toEqual(["payable", "not_payable"]);
  });

  it("does not disturb existing trust fields (settlements, verification, etc.)", async () => {
    const resolver = fixedPayability({ "GA\u0000CA": "payable" });
    const withTrust = { ...item([{ payTo: "GA", asset: "CA" }]), trust: { settlements: 5, uniquePayers: 2, verification: "verified" as const } };
    const [annotated] = await annotatePayability([withTrust], resolver);
    expect(annotated!.trust!.settlements).toBe(5);
    expect(annotated!.trust!.verification).toBe("verified");
    expect(annotated!.trust!.acceptsPayability).toEqual(["payable"]);
  });
});

describe("filterPayableOnly", () => {
  it("drops only the not_payable accepts entries, keeps payable and unknown", async () => {
    const resolver = fixedPayability({
      "GA\u0000CA": "payable",
      "GB\u0000CB": "not_payable",
      "GC\u0000CC": "unknown",
    });
    const [annotated] = await annotatePayability(
      [item([{ payTo: "GA", asset: "CA" }, { payTo: "GB", asset: "CB" }, { payTo: "GC", asset: "CC" }])],
      resolver,
    );
    const [filtered] = filterPayableOnly([annotated!]);
    expect(filtered!.accepts.map((a) => a.payTo)).toEqual(["GA", "GC"]);
    expect(filtered!.trust!.acceptsPayability).toEqual(["payable", "unknown"]);
  });

  it("drops the whole listing only when every accepts entry is not_payable", async () => {
    const resolver = fixedPayability({ "GA\u0000CA": "not_payable" });
    const [annotated] = await annotatePayability([item([{ payTo: "GA", asset: "CA" }])], resolver);
    expect(filterPayableOnly([annotated!])).toEqual([]);
  });

  it("never promotes unknown to payable or hides it — the caller sees the verdict", async () => {
    const resolver = fixedPayability({ "GA\u0000CA": "unknown" });
    const [annotated] = await annotatePayability([item([{ payTo: "GA", asset: "CA" }])], resolver);
    const [filtered] = filterPayableOnly([annotated!]);
    expect(filtered, "an all-unknown listing is kept, not dropped").toBeDefined();
    expect(filtered!.trust!.acceptsPayability).toEqual(["unknown"]);
  });
});

describe("createPayabilityResolver — concurrency cap and in-flight dedup", () => {
  /** A controllable-delay Horizon fake that tracks peak concurrent calls. */
  function trackedHorizon(delayMs: number) {
    let active = 0;
    let peak = 0;
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, delayMs));
      active--;
      return horizonAccount([{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, is_authorized: true }]);
    });
    return { fetchFn, calls, peakActive: () => peak };
  }

  it("never exceeds maxConcurrentLookups Horizon calls at once", async () => {
    const horizon = trackedHorizon(20);
    const resolver = createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer: { simulateTransaction: simOk(`USDC:${ISSUER}`) },
      fetchFn: horizon.fetchFn,
      maxConcurrentLookups: 3,
    });
    // 10 DISTINCT payTo addresses (so none share a cache/in-flight key) racing
    // one asset whose identity is already resolved once naturally as part of
    // this loop, then 10 genuinely independent Horizon calls queue behind
    // the cap of 3.
    // Real, StrKey-valid distinct public keys — an invented-looking address
    // is rejected by resolve()'s own StrKey.isValidEd25519PublicKey guard
    // before ever reaching Horizon, which would make this test pass for the
    // wrong reason (0 calls, not 10 queued-and-capped ones).
    const payTos = [
      "GA4QENI4GYN2K2BIXKZEJB6J4WL4FYA6PMHWYO4Z2FNAXKBM3IAKKCT2",
      "GBXIUQGEAVOSTIERNLM6RX42TUPDDOR4455SBMZHFXYELUGKF3TOWARI",
      "GBY4GT5YEVIAFORBCO5IHAIM4FM53CW6U6DZK3BJI5SCGCBDSY3XWD3Q",
      "GB5DUTI5Y43UU23DUPMLRCT63IAJYSD7I534HULHVZQZY5L2CNZPNZMR",
      "GC42PFIU5D6NXJ33QLONCPV5XRMPSXLIBRJROHSJJJ77UYER2RHX45B7",
      "GD566MYBJWRT7QVTHZFYNZPHZKAQEOJNMM6J5E3M6CDJC25CBSUUOXV7",
      "GBXG3IIIJRRC3WHTF7QLGWSIP4A4LEFUR2ISRHHFGIT2C7O4FZNWSOX3",
      "GCNXSAE6A64WLJP6STSCZ54SVRE2J7ZVML6YRECUAPTOOPACINMVZIZO",
      "GCFU2CFWVPOPQ67GSQMQVEVG2PZNDZHAKHCNFQ7VIKHMSUKUHR6ZVGZG",
      "GBNEHCBFOBRU2FFMQ7DCPQHKIKH4QTK7AMS22EVKCU44FDJSFGSNIU62",
    ];
    await Promise.all(payTos.map((p) => resolver.check(p, USDC_SAC)));
    expect(horizon.peakActive(), "must never exceed the configured cap").toBeLessThanOrEqual(3);
    expect(horizon.calls.length).toBe(10);
  });

  it("concurrent checks for the SAME (payTo, asset) share one in-flight lookup, not N", async () => {
    const horizon = trackedHorizon(20);
    const resolver = createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer: { simulateTransaction: simOk(`USDC:${ISSUER}`) },
      fetchFn: horizon.fetchFn,
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolver.check(CLASSIC_PAYTO, USDC_SAC)),
    );
    expect(results).toEqual(["payable", "payable", "payable", "payable", "payable"]);
    expect(horizon.calls.length, "5 concurrent callers for the same pair, ONE Horizon call").toBe(1);
  });

  it("a failed in-flight lookup does not wedge later calls for the same pair", async () => {
    let attempt = 0;
    const fetchFn = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error("down");
      return horizonAccount([{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, is_authorized: true }]);
    });
    const resolver = createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer: { simulateTransaction: simOk(`USDC:${ISSUER}`) },
      fetchFn,
      unknownCacheTtlMs: 0,
    });
    expect(await resolver.check(CLASSIC_PAYTO, USDC_SAC)).toBe("unknown");
    expect(await resolver.check(CLASSIC_PAYTO, USDC_SAC), "the in-flight entry must have cleared, not wedged").toBe(
      "payable",
    );
  });
});

describe("annotatePayability — wall-clock budget", () => {
  it("an entry still unresolved past the budget reports unknown for THIS pass", async () => {
    const resolver: PayabilityResolver = {
      check: () => new Promise((resolve) => setTimeout(() => resolve("payable"), 200)),
    };
    const [annotated] = await annotatePayability(
      [item([{ payTo: "GA", asset: "CA" }])],
      resolver,
      20, // budget far shorter than the resolver's own 200ms
    );
    expect(annotated!.trust!.acceptsPayability).toEqual(["unknown"]);
  });

  it("the in-flight lookup is NOT cancelled — it finishes and warms the cache for the next pass", async () => {
    const resolver = createPayabilityResolver({
      rpcUrl: "http://rpc",
      horizonUrl: "http://horizon",
      networkPassphrase: "Test",
      rpcServer: { simulateTransaction: simOk(`USDC:${ISSUER}`) },
      fetchFn: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return horizonAccount([{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, is_authorized: true }]);
      }),
    });

    const first = await annotatePayability(
      [item([{ payTo: CLASSIC_PAYTO, asset: USDC_SAC }])],
      resolver,
      10, // budget far shorter than the 50ms Horizon delay
    );
    expect(first[0]!.trust!.acceptsPayability, "the first pass times out — real verdict not back yet").toEqual([
      "unknown",
    ]);

    // Let the background lookup actually finish and populate the cache.
    await new Promise((r) => setTimeout(r, 100));

    const second = await annotatePayability(
      [item([{ payTo: CLASSIC_PAYTO, asset: USDC_SAC }])],
      resolver,
      2_000,
    );
    expect(
      second[0]!.trust!.acceptsPayability,
      "a later pass sees the real verdict the earlier one's budget cut off",
    ).toEqual(["payable"]);
  });

  it("entries past the deadline within one pass resolve to unknown without waiting for earlier ones", async () => {
    // Budget consumed by item 1 (slow) must not extend to item 2 — each
    // checkWithinBudget call reads the SAME deadline, computed once.
    const resolver: PayabilityResolver = {
      check: (payTo) =>
        new Promise((resolve) =>
          setTimeout(() => resolve("payable"), payTo === "SLOW" ? 100 : 5),
        ),
    };
    const items = [item([{ payTo: "SLOW", asset: "CA" }]), item([{ payTo: "FAST", asset: "CB" }])];
    const annotated = await annotatePayability(items, resolver, 30);
    expect(annotated[0]!.trust!.acceptsPayability, "slow entry exceeds the budget").toEqual(["unknown"]);
    // FAST (5ms) resolves well inside the 30ms budget regardless of what SLOW does.
    expect(annotated[1]!.trust!.acceptsPayability).toEqual(["payable"]);
  });
});
