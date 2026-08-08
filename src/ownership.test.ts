import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  verifyResourceOwnership,
  assertPublicHttpsUrl,
  isBlockedAddress,
  pinnedDispatcher,
  defaultFetch,
} from "./ownership.js";

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
  it("accepts a public address and returns it for pinning", async () => {
    await expect(assertPublicHttpsUrl("https://example.com/x", fakeLookup("93.184.216.34"))).resolves.toEqual({
      address: "93.184.216.34",
      family: 4,
    });
  });

  // D1/D12 (audit) — literal IP hosts skip DNS and go straight to the range
  // check. The hex-normalized IPv4-mapped and IPv4-compatible IPv6 forms that
  // Node's URL parser emits for [::ffff:127.0.0.1] etc. must be blocked.
  it("blocks a hex IPv4-mapped IPv6 loopback literal (::ffff:7f00:1)", () => {
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true); // 127.0.0.1
  });
  it("blocks a hex IPv4-mapped IPv6 metadata literal (::ffff:a9fe:a9fe)", () => {
    expect(isBlockedAddress("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254
  });
  it("blocks a hex IPv4-mapped IPv6 RFC1918 literal (::ffff:c0a8:1)", () => {
    expect(isBlockedAddress("::ffff:c0a8:1")).toBe(true); // 192.168.0.1
  });
  it("blocks a fully-expanded IPv4-mapped loopback (0:0:0:0:0:ffff:127.0.0.1)", () => {
    expect(isBlockedAddress("0:0:0:0:0:ffff:127.0.0.1")).toBe(true);
  });
  it("blocks an IPv4-compatible IPv6 loopback literal (::7f00:1)", () => {
    expect(isBlockedAddress("::7f00:1")).toBe(true); // ::127.0.0.1
  });
  it("blocks site-local fec0::/10", () => {
    expect(isBlockedAddress("fec0::1")).toBe(true);
  });
  it("blocks link-local fe80::/10 in non-fe80-prefixed form (febf::1)", () => {
    expect(isBlockedAddress("febf::1")).toBe(true);
  });
  it("still allows a genuine public IPv6 (2606:2800::1)", () => {
    expect(isBlockedAddress("2606:2800::1")).toBe(false);
  });
  it("rejects a URL whose literal host is a mapped loopback", async () => {
    await expect(assertPublicHttpsUrl("https://[::ffff:7f00:1]/x", fakeLookup("93.184.216.34"))).rejects.toThrow(
      /private|loopback|blocked/i,
    );
  });
});

// D2 (audit) — DNS-rebinding TOCTOU. The guard used to resolve the host, check
// the IP, then throw it away while fetch re-resolved independently; attacker DNS
// could answer public to the guard and internal to the connection. The vetted IP
// must now be PINNED into the actual connection.
describe("verifyResourceOwnership — DNS-rebinding pin (D2)", () => {
  it("pins the vetted IP into the connection via a dispatcher", async () => {
    const fetchFn = vi.fn(async () => ({
      status: 402,
      headers: { get: () => challengeHeader(["GLEGIT_A"]) },
      body: null,
      text: async () => "",
    }) as unknown as Response);

    await verifyResourceOwnership("https://example.com/quote", "GLEGIT_A", {
      fetchFn,
      lookupFn: fakeLookup("93.184.216.34"),
    });

    const init = (fetchFn.mock.calls[0] as unknown as [string, { dispatcher?: unknown }])[1];
    expect(init.dispatcher).toBeDefined();
  });

  it("the pinned dispatcher resolves ONLY to the guard-vetted address", async () => {
    let pinned: string | undefined;
    const fetchFn = vi.fn(async (_u: string, init: { dispatcher?: { pinnedAddress?: string } }) => {
      pinned = init.dispatcher?.pinnedAddress;
      return {
        status: 402,
        headers: { get: () => challengeHeader(["GLEGIT_A"]) },
        body: null,
        text: async () => "",
      } as unknown as Response;
    });

    await verifyResourceOwnership("https://example.com/quote", "GLEGIT_A", {
      fetchFn: fetchFn as unknown as typeof fetch,
      lookupFn: fakeLookup("93.184.216.34"),
    });

    // The address the guard vetted is the one the connection is pinned to —
    // fetch cannot re-resolve to something internal.
    expect(pinned).toBe("93.184.216.34");
  });
});

// REGRESSION GUARD. The D2 pinning fix silently disabled Layer 2: the pinned
// dispatcher is an undici@8 Agent, but the module defaulted to Node's GLOBAL
// fetch (a different bundled undici), which rejects it with UND_ERR_INVALID_ARG
// before opening a socket — so every verification returned "unverifiable".
// Every existing test mocked fetch, so all 22 passed against a dead control.
// This test uses the REAL default fetch and a REAL socket, so a future
// version/implementation mismatch fails loudly instead of silently.
describe("pinned dispatch actually works with the default fetch (D2 regression guard)", () => {
  it("completes a real request through the pinned dispatcher", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("REACHED");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      // Ask for a hostname that does not resolve, but pin to our live server:
      // if the pin works AND the dispatcher is compatible with defaultFetch,
      // the request completes. If the undici copies mismatch, this throws.
      const dispatcher = pinnedDispatcher({ address: "127.0.0.1", family: 4 });
      const res = await defaultFetch(`http://pinned.invalid:${port}/`, {
        dispatcher,
      } as unknown as RequestInit);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("REACHED");
      await (dispatcher as { close: () => Promise<void> }).close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
