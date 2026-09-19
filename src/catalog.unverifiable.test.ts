import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { describe, expect, it, vi } from "vitest";
import { BazaarCatalog } from "./catalog.js";

// A seller that advertises a URL Layer 2 can NEVER verify produces an entry
// that looks normal and is permanently unverified. That is how
// examples/seller.mjs made ownership verification vacuous in production for
// its entire life without anything noticing — and, more seriously, how a
// SEPARATE publishing service (vela-wallet's lifecycle-service) once built
// its registration URL from the inbound request's Host header rather than a
// public base URL, letting http://localhost:4002/... settle real mainnet
// payments through this catalog.
//
// That second incident is why localhost/private-literal URLs are no longer
// in this file's list of "counted, not hidden" cases: they are now REJECTED
// OUTRIGHT at registration (assertRoutableResourceUrl in ownership.ts,
// wired into catalog.ts's upsertFromPayment) rather than accepted and
// merely flagged. This file's remaining cases are for a narrower, still-real
// gap the registration gate deliberately does NOT close: a URL that is
// genuinely public and routable but still cannot be PROBED for ownership —
// a route-template key (":symbol" is not a fetchable literal) being the one
// case left. See ownership.ts's own assertRoutableResourceUrl doc comment
// for why registration-time routability and Layer-2 probability are
// intentionally two different questions, not one.
//
// The signal has to distinguish "not verified YET" from "can never BE verified".
// With VERIFICATION_API_URL unset every entry already reads unverified, so the
// existing flag carries no information — the distinction is the whole point.

const ASSET = "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND";
const PAY = "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A";

