import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  verifyResourceOwnership,
  assertPublicHttpsUrl,
  isBlockedAddress,
  pinnedDispatcher,
  pinnedLookup,
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

/** A minimal Response-shaped object carrying a 402 challenge. */
function okChallenge(payTos: string[], status = 402): Response {
  const headers = new Map<string, string>();
  if (status === 402) headers.set("payment-required", challengeHeader(payTos));
  return {
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body: null,
    text: async () => "",
  } as unknown as Response;
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
  it("blocks a hex IPv4-mapped IPv6 loopback literal (::ffff:7f00:1)", async () => {
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true); // 127.0.0.1
  });
  it("blocks a hex IPv4-mapped IPv6 metadata literal (::ffff:a9fe:a9fe)", async () => {
    expect(isBlockedAddress("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254
  });
  it("blocks a hex IPv4-mapped IPv6 RFC1918 literal (::ffff:c0a8:1)", async () => {
    expect(isBlockedAddress("::ffff:c0a8:1")).toBe(true); // 192.168.0.1
  });
  it("blocks a fully-expanded IPv4-mapped loopback (0:0:0:0:0:ffff:127.0.0.1)", async () => {
    expect(isBlockedAddress("0:0:0:0:0:ffff:127.0.0.1")).toBe(true);
  });
  it("blocks an IPv4-compatible IPv6 loopback literal (::7f00:1)", async () => {
    expect(isBlockedAddress("::7f00:1")).toBe(true); // ::127.0.0.1
  });
  it("blocks site-local fec0::/10", async () => {
    expect(isBlockedAddress("fec0::1")).toBe(true);
  });
  it("blocks link-local fe80::/10 in non-fe80-prefixed form (febf::1)", async () => {
    expect(isBlockedAddress("febf::1")).toBe(true);
  });
  it("still allows a genuine public IPv6 (2606:2800::1)", async () => {
    expect(isBlockedAddress("2606:2800::1")).toBe(false);
  });

  // Re-audit: standard IPv4-in-IPv6 transition prefixes carry a routable private
  // IPv4. Behind a NAT64/DNS64 gateway (an ordinary cloud setup) the gateway
  // translates these to the embedded address, tunnelling into RFC1918 space.
  it("blocks NAT64-embedded private IPv4 (64:ff9b::/96)", async () => {
    expect(isBlockedAddress("64:ff9b::a00:1")).toBe(true); // 10.0.0.1
    expect(isBlockedAddress("64:ff9b::c0a8:1")).toBe(true); // 192.168.0.1
  });
  it("blocks 6to4-embedded private IPv4 (2002::/16)", async () => {
    expect(isBlockedAddress("2002:0a00:0001::")).toBe(true); // 10.0.0.1
  });
  it("blocks IPv4-translated private IPv4 (::ffff:0:0/96)", async () => {
    expect(isBlockedAddress("::ffff:0:a00:1")).toBe(true); // 10.0.0.1
  });
  it("still allows 6to4 wrapping a PUBLIC IPv4", async () => {
    expect(isBlockedAddress("2002:5db8:0001::")).toBe(false); // 93.184.x
  });

  // Re-audit: multicast, reserved Class E, limited broadcast and IETF-protocol
  // space were treated as public, directly and via the mapped path.
  it("blocks multicast, reserved, broadcast and IETF-protocol IPv4", async () => {
    expect(isBlockedAddress("224.0.0.1")).toBe(true); // multicast
    expect(isBlockedAddress("240.0.0.1")).toBe(true); // reserved class E
    expect(isBlockedAddress("255.255.255.255")).toBe(true); // limited broadcast
    expect(isBlockedAddress("192.0.0.1")).toBe(true); // IETF protocol assignments
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
// LAYER 2 END-TO-END. The prior regression guard exercised defaultFetch +
// pinnedDispatcher DIRECTLY; it never called verifyResourceOwnership, so the
// integrated control — guard -> pin -> real socket -> 402 parse -> verdict — was
// still only ever tested with a mocked fetch. That is precisely the shape of the
// bug that left this control inert in production while every test passed.
// Nothing is mocked here.
describe("Layer 2 end-to-end against a real server (no mocks)", () => {
  async function serve(handler: (req: unknown, res: import("node:http").ServerResponse) => void) {
    const server = http.createServer(handler as never);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it("returns match: real fetch, real pin, real 402 challenge", async () => {
    const challenge = Buffer.from(
      JSON.stringify({ accepts: [{ payTo: "GOWNER" }] }),
      "utf8",
    ).toString("base64");
    const s = await serve((_q, res) => {
      res.writeHead(402, { "PAYMENT-REQUIRED": challenge });
      res.end();
    });
    try {
      const v = await verifyResourceOwnership(`http://owner.test:${s.port}/quote`, "GOWNER", {
        lookupFn: fakeLookup("127.0.0.1"),
        __insecureTestTransport: true,
      });
      expect(v).toBe("match");
    } finally {
      await s.close();
    }
  });

  it("returns mismatch when the real challenge lists a different payTo", async () => {
    const challenge = Buffer.from(
      JSON.stringify({ accepts: [{ payTo: "GOWNER" }] }),
      "utf8",
    ).toString("base64");
    const s = await serve((_q, res) => {
      res.writeHead(402, { "PAYMENT-REQUIRED": challenge });
      res.end();
    });
    try {
      const v = await verifyResourceOwnership(`http://owner.test:${s.port}/quote`, "GATTACKER", {
        lookupFn: fakeLookup("127.0.0.1"),
        __insecureTestTransport: true,
      });
      expect(v).toBe("mismatch");
    } finally {
      await s.close();
    }
  });

  // The guard rejections, asserted against a REAL server rather than a mock.
  // These run WITHOUT __insecureTestTransport, so the guard is fully armed and
  // must refuse before a socket is ever opened — proven by the server recording
  // zero requests.
  it("refuses http:// against a live server (https-only), without contacting it", async () => {
    let hits = 0;
    const s = await serve((_q, res) => {
      hits++;
      res.writeHead(402, { "PAYMENT-REQUIRED": "x" });
      res.end();
    });
    try {
      const v = await verifyResourceOwnership(`http://owner.test:${s.port}/quote`, "GOWNER", {
        lookupFn: fakeLookup("93.184.216.34"),
      });
      expect(v).toBe("unverifiable");
      expect(hits, "https-only must reject before any request").toBe(0);
    } finally {
      await s.close();
    }
  });

  it("refuses a DNS name that RESOLVES to a private address, without contacting it", async () => {
    let hits = 0;
    const s = await serve((_q, res) => {
      hits++;
      res.writeHead(402, { "PAYMENT-REQUIRED": "x" });
      res.end();
    });
    try {
      // https URL (passes the protocol check) whose hostname resolves to loopback.
      // The block must happen AFTER resolution.
      const v = await verifyResourceOwnership(`https://rebind.test:${s.port}/quote`, "GOWNER", {
        lookupFn: fakeLookup("127.0.0.1"),
      });
      expect(v).toBe("unverifiable");
      expect(hits, "post-resolution private block must prevent any request").toBe(0);
    } finally {
      await s.close();
    }
  });

  it("does not follow a real 302 into a private range — the target is never contacted", async () => {
    let targetHits = 0;
    const target = await serve((_q, res) => {
      targetHits++;
      res.writeHead(200);
      res.end("INTERNAL");
    });
    const redirector = await serve((_q, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target.port}/` });
      res.end();
    });
    try {
      const v = await verifyResourceOwnership(`http://owner.test:${redirector.port}/quote`, "GOWNER", {
        lookupFn: fakeLookup("127.0.0.1"),
        __insecureTestTransport: true,
      });
      expect(v).toBe("unverifiable");
      expect(targetHits, "the redirect target must never be contacted").toBe(0);
    } finally {
      await redirector.close();
      await target.close();
    }
  });

  it("returns unverifiable for a real non-402 response", async () => {
    const s = await serve((_q, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    try {
      const v = await verifyResourceOwnership(`http://owner.test:${s.port}/quote`, "GOWNER", {
        lookupFn: fakeLookup("127.0.0.1"),
        __insecureTestTransport: true,
      });
      expect(v).toBe("unverifiable");
    } finally {
      await s.close();
    }
  });
});

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

// The audit proved these mutations passed the whole suite. Each test below is
// written to FAIL against its named mutation — that is the only property that
// makes a regression guard worth anything.
describe("mutation guards (audit: these all went undetected)", () => {
  // MUTATION B: pin every request to 127.0.0.1, discarding the vetted address.
  // Previously asserted only via a decorative `pinnedAddress` label.
  it("the pinned lookup returns the VETTED address, not a constant", async () => {
    const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });
    // Both callback shapes Node uses must yield the vetted address. A mutation
    // that hardcodes 127.0.0.1 (or ignores `vetted`) fails here.
    const all = await new Promise<Array<{ address: string; family: number }>>((res) =>
      lookup("evil.example", { all: true }, (_e: unknown, a: unknown) => res(a as Array<{ address: string; family: number }>)),
    );
    expect(all[0]!.address).toBe("93.184.216.34");

    const single = await new Promise<string>((res) =>
      lookup("evil.example", {}, (_e: unknown, a: unknown) => res(a as string)),
    );
    expect(single).toBe("93.184.216.34");

    // And an IPv6 vetted address must pin as v6, not silently coerce to v4.
    const v6 = pinnedLookup({ address: "2606:2800::1", family: 6 });
    const got = await new Promise<Array<{ address: string; family: number }>>((res) =>
      v6("evil.example", { all: true }, (_e: unknown, a: unknown) => res(a as Array<{ address: string; family: number }>)),
    );
    expect(got[0]).toEqual({ address: "2606:2800::1", family: 6 });
  });

  // MUTATION C: redirect:"manual" -> "follow".
  it("passes redirect:manual to fetch", async () => {
    const fetchFn = vi.fn(async () => ({
      status: 402,
      headers: { get: () => challengeHeader(["GLEGIT"]) },
      body: null,
      text: async () => "",
    }) as unknown as Response);
    await verifyResourceOwnership("https://example.com/q", "GLEGIT", {
      fetchFn,
      lookupFn: fakeLookup("93.184.216.34"),
    });
    const init = (fetchFn.mock.calls[0] as unknown as [string, { redirect?: string }])[1];
    expect(init.redirect).toBe("manual");
  });

  // Prompt (Fix 0): "the SSRF guard rejects ... redirects into private ranges".
  // We never follow ANY redirect, which is strictly stronger, but the
  // private-range case is named explicitly so it is asserted explicitly.
  it("does not follow a redirect pointing into a private range", async () => {
    const fetchFn = vi.fn(async () => ({
      status: 302,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "location" ? "http://169.254.169.254/latest/meta-data/" : null,
      },
      body: null,
      text: async () => "",
    }) as unknown as Response);
    const v = await verifyResourceOwnership("https://example.com/quote", "GLEGIT", {
      fetchFn,
      lookupFn: fakeLookup("93.184.216.34"),
    });
    expect(v).toBe("unverifiable");
    expect(fetchFn, "the redirect must never be followed").toHaveBeenCalledTimes(1);
  });

  // MUTATION AD: the abort callback emptied, so the timeout never fires.
  it("actually aborts the fetch when the timeout elapses", async () => {
    let sawAbort = false;
    const fetchFn = vi.fn(
      (_u: string, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => {
            sawAbort = true;
            rej(new Error("aborted"));
          });
        }),
    );
    const v = await verifyResourceOwnership("https://example.com/q", "GLEGIT", {
      fetchFn: fetchFn as unknown as typeof fetch,
      lookupFn: fakeLookup("93.184.216.34"),
      timeoutMs: 25,
      coldStartRetryDelaysMs: [], // single-shot: this test is about the abort
    });
    expect(sawAbort, "the timeout must fire an abort, not just clear a timer").toBe(true);
    // NOT "unverifiable". A timeout says the endpoint did not answer; an
    // unverifiable says it answered badly. Collapsing them gave a sleeping
    // free-tier resource the same 15-minute cooldown as a broken one, which is
    // why displacement never recovered the demo's binding.
    expect(v).toBe("timeout");
  });

  // A timeout is the ONLY verdict that earns a second probe, and it earns
  // exactly one. MUTATION: retry on every verdict, or loop instead of retrying
  // once — the call counts below pin both.
  describe("cold-start retry", () => {
    const timingOutFetch = () =>
      vi.fn(
        (_u: string, init: { signal?: AbortSignal }) =>
          new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
          }),
      );

    it("retries a timeout a FIXED number of times, then gives up", async () => {
      const fetchFn = timingOutFetch();
      const v = await verifyResourceOwnership("https://example.com/q", "GLEGIT", {
        fetchFn: fetchFn as unknown as typeof fetch,
        lookupFn: fakeLookup("93.184.216.34"),
        timeoutMs: 10,
        coldStartRetryDelaysMs: [1, 1],
      });
      expect(v).toBe("timeout");
      // MUTATION: loop while the verdict is "timeout" instead of iterating a
      // finite delay list. An endpoint that never answers then probes forever.
      expect(fetchFn, "one probe plus two retries — never a loop").toHaveBeenCalledTimes(3);
    });

    it("stops as soon as it gets an answer — a later retry is not spent", async () => {
      let call = 0;
      const fetchFn = vi.fn((_u: string, init: { signal?: AbortSignal }) => {
        call += 1;
        if (call === 1) {
          return new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
          });
        }
        return Promise.resolve(okChallenge(["GLEGIT"]));
      });
      const v = await verifyResourceOwnership("https://example.com/q", "GLEGIT", {
        fetchFn: fetchFn as unknown as typeof fetch,
        lookupFn: fakeLookup("93.184.216.34"),
        timeoutMs: 10,
        coldStartRetryDelaysMs: [1, 1],
      });
      expect(v).toBe("match");
      expect(fetchFn, "the second retry must not fire once the host answered").toHaveBeenCalledTimes(2);
    });

    it("succeeds on the retry when the resource wakes up — the real cold-start case", async () => {
      let call = 0;
      const fetchFn = vi.fn((_u: string, init: { signal?: AbortSignal }) => {
        call += 1;
        // First probe: asleep, never answers. Second: awake, names the owner.
        if (call === 1) {
          return new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
          });
        }
        return Promise.resolve(okChallenge(["GLEGIT"]));
      });
      const v = await verifyResourceOwnership("https://example.com/q", "GLEGIT", {
        fetchFn: fetchFn as unknown as typeof fetch,
        lookupFn: fakeLookup("93.184.216.34"),
        timeoutMs: 10,
        coldStartRetryDelaysMs: [1],
      });
      expect(v, "the resource was asleep, not unowned").toBe("match");
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry a mismatch — that is an answer, not an absence", async () => {
      const fetchFn = vi.fn(() => Promise.resolve(okChallenge(["GSOMEONEELSE"])));
      const v = await verifyResourceOwnership("https://example.com/q", "GLEGIT", {
        fetchFn: fetchFn as unknown as typeof fetch,
        lookupFn: fakeLookup("93.184.216.34"),
        coldStartRetryDelaysMs: [1],
      });
      expect(v).toBe("mismatch");
      expect(fetchFn, "a mismatch is evidence; probing again would only harass").toHaveBeenCalledTimes(1);
    });

    it("does NOT retry an unverifiable — the endpoint answered, and badly", async () => {
      const fetchFn = vi.fn(() => Promise.resolve(okChallenge([], 200)));
      const v = await verifyResourceOwnership("https://example.com/q", "GLEGIT", {
        fetchFn: fetchFn as unknown as typeof fetch,
        lookupFn: fakeLookup("93.184.216.34"),
        coldStartRetryDelaysMs: [1],
      });
      expect(v).toBe("unverifiable");
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  // MUTATION AE: the header size cap deleted. The header must be a VALID,
  // matching challenge — otherwise the verdict is "unverifiable" either way and
  // the cap is not what the assertion measures.
  it("rejects an oversized but otherwise VALID PAYMENT-REQUIRED header", async () => {
    // Valid challenge padded past the cap with ignored filler.
    const padded = Buffer.from(
      JSON.stringify({ accepts: [{ payTo: "GLEGIT" }], pad: "x".repeat(4000) }),
      "utf8",
    ).toString("base64");
    const fetchFn = vi.fn(async () => ({
      status: 402,
      headers: { get: () => padded },
      body: null,
      text: async () => "",
    }) as unknown as Response);

    // Same header, generous cap -> the challenge is honoured (proves it is valid).
    const ok = await verifyResourceOwnership("https://example.com/q", "GLEGIT", {
      fetchFn, lookupFn: fakeLookup("93.184.216.34"), maxBytes: 1024 * 1024,
    });
    expect(ok, "control: the padded challenge is otherwise valid").toBe("match");

    // Tight cap -> must be refused purely because of size.
    const capped = await verifyResourceOwnership("https://example.com/q", "GLEGIT", {
      fetchFn, lookupFn: fakeLookup("93.184.216.34"), maxBytes: 1024,
    });
    expect(capped).toBe("unverifiable");
  });

  // MUTATION A: the module default swapped back to Node's global fetch, which is
  // a different bundled undici and rejects our Agent before opening a socket —
  // silently disabling Layer 2. defaultFetch is the single source of truth used
  // by verifyResourceOwnership, so guarding the constant guards the behaviour.
  it("does not default to Node's global fetch", async () => {
    expect(defaultFetch).not.toBe(globalThis.fetch);
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
