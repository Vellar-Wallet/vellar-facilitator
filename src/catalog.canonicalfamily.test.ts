import { describe, expect, it, vi } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { BazaarCatalog, normalizePath } from "./catalog.js";
import { reopen, seedRows, tmpStore } from "./store.testkit.js";

// ============================================================================
// G-11 — one resource must have ONE key.
//
// G-3 fixed the query-string instance of this. The live run on 2026-08-11 found
// the trailing-slash instance: `…/quote` and `…/quote/` were separately
// bindable, the seller served a 402 at both, and a squatter only has to take the
// spelling its owner never settled against.
//
// This file covers the FAMILY, and — as important — pins what is deliberately
// NOT normalised. Over-normalising merges genuinely distinct resources, which is
// the same bug pointing the other way: one merchant's binding covering another's
// endpoint.
// ============================================================================

const OWNER = "GAOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SQUAT = "GBSQUATBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const key = (u: string) => BazaarCatalog.canonicalResourceKey(u);

function disc(url: string): DiscoveredResource {
  return {
    resourceUrl: url,
    x402Version: 2,
    discoveryInfo: { input: { type: "http", method: "GET" } },
  } as unknown as DiscoveredResource;
}
function reqs(payTo: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CASSET",
    amount: "1",
    payTo,
    maxTimeoutSeconds: 60,
  } as unknown as PaymentRequirements;
}

describe("normalised — these spellings are ONE resource", () => {
  const CANON = "https://api.example.com/quote";
  const equivalent: [string, string][] = [
    // MUTATION: delete the trailing-slash strip in normalizePath.
    ["trailing slash", "https://api.example.com/quote/"],
    // MUTATION: delete the duplicate-slash collapse.
    ["duplicate slashes", "https://api.example.com//quote"],
    ["duplicate slashes, many", "https://api.example.com///quote"],
    // MUTATION: drop the UNRESERVED decode branch (return the escape unchanged).
    ["percent-encoded unreserved", "https://api.example.com/qu%6Fte"],
    ["percent-encoded, mixed", "https://api.example.com/%71uote"],
    // These four are handled by `new URL()` itself; asserted so that swapping the
    // parser cannot quietly drop them.
    ["host case", "https://API.EXAMPLE.COM/quote"],
    ["scheme case", "HTTPS://api.example.com/quote"],
    ["explicit default port", "https://api.example.com:443/quote"],
    ["dot segments", "https://api.example.com/x/../quote"],
    ["fragment", "https://api.example.com/quote#section"],
    ["query string (G-3)", "https://api.example.com/quote?topic=x"],
    ["userinfo", "https://user:pw@api.example.com/quote"],
    ["all at once", "HTTPS://API.EXAMPLE.COM:443//x/..//qu%6Fte/?a=1#f"],
  ];
  for (const [label, raw] of equivalent) {
    it(`${label} -> the canonical key`, () => {
      expect(key(raw), raw).toBe(CANON);
    });
  }

  it("percent-escape HEX is uppercased without being decoded", () => {
    // %2F is a RESERVED octet: decoding it would invent a path separator and
    // turn one segment into two, which is a way to forge a different resource.
    // Only the hex case is normalised.
    //
    // MUTATION: decode all escapes rather than only unreserved ones. `/a%2fb`
    // becomes `/a/b`, a DIFFERENT resource, and this fails.
    expect(key("https://api.example.com/a%2fb")).toBe("https://api.example.com/a%2Fb");
    expect(key("https://api.example.com/a%2Fb")).toBe("https://api.example.com/a%2Fb");
  });

  it("the root path survives as `/` rather than collapsing to empty", () => {
    // MUTATION: strip the trailing slash unconditionally. The root becomes
    // `https://api.example.com` with no path, which is a different key from
    // every other spelling of the same root.
    expect(key("https://api.example.com/")).toBe("https://api.example.com/");
    expect(key("https://api.example.com")).toBe("https://api.example.com/");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });
});

describe("NOT normalised — these are different resources, deliberately", () => {
  it("path case is preserved", () => {
    // MUTATION: lowercase the path in normalizePath. Two merchants on one origin
    // with `/Quote` and `/quote` collide, and the first to bind covers both —
    // over-normalising is the same vulnerability pointing the other way.
    expect(key("https://api.example.com/QUOTE")).not.toBe(key("https://api.example.com/quote"));
  });

  it("index files are preserved", () => {
    // Only equivalent on servers configured that way, which cannot be known from
    // here. MUTATION: strip a trailing `/index.html`.
    expect(key("https://api.example.com/docs/index.html")).not.toBe(key("https://api.example.com/docs"));
  });

  it("www and apex are different origins", () => {
    // MUTATION: strip a leading `www.` from the host.
    expect(key("https://www.example.com/quote")).not.toBe(key("https://example.com/quote"));
  });

  it("http and https are different origins", () => {
    // MUTATION: force the scheme to https. Beyond being wrong, http can never
    // verify — the SSRF guard rejects it before a socket opens — so merging them
    // would let an unverifiable spelling inherit a verified binding.
    expect(key("http://api.example.com/quote")).not.toBe(key("https://api.example.com/quote"));
  });

  it("a non-default port is part of the identity", () => {
    // MUTATION: drop the port unconditionally instead of letting URL drop only
    // the default one.
    expect(key("https://api.example.com:8443/quote")).not.toBe(key("https://api.example.com/quote"));
  });

  it("an unparseable url degrades to itself rather than throwing", () => {
    // /settle takes this from a client-supplied payload, so it must not be a
    // crash vector. MUTATION: remove the try/catch.
    expect(() => key("not a url")).not.toThrow();
    expect(key("not a url")).toBe("not a url");
  });
});