function reqs(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: ASSET,
    amount: "1",
    payTo: PAY,
    maxTimeoutSeconds: 60,
    extra: {},
    ...over,
  } as PaymentRequirements;
}
function disc(url: string): DiscoveredResource {
  return { resourceUrl: url, x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as DiscoveredResource;
}

describe("structurally unverifiable entries are counted, not hidden", () => {
  // Testnet allows http (examples/seller.mjs's own long-standing precedent;
  // https-only is a PUBNET-specific registration requirement, see
  // ownership.ts's assertRoutableResourceUrl), so an http:// testnet
  // resource on a real public hostname still registers successfully —
  // isStructurallyUnverifiable's own https-only check (unconditional,
  // narrower purpose: "can Layer 2 ever fetch this literal URL") is what
  // flags it as unverifiable, not the registration gate.
  it("counts an http:// resource on a real public host", async () => {
    const c = await BazaarCatalog.create();
    const ok = await c.upsertFromPayment(disc("http://good.example.com/quote"), reqs());
    expect(ok, "http on testnet must still register — https-only is pubnet-specific").toBe(true);
    expect(c.unverifiableCount, "but http can never pass the https-only Layer 2 guard").toBe(1);
  });

  it("does NOT count a healthy public https resource", async () => {
    const c = await BazaarCatalog.create();
    await c.upsertFromPayment(disc("https://vellar-seller-demo.onrender.com/quote"), reqs());
    expect(c.unverifiableCount).toBe(0);
  });

  it("counts a routeTemplate key, which is not a fetchable URL", async () => {
    const c = await BazaarCatalog.create();
    const ok = await c.upsertFromPayment(disc("https://api.example/quote/:symbol"), reqs());
    expect(ok, "a route-template key is a real, routable host — registration must succeed").toBe(true);
    expect(c.unverifiableCount).toBe(1);
  });

  it("mixes correctly: only the unverifiable ones are counted", async () => {
    const c = await BazaarCatalog.create();
    await c.upsertFromPayment(disc("https://good.example/a"), reqs());
    await c.upsertFromPayment(disc("http://bad.example/b"), reqs());
    await c.upsertFromPayment(disc("https://also-good.example/c"), reqs());
    expect(c.size).toBe(3);
    expect(c.unverifiableCount).toBe(1);
  });
});

// Everything below is the REGISTRATION gate (assertRoutableResourceUrl) —
// a stricter, earlier check than isStructurallyUnverifiable above. These
// URLs are refused outright: upsertFromPayment returns false, nothing is
// cataloged, unverifiableCount never even sees them because there is no
// entry to count. This is the fix for the incident described at the top of
// this file: a resource URL derived from an inbound Host header
// (http://localhost:4002/...) must never reach the public catalog at all,
// on any network — accepting it and merely flagging it unverifiable, the
// PREVIOUS behavior asserted in this file, was exactly the gap that let it
// settle real mainnet payments before anyone noticed.
describe("unroutable resource URLs are rejected at registration, not merely flagged", () => {
  it("rejects http://localhost — the exact vela-wallet incident shape", async () => {
    const c = await BazaarCatalog.create();
    const ok = await c.upsertFromPayment(disc("http://localhost:4002/lifecycle/execute"), reqs());
    expect(ok).toBe(false);
    expect(c.size).toBe(0);
  });

  it("rejects https://localhost too — the loopback literal, not the scheme, is disqualifying", async () => {
    const c = await BazaarCatalog.create();
    const ok = await c.upsertFromPayment(disc("https://localhost/x"), reqs());
    expect(ok).toBe(false);
    expect(c.size).toBe(0);
  });

  it("rejects loopback and RFC1918 IP literals", async () => {
    const c = await BazaarCatalog.create();
    for (const host of ["127.0.0.1", "0.0.0.0", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254"]) {
      const ok = await c.upsertFromPayment(disc(`https://${host}/x`), reqs());
      expect(ok, `${host} must be refused`).toBe(false);
    }
    expect(c.size).toBe(0);
  });

  it("rejects ::1 (IPv6 loopback)", async () => {
    const c = await BazaarCatalog.create();
    const ok = await c.upsertFromPayment(disc("https://[::1]/x"), reqs());
    expect(ok).toBe(false);
    expect(c.size).toBe(0);
  });

  it("rejects a .local mDNS hostname", async () => {
    const c = await BazaarCatalog.create();
    const ok = await c.upsertFromPayment(disc("https://myservice.local/x"), reqs());
    expect(ok).toBe(false);
    expect(c.size).toBe(0);
  });

  it("rejects a bare hostname with no dot", async () => {
    const c = await BazaarCatalog.create();
    const ok = await c.upsertFromPayment(disc("https://myservice/x"), reqs());
    expect(ok).toBe(false);
    expect(c.size).toBe(0);
  });

  it("rejects http on stellar:pubnet specifically", async () => {
    const c = await BazaarCatalog.create();
    const ok = await c.upsertFromPayment(
      disc("http://good.example.com/quote"),
      reqs({ network: "stellar:pubnet" }),
    );
    expect(ok, "http must be refused on pubnet even for a real public hostname").toBe(false);
    expect(c.size).toBe(0);
  });

  it("allows http on stellar:testnet for the same real public hostname", async () => {
    const c = await BazaarCatalog.create();
    const ok = await c.upsertFromPayment(
      disc("http://good.example.com/quote"),
      reqs({ network: "stellar:testnet" }),
    );
    expect(ok, "http is a testnet-legitimate scheme, only pubnet requires https").toBe(true);
  });

  it("rejects an empty resource URL", async () => {
    const c = await BazaarCatalog.create();
    const ok = await c.upsertFromPayment(disc(""), reqs());
    expect(ok).toBe(false);
    expect(c.size).toBe(0);
  });

  it("rejects a relative/non-absolute resource URL", async () => {
    const c = await BazaarCatalog.create();
    for (const url of ["/quote", "quote", "//good.example.com/quote"]) {
      const ok = await c.upsertFromPayment(disc(url), reqs());
      expect(ok, `${url} must be refused`).toBe(false);
    }
    expect(c.size).toBe(0);
  });

  it("rejects a malformed URL", async () => {
    const c = await BazaarCatalog.create();
    const ok = await c.upsertFromPayment(disc("not a url at all"), reqs());
    expect(ok).toBe(false);
    expect(c.size).toBe(0);
  });

  it("reports the rejection reason as unroutable_resource_url via the outcome out-param", async () => {
    const c = await BazaarCatalog.create();
    const outcome: { cataloged: boolean; reason?: string } = { cataloged: true };
    await c.upsertFromPayment(disc("http://localhost:4002/x"), reqs(), outcome);
    expect(outcome.cataloged).toBe(false);
    expect(outcome.reason).toBe("unroutable_resource_url");
  });

  it("warns with the specific unroutable reason and detail, not a generic message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = await BazaarCatalog.create();
    await c.upsertFromPayment(disc("http://localhost:4002/x"), reqs());
    const hits = warn.mock.calls.filter((x) => /resource url is not routable/i.test(String(x[0])));
    expect(hits.length).toBe(1);
    expect(String(hits[0]?.[0])).toMatch(/localhost_or_loopback_literal/);
    warn.mockRestore();
  });

  it("a genuinely routable https URL on a real host is unaffected", async () => {
    const c = await BazaarCatalog.create();
    const ok = await c.upsertFromPayment(disc("https://vellar-seller-demo.onrender.com/quote"), reqs());
    expect(ok).toBe(true);
    expect(c.size).toBe(1);
  });
});
