import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";

// G-3 — the F12 spend policy keyed on the RAW resource URL while the catalog
// keys on the CANONICAL one (`origin + pathname`, query stripped, produced by
// extractDiscoveryInfo). Any merchant whose resource carries a query string —
// `/quote?symbol=AAPL`, the normal shape for an API — was therefore scored
// UNBOUND on every settle and dropped into the shared unbound pool, which is
// exactly the starvation F12 exists to prevent.
//
// The fix keeps canonicalization behind BazaarCatalog rather than in the route:
// the route must not re-implement the catalog's key derivation, because that is
// how the two drifted apart in the first place.

const PAY = "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A";
const OTHER = "GBQ3VANQZ6X3ZVGFTQJZ2MZ4KOCPZ5EGWSVYT7OPTQJ4M7VXMKQ3OQXD";
const CANONICAL = "https://api.merchant.example/quote";

function reqs(payTo: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND",
    amount: "1000000",
    payTo,
    maxTimeoutSeconds: 60,
    extra: {},
  } as PaymentRequirements;
}

function disc(): DiscoveredResource {
  return {
    resourceUrl: CANONICAL,
    x402Version: 2,
    discoveryInfo: { input: { type: "http", method: "GET" } },
  } as DiscoveredResource;
}

function bound(): BazaarCatalog {
  const c = new BazaarCatalog();
  c.upsertFromPayment(disc(), reqs(PAY));
  return c;
}

describe("G-3 — spend-policy identity must use the catalog's canonical key", () => {
  it("isBoundResource matches a bound merchant despite a query string", () => {
    const c = bound();
    // The catalog stores the canonical key...
    expect(c.isBound(CANONICAL, PAY), "precondition: bound under the canonical key").toBe(true);
    // ...but /settle receives the RAW url the buyer paid, query and all.
    expect(
      c.isBoundResource(`${CANONICAL}?symbol=AAPL&ts=1`, PAY),
      "a query string must not make a bound merchant look unbound",
    ).toBe(true);
  });

  it("normalizes the shapes a real payload varies in, without widening the binding", () => {
    const c = bound();
    for (const raw of [
      `${CANONICAL}?a=1`,
      `${CANONICAL}#frag`,
      `${CANONICAL}?a=1#frag`,
      CANONICAL,
    ]) {
      expect(c.isBoundResource(raw, PAY), `must match: ${raw}`).toBe(true);
    }
    // Canonicalization must NOT collapse distinct resources together.
    for (const raw of [
      "https://api.merchant.example/other",
      "https://evil.example/quote",
      "https://api.merchant.example:8443/quote",
    ]) {
      expect(c.isBoundResource(raw, PAY), `must NOT match: ${raw}`).toBe(false);
    }
  });

  it("still refuses a payTo that is not bound to that resource", () => {
    const c = bound();
    // Canonicalizing must not weaken the F11 check it feeds.
    expect(c.isBoundResource(`${CANONICAL}?x=1`, OTHER)).toBe(false);
  });

  it("returns the canonical key so per-URL budgets cannot be multiplied by query", () => {
    const c = bound();
    // If the budget key were the raw url, an attacker could mint a fresh
    // per-URL budget per query string. All of these must reduce to ONE key.
    const keys = new Set(
      [`${CANONICAL}?i=1`, `${CANONICAL}?i=2`, `${CANONICAL}#a`, CANONICAL].map((u) =>
        BazaarCatalog.canonicalResourceKey(u),
      ),
    );
    expect(keys.size, "all variants must collapse to one budget key").toBe(1);
    expect([...keys][0]).toBe(CANONICAL);
  });

  it("never throws on a malformed url — it degrades to the raw string", () => {
    // /settle takes this from a client-supplied payload, so it must not be a
    // crash vector; an unparseable value simply cannot match a binding.
    expect(() => BazaarCatalog.canonicalResourceKey("not a url")).not.toThrow();
    expect(bound().isBoundResource("not a url", PAY)).toBe(false);
    expect(bound().isBoundResource("", PAY)).toBe(false);
  });
});
