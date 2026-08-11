import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { BazaarCatalog, MAX_PAYTO_LEN } from "./catalog.js";
import { policyBucketKey } from "./server.js";
import { tmpStore } from "./store.testkit.js";

// ============================================================================
// THE CLASS, not the instances.
//
// G-11 was reported as "the canonical key does not strip a trailing slash". The
// actual finding was structural: ONE IDENTITY HAD SEVERAL DERIVATIONS, and they
// agreed only because one seller happened to report one stable URL.
//
//   resource url   upsertFromPayment keyed on the RAW advertised url, while
//                  recordSettlement / isBoundResource / the spend policy all
//                  keyed on the canonical form. G-3 fixed the policy side; this
//                  side was never checked against it.
//   payTo          policyBucketKey trimmed and length-capped it; the catalog
//                  compared the raw string. So `"G… "` and `"G…"` were ONE
//                  rate-limit bucket and TWO catalog identities.
//
// Neither had a test that the derivations agreed, because each was tested
// against its own definition. This file tests the AGREEMENT, which is the only
// thing that was ever actually load-bearing.
// ============================================================================

const OWNER = "GAOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function disc(url: string): DiscoveredResource {
  return {
    resourceUrl: url,
    x402Version: 2,
    discoveryInfo: { input: { type: "http", method: "GET" } },
  } as unknown as DiscoveredResource;
}
function reqs(payTo: unknown): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CASSET",
    amount: "1",
    payTo,
    maxTimeoutSeconds: 60,
  } as unknown as PaymentRequirements;
}

describe("payTo — one derivation, shared", () => {
  const corpus: unknown[] = [
    OWNER,
    ` ${OWNER}`,
    `${OWNER} `,
    `\t${OWNER}\n`,
    "",
    "   ",
    "G".repeat(MAX_PAYTO_LEN),
    "G".repeat(MAX_PAYTO_LEN + 1),
    undefined,
    null,
    42,
    { payTo: OWNER },
    ["G"],
  ];

  it("the catalog and the spend policy agree on every input, including the junk", () => {
    // MUTATION: reinstate a second copy of the rule in policyBucketKey — e.g.
    // drop the .trim(). The padded variants then disagree: one bucket, two
    // identities, which is the hijack described above.
    //
    // policyBucketKey is not exported (it is a route-level detail), so the
    // agreement is asserted through the derivation both sides now call. The
    // point is that there IS only one, and this test fails the moment a second
    // appears that disagrees.
    // THE AGREEMENT ITSELF. Both sides are called and compared on the same
    // corpus — this is the assertion that never existed, and its absence is what
    // let the two drift apart while each stayed green against its own definition.
    for (const input of corpus) {
      const catalogIdentity = BazaarCatalog.canonicalPayTo(input);
      const policyBucket = policyBucketKey(input);
      expect(policyBucket, `disagreement for ${JSON.stringify(input)}`).toBe(
        catalogIdentity ?? "<no-payto>",
      );
    }
    expect(BazaarCatalog.canonicalPayTo(` ${OWNER} `), "whitespace is not identity").toBe(OWNER);
    expect(BazaarCatalog.canonicalPayTo(OWNER)).toBe(OWNER);
    expect(BazaarCatalog.canonicalPayTo(""), "empty is not an identity").toBeUndefined();
    expect(BazaarCatalog.canonicalPayTo(42), "non-strings are not identities").toBeUndefined();
    expect(BazaarCatalog.canonicalPayTo("G".repeat(MAX_PAYTO_LEN + 1)), "over the cap").toBeUndefined();
  });

  it("a padded copy of the owner's address cannot become a second identity", async () => {
    // THE HIJACK VARIANT. Before the fix this bound the URL to a string that
    // renders identically in /discovery/resources while the owner's own clean
    // address read as "not bound" — locked out of their URL, permanently,
    // by something invisible on screen.
    //
    // MUTATION: remove the canonicalPayTo call from upsertFromPayment. The
    // padded form becomes a distinct identity and this fails.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    expect(await catalog.upsertFromPayment(disc("https://api.example.com/q"), reqs(` ${OWNER}`))).toBe(true);

    // The clean address must be the SAME owner, not a stranger.
    expect(catalog.isBound("https://api.example.com/q", OWNER), "one identity").toBe(true);
    // A second settle by the SAME (now canonical) owner is an ordinary update,
    // not a refused hijack — which is the whole point: they are one party.
    expect(
      await catalog.upsertFromPayment(disc("https://api.example.com/q"), reqs(OWNER)),
      "and the owner is not locked out of their own URL",
    ).toBe(false);
    expect(catalog.isBound("https://api.example.com/q", OWNER), "still theirs").toBe(true);
  });

  it("an unusable payTo is REFUSED, never bound", async () => {
    // A binding nobody can ever match removes the URL from its owner for good.
    // MUTATION: return the raw value instead of undefined for junk. The upsert
    // succeeds and the URL is bound to something unmatched by any real payment.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    for (const junk of ["", "   ", "G".repeat(MAX_PAYTO_LEN + 1), 42, null]) {
      expect(
        await catalog.upsertFromPayment(disc("https://api.example.com/junk"), reqs(junk)),
        `${JSON.stringify(junk)} must not bind`,
      ).toBe(false);
    }
    expect(catalog.size, "nothing was cataloged").toBe(0);
  });
});

describe("resource url — one derivation, shared", () => {
  it("every keyed call site agrees with upsertFromPayment", async () => {
    // MUTATION: revert any one of upsertFromPayment / isBound / isVerifiedOwner /
    // setVerifiedOwner to the raw url. That call site then disagrees with the
    // others for any spelling where raw != canonical, which is exactly the state
    // that went unnoticed for the whole engagement.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    const CANON = "https://api.example.com/quote";
    await catalog.upsertFromPayment(disc(CANON), reqs(OWNER));

    for (const spelling of [
      CANON,
      "https://api.example.com/quote/",
      "https://api.example.com//quote",
      "https://API.EXAMPLE.COM/quote",
      "https://api.example.com/quote?x=1",
      "https://api.example.com/qu%6Fte",
    ]) {
      expect(catalog.isBound(spelling, OWNER), `isBound: ${spelling}`).toBe(true);
      expect(catalog.isBoundResource(spelling, OWNER), `isBoundResource: ${spelling}`).toBe(true);
      expect(catalog.recordSettlement(spelling, "CPAYER", OWNER), `recordSettlement: ${spelling}`).toBe(true);
      // setVerifiedOwner/isVerifiedOwner round-trip through the same key.
      // Both directions must use the spelling, or a raw-keyed reader passes by
      // being handed the canonical form it was going to look up anyway.
      catalog.setVerifiedOwner(spelling, true);
      expect(catalog.isVerifiedOwner(spelling), `isVerifiedOwner: ${spelling}`).toBe(true);
      expect(catalog.isVerifiedOwner(CANON), `setVerifiedOwner: ${spelling}`).toBe(true);
      catalog.setVerifiedOwner(spelling, false);
    }
    expect(catalog.size, "and it was one resource the whole time").toBe(1);
  });
});