describe("the squat this closes", () => {
  it("a squatter cannot take the trailing-slash spelling of a bound URL", () => {
    // The live finding, as a test. Before the fix these were two entries and B
    // held one of them.
    //
    // MUTATION: revert canonicalResourceKey to `${u.origin}${u.pathname}`. B
    // binds the slash variant and the catalog holds two entries.
    const catalogKeyOwner = key("https://api.example.com/quote");
    const catalogKeySquat = key("https://api.example.com/quote/");
    expect(catalogKeySquat, "one resource, one key").toBe(catalogKeyOwner);
  });

  it("end to end: the owner binds, and every spelling is then refused", async () => {
    // MUTATION: as above. The second upsert becomes a FIRST catalog under a
    // separate key and returns true, binding the victim's URL to the squatter.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    expect(await catalog.upsertFromPayment(disc("https://api.example.com/quote"), reqs(OWNER))).toBe(true);

    for (const spelling of [
      "https://api.example.com/quote/",
      "https://api.example.com//quote",
      "https://API.EXAMPLE.COM/quote",
      "https://api.example.com/qu%6Fte",
      "https://api.example.com:443/quote",
    ]) {
      expect(
        await catalog.upsertFromPayment(disc(spelling), reqs(SQUAT)),
        `${spelling} must not become a second identity`,
      ).toBe(false);
    }
    expect(catalog.size, "still one entry").toBe(1);
    expect(catalog.isBound("https://api.example.com/quote/", OWNER), "and the owner holds every spelling").toBe(
      true,
    );
  });
});

describe("rows written under the OLD key scheme", () => {
  it("are re-canonicalised on load, so a URL does not silently become claimable", async () => {
    // THE DEPLOY QUESTION. `resource_key` is stored as whatever the canonicaliser
    // produced at the time, and that function has now changed twice. Without
    // re-canonicalising on load, a row written as `…/quote/` keeps a key nothing
    // can produce again — and the collapsed key `…/quote` would be UNBOUND and
    // claimable by the next settler.
    //
    // MUTATION: revert the load loop to `ownership.set(b.resourceKey, ...)`. The
    // binding lands under the stale key, `isBound` on the canonical form is
    // false, and a squatter takes it.
    const { url } = tmpStore();
    await seedRows(url, {
      ownership: [{ key: "https://api.example.com/quote/", payTo: OWNER }],
      entries: [
        {
          key: "https://api.example.com/quote/",
          payload: {
            resource: {
              resource: "https://api.example.com/quote/",
              type: "http",
              x402Version: 2,
              lastUpdated: "2026-08-01T00:00:00.000Z",
              accepts: [
                { scheme: "exact", network: "stellar:testnet", asset: "CASSET", amount: "1", payTo: OWNER },
              ],
            },
            stats: { settlements: 4, payers: ["CP1"], observed: 0 },
          },
        },
      ],
    });

    const catalog = await BazaarCatalog.create(reopen(url));
    expect(catalog.isBound("https://api.example.com/quote", OWNER), "bound under the NEW key").toBe(true);
    expect(catalog.size, "and served as one entry").toBe(1);
    expect(
      await catalog.upsertFromPayment(disc("https://api.example.com/quote"), reqs(SQUAT)),
      "so it is not claimable",
    ).toBe(false);
  });

  it("when two old rows collapse onto one key, PROOF wins and the payTos are never unioned", async () => {
    // A squatter holding one spelling and the real owner the other is exactly the
    // state the live deployment was in. Unioning would hand the squatter a claim
    // on the survivor's key; taking the wrong one would hand them the URL.
    //
    // MUTATION: union the arrays (`existing.concat(b.boundPayTo)`). The squatter
    // becomes an acceptable payee on the owner's binding.
    const { url } = tmpStore();
    await seedRows(url, {
      ownership: [
        { key: "https://api.example.com/quote", payTo: SQUAT }, // canonical spelling, unverified
        { key: "https://api.example.com/quote/", payTo: OWNER }, // other spelling, will be verified
      ],
    });
    // Mark the OWNER's row verified, so proof and canonical-spelling disagree and
    // the tie-break has to choose proof.
    const s = reopen(url);
    await s.markVerified("https://api.example.com/quote/", OWNER, 1);
    await s.close();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = await BazaarCatalog.create(reopen(url));

    // Asserted through BEHAVIOUR, not internals: these rows have no entry, so
    // `isBound` (which reads entries) would report false for everyone and prove
    // nothing. The F3 tombstone check is what consults ownership directly.
    expect(catalog.isEverVerified("https://api.example.com/quote"), "proof survived the merge").toBe(true);
    expect(
      await catalog.upsertFromPayment(disc("https://api.example.com/quote"), reqs(SQUAT)),
      "the dropped binding gives the squatter nothing",
    ).toBe(false);
    expect(
      await catalog.upsertFromPayment(disc("https://api.example.com/quote"), reqs(OWNER)),
      "and the surviving owner can still catalog",
    ).toBe(true);
    expect(catalog.isBound("https://api.example.com/quote", OWNER)).toBe(true);
    expect(catalog.isBound("https://api.example.com/quote", SQUAT)).toBe(false);
    expect(
      warn.mock.calls.some((c) => /normalises to/.test(String(c[0]))),
      "and it must say so — a dropped binding that nobody logged is unexplainable later",
    ).toBe(true);
    warn.mockRestore();
  });
});
