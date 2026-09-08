import { describe, expect, it } from "vitest";
import { rateLimitKeyFor } from "./server.js";

// D4, the keyGenerator half. The existing hardening.test.ts D4 case proves two
// distinct clients get distinct buckets, but it sends a SINGLE-value
// X-Forwarded-For, where leftmost and rightmost are the same string. These
// cases cover what that one cannot: the forged-prefix attack that makes
// rightmost-vs-leftmost a security property rather than a style choice.
describe("rateLimitKeyFor — rightmost X-Forwarded-For wins", () => {
  it("uses the only entry when the header has one", () => {
    expect(rateLimitKeyFor("203.0.113.1", "10.0.0.1")).toBe("203.0.113.1");
  });

  it("IGNORES a client-forged prefix and takes the rightmost entry", () => {
    // The attack: a client sends its own X-Forwarded-For, Render APPENDS the
    // address it observed. Taking the leftmost would let anyone mint a fresh
    // bucket per request by varying the forged value.
    expect(rateLimitKeyFor("evil, 203.0.113.1", "10.0.0.1")).toBe("203.0.113.1");
    expect(rateLimitKeyFor("1.1.1.1, 2.2.2.2, 203.0.113.9", "10.0.0.1")).toBe("203.0.113.9");
  });

  it("cannot be evaded by varying the forged prefix", () => {
    const a = rateLimitKeyFor("attacker-1, 203.0.113.1", "10.0.0.1");
    const b = rateLimitKeyFor("attacker-2, 203.0.113.1", "10.0.0.1");
    expect(a).toBe(b);
  });

  it("falls back to req.ip when the header is absent or empty", () => {
    expect(rateLimitKeyFor(undefined, "1.2.3.4")).toBe("1.2.3.4");
    expect(rateLimitKeyFor("", "1.2.3.4")).toBe("1.2.3.4");
    expect(rateLimitKeyFor("   ", "1.2.3.4")).toBe("1.2.3.4");
  });

  it("takes the last element of a repeated header, for the same reason", () => {
    expect(rateLimitKeyFor(["a, b", "c, 203.0.113.7"], "10.0.0.1")).toBe("203.0.113.7");
  });

  it("strips a port from IPv4 and bracketed IPv6, and leaves a bare IPv6 alone", () => {
    expect(rateLimitKeyFor("203.0.113.1:9999", "10.0.0.1")).toBe("203.0.113.1");
    expect(rateLimitKeyFor("[2001:db8::1]:443", "10.0.0.1")).toBe("2001:db8::1");
    // A bare IPv6 is all colons and has no port to strip. Splitting on the
    // first colon here would corrupt the address into "2001".
    expect(rateLimitKeyFor("2001:db8::1", "10.0.0.1")).toBe("2001:db8::1");
  });
});
