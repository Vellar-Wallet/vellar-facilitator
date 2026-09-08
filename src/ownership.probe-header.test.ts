import { describe, expect, it } from "vitest";
import { verifyResourceOwnership } from "./ownership.js";

// Issue #89. The Layer 2 verifier must identify itself so a seller whose route
// requires query parameters can answer with its 402 challenge instead of a 400
// for missing input. Without the header those routes are permanently
// unverifiable, which is what left 9 of 19 catalog entries stuck.
describe("Layer 2 verification sends X-Ownership-Probe", () => {
  it("sets X-Ownership-Probe: 1 on the verification fetch", async () => {
    let seen: Record<string, string> | undefined;
    const fetchFn = (async (_url: string, init: { headers?: Record<string, string> }) => {
      seen = init.headers;
      return {
        status: 200,
        headers: { get: () => null },
        body: { cancel: async () => {} },
      };
    }) as unknown as typeof fetch;

    await verifyResourceOwnership("https://seller.example/stroops", "GAAA", {
      fetchFn,
      lookupFn: async () => ({ address: "93.184.216.34", family: 4 }),
    });

    expect(seen).toBeDefined();
    expect(seen!["X-Ownership-Probe"]).toBe("1");
  });

  it("still sends accept: application/json alongside it", async () => {
    let seen: Record<string, string> | undefined;
    const fetchFn = (async (_url: string, init: { headers?: Record<string, string> }) => {
      seen = init.headers;
      return {
        status: 200,
        headers: { get: () => null },
        body: { cancel: async () => {} },
      };
    }) as unknown as typeof fetch;

    await verifyResourceOwnership("https://seller.example/hash", "GAAA", {
      fetchFn,
      lookupFn: async () => ({ address: "93.184.216.34", family: 4 }),
    });

    expect(seen!.accept).toBe("application/json");
  });
});
