import { describe, expect, it, vi } from "vitest";
import { verifyResourceOwnership, assertPublicHttpsUrl } from "./ownership.js";

// Fix 0 Layer 2 — 402-challenge ownership verification and its SSRF guard.
// verifyResourceOwnership fetches the resource URL, expects a 402 whose
// PAYMENT-REQUIRED challenge lists the settled payTo, and returns a verdict.
// The fetch is guarded: https only, no private/loopback/link-local hosts after
// DNS resolution, no redirects, AbortController timeout, response-size cap.

function challengeHeader(payTos: string[]): string {
  const body = { accepts: payTos.map((payTo) => ({ payTo, scheme: "exact", network: "stellar:testnet" })) };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}

describe("assertPublicHttpsUrl — SSRF guard", () => {
  it("rejects http (non-TLS)", async () => {
    await expect(assertPublicHttpsUrl("http://example.com/x", fakeLookup("93.184.216.34"))).rejects.toThrow(/https/i);
  });
  it("rejects a hostname resolving to a private range (10/8)", async () => {
    await expect(assertPublicHttpsUrl("https://internal.example/x", fakeLookup("10.0.0.5"))).rejects.toThrow(/private|blocked/i);
  });
  it("rejects loopback (127/8)", async () => {
    await expect(assertPublicHttpsUrl("https://x.example/x", fakeLookup("127.0.0.1"))).rejects.toThrow(/private|loopback|blocked/i);
  });
  it("rejects the cloud metadata IP (169.254.169.254)", async () => {
    await expect(assertPublicHttpsUrl("https://x.example/x", fakeLookup("169.254.169.254"))).rejects.toThrow(/link-local|private|blocked/i);
  });
  it("rejects IPv6 loopback (::1)", async () => {
    await expect(assertPublicHttpsUrl("https://x.example/x", fakeLookup("::1"))).rejects.toThrow(/private|loopback|blocked/i);
  });
  it("accepts a public address", async () => {
    await expect(assertPublicHttpsUrl("https://example.com/x", fakeLookup("93.184.216.34"))).resolves.toBeUndefined();
  });
});

describe("verifyResourceOwnership — 402 challenge match", () => {
  it("returns match when the settled payTo is in the 402 challenge", async () => {
    const fetchFn = fakeFetch({ status: 402, header: challengeHeader(["GLEGIT_A"]) });
    const v = await verifyResourceOwnership("https://example.com/quote", "GLEGIT_A", {
      fetchFn,
      lookupFn: fakeLookup("93.184.216.34"),
    });
    expect(v).toBe("match");
  });

  it("returns mismatch when the settled payTo is NOT in the challenge", async () => {
    const fetchFn = fakeFetch({ status: 402, header: challengeHeader(["GLEGIT_A"]) });
    const v = await verifyResourceOwnership("https://example.com/quote", "GATTACKER_B", {
      fetchFn,
      lookupFn: fakeLookup("93.184.216.34"),
    });
    expect(v).toBe("mismatch");
  });

  it("returns unverifiable on fetch failure (never throws)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const v = await verifyResourceOwnership("https://example.com/quote", "GLEGIT_A", {
      fetchFn,
      lookupFn: fakeLookup("93.184.216.34"),
    });
    expect(v).toBe("unverifiable");
  });

  it("returns unverifiable (not a throw) when the host is private — SSRF blocked", async () => {
    const fetchFn = vi.fn(); // must never be called
    const v = await verifyResourceOwnership("https://internal.example/quote", "GLEGIT_A", {
      fetchFn,
      lookupFn: fakeLookup("10.1.2.3"),
    });
    expect(v).toBe("unverifiable");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("treats a 3xx redirect as unverifiable (no redirect following)", async () => {
    const fetchFn = fakeFetch({ status: 301, header: null });
    const v = await verifyResourceOwnership("https://example.com/quote", "GLEGIT_A", {
      fetchFn,
      lookupFn: fakeLookup("93.184.216.34"),
    });
    expect(v).toBe("unverifiable");
  });
});

// ---- test doubles -----------------------------------------------------------

function fakeLookup(address: string) {
  return async (_host: string) => ({ address, family: address.includes(":") ? 6 : 4 });
}

function fakeFetch(opts: { status: number; header: string | null }) {
  return vi.fn(async () => {
    const headers = new Map<string, string>();
    if (opts.header) headers.set("payment-required", opts.header);
    return {
      status: opts.status,
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      body: null,
      text: async () => "",
    } as unknown as Response;
  });
}
