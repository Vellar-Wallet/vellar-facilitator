import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { describe, expect, it, vi } from "vitest";
import { BazaarCatalog } from "./catalog.js";

// A seller that advertises a URL Layer 2 can NEVER verify — http://localhost,
// a private literal, a routeTemplate key — produces an entry that looks normal
// and is permanently unverified. That is how examples/seller.mjs made ownership
// verification vacuous in production for its entire life without anything
// noticing.
//
// The signal has to distinguish "not verified YET" from "can never BE verified".
// With VERIFICATION_API_URL unset every entry already reads unverified, so the
// existing flag carries no information — the distinction is the whole point.

const ASSET = "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND";
const PAY = "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A";

function reqs(): PaymentRequirements {
  return { scheme: "exact", network: "stellar:testnet", asset: ASSET, amount: "1", payTo: PAY, maxTimeoutSeconds: 60, extra: {} } as PaymentRequirements;
}
function disc(url: string): DiscoveredResource {
  return { resourceUrl: url, x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as DiscoveredResource;
}

describe("structurally unverifiable entries are counted, not hidden", () => {
  it("counts an http:// resource — the seller.mjs failure", () => {
    const c = new BazaarCatalog();
    c.upsertFromPayment(disc("http://localhost:10000/quote"), reqs());
    expect(c.unverifiableCount, "an http url can never pass the https-only guard").toBe(1);
  });

  it("does NOT count a healthy public https resource", () => {
    const c = new BazaarCatalog();
    c.upsertFromPayment(disc("https://vellar-seller-demo.onrender.com/quote"), reqs());
    expect(c.unverifiableCount).toBe(0);
  });

  it("counts loopback and private literals even over https", () => {
    const c = new BazaarCatalog();
    c.upsertFromPayment(disc("https://localhost/x"), reqs());
    c.upsertFromPayment(disc("https://127.0.0.1/y"), reqs());
    c.upsertFromPayment(disc("https://10.0.0.5/z"), reqs());
    expect(c.unverifiableCount).toBe(3);
  });

  it("counts a routeTemplate key, which is not a fetchable URL", () => {
    const c = new BazaarCatalog();
    c.upsertFromPayment(disc("https://api.example/quote/:symbol"), reqs());
    expect(c.unverifiableCount).toBe(1);
  });

  it("warns ONCE when such an entry is cataloged, so it is not purely passive", () => {
    // /health is a standing signal, but nothing polls it now that the keep-alive
    // is off. The log line is the active half.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = new BazaarCatalog();
    c.upsertFromPayment(disc("http://localhost:10000/quote"), reqs());
    c.upsertFromPayment(disc("http://localhost:10000/quote"), reqs());
    const hits = warn.mock.calls.filter((x) => /never be ownership-verified/i.test(String(x[0])));
    expect(hits.length, "once per URL, not once per settlement").toBe(1);
    expect(String(hits[0]?.[0])).toMatch(/PUBLIC_BASE_URL|advertis/i);
    warn.mockRestore();
  });

  it("mixes correctly: only the unverifiable ones are counted", () => {
    const c = new BazaarCatalog();
    c.upsertFromPayment(disc("https://good.example/a"), reqs());
    c.upsertFromPayment(disc("http://bad.example/b"), reqs());
    c.upsertFromPayment(disc("https://also-good.example/c"), reqs());
    expect(c.size).toBe(3);
    expect(c.unverifiableCount).toBe(1);
  });
});
