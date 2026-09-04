import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { BazaarCatalog } from "./catalog.js";
import { buildFacilitator } from "./facilitator.js";
import { buildServer } from "./server.js";
import { fakeChannelAccountSecretKeys } from "./testChannelPoolKeys.js";

// USDT0 asset awareness — Option B, DISCOVERY ONLY.
//
// The facilitator stays asset-agnostic at settle time: the asset allowlist was
// evaluated and deliberately not adopted (docs/security-audit.md, F2), and
// nothing here reverses that. server.ts still never reads
// paymentRequirements.asset on the settle path. What this file covers is the
// read side — filtering listings by an asset a seller already chose, and
// reporting the live set of such assets on /supported.
//
// The security posture the tests below pin down: the asset param is an OPAQUE
// string compared by equality. It never reaches SQL (catalog.list/filter is an
// in-memory Map scan, and every statement in store.ts is a literal with bound
// `?` args) and never reaches Soroban RPC. So the tests assert the two things
// that can actually go wrong — an unbounded/malformed value getting through,
// and a malformed value being silently treated as "no filter", which would hand
// a caller every listing when they asked for one asset.

const testConfig = {
  port: 0, host: "127.0.0.1", network: "stellar:testnet" as const, rpcUrl: undefined,
  sponsorSecretKey: Keypair.random().secret(),
  channelAccountSecretKeys: fakeChannelAccountSecretKeys(), maxTransactionFeeStroops: 500_000,
  catalogDbUrl: undefined, uptoContractId: undefined,
  bondEscrowContractId: undefined, bondEscrowAdminSecretKey: undefined,
  catalogDbAuthToken: undefined, verificationApiUrl: undefined,
  spend: { rateWindowMs: 60_000, ceilingStroops: 50_000_000, windowMs: 60_000, perUrlMax: 10, perPayToMax: 50, unboundPoolMax: 10 },
  balance: { softFloorStroops: 250_000_000, hardFloorStroops: 100_000_000, intervalMs: 60_000 },
};

// The real addresses, so a copy-paste from docs/asset-support.md into a query
// exercises the same path these tests do.
const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const USDC_PUBNET = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const USDT0_PUBNET = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";

const OWNER_A = "GAOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OWNER_B = "GBOWNERBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function disc(url: string): DiscoveredResource {
  return {
    resourceUrl: url,
    x402Version: 2,
    discoveryInfo: { input: { type: "http", method: "GET" } },
  } as unknown as DiscoveredResource;
}

function reqs(payTo: string, asset: string, network = "stellar:testnet"): PaymentRequirements {
  return {
    scheme: "exact", network, asset, amount: "1000000", payTo, maxTimeoutSeconds: 60,
  } as unknown as PaymentRequirements;
}

/** A catalog with three listings:
 *   /usdc-only  — USDC (testnet) only
 *   /usdt0-only — USDT0 (pubnet) only
 *   /both       — USDC (testnet) AND USDT0 (pubnet), two accepts entries
 * The third exists because `asset` is part of the accepts dedup key, so one
 * resource priced in two assets is ONE listing with TWO accepts — the case a
 * naive filter gets wrong. */
async function seededCatalog() {
  const catalog = await BazaarCatalog.create();
  await catalog.upsertFromPayment(disc("https://a.example/usdc-only"), reqs(OWNER_A, USDC_TESTNET));
  await catalog.upsertFromPayment(disc("https://b.example/usdt0-only"), reqs(OWNER_B, USDT0_PUBNET, "stellar:pubnet"));
  await catalog.upsertFromPayment(disc("https://c.example/both"), reqs(OWNER_A, USDC_TESTNET));
  await catalog.upsertFromPayment(disc("https://c.example/both"), reqs(OWNER_A, USDT0_PUBNET, "stellar:pubnet"));
  return catalog;
}

async function appWith(catalog: BazaarCatalog) {
  const app = await buildServer(buildFacilitator(testConfig), catalog);
  await app.ready();
  return app;
}

const get = async (app: Awaited<ReturnType<typeof appWith>>, url: string) =>
  app.inject({ method: "GET", url });

describe("/discovery/resources?asset= — filtering", () => {
  it("1. asset=<USDC> returns only listings whose accepts include USDC", async () => {
    const app = await appWith(await seededCatalog());
    try {
      const body = (await get(app, `/discovery/resources?asset=${USDC_TESTNET}`)).json();
      const urls = body.items.map((i: { resource: string }) => i.resource).sort();
      expect(urls).toEqual(["https://a.example/usdc-only", "https://c.example/both"]);
      // The USDT0-only listing is excluded even though it is a perfectly valid
      // listing — which is the whole point of the filter.
      expect(urls).not.toContain("https://b.example/usdt0-only");
      expect(body.pagination.total, "total describes the filtered set").toBe(2);
    } finally {
      await app.close();
    }
  });

  it("2. asset=<USDT0> returns only USDT0 listings", async () => {
    const app = await appWith(await seededCatalog());
    try {
      const body = (await get(app, `/discovery/resources?asset=${USDT0_PUBNET}`)).json();
      const urls = body.items.map((i: { resource: string }) => i.resource).sort();
      expect(urls).toEqual(["https://b.example/usdt0-only", "https://c.example/both"]);
    } finally {
      await app.close();
    }
  });

  it("2b. an asset with NO listings returns an empty array, not an error", async () => {
    // "No seller accepts this yet" is a correct answer, not a failure. A 404 or
    // a 400 here would tell an agent the asset is invalid, which is a different
    // and wrong claim — the facilitator has no registry of valid assets.
    const app = await appWith(await seededCatalog());
    try {
      const res = await get(app, `/discovery/resources?asset=${USDC_PUBNET}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([]);
      expect(res.json().pagination.total).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("3. no asset param returns every listing — existing behaviour unchanged", async () => {
    const app = await appWith(await seededCatalog());
    try {
      const body = (await get(app, "/discovery/resources")).json();
      expect(body.items).toHaveLength(3);
      expect(body.pagination.total).toBe(3);
    } finally {
      await app.close();
    }
  });

  it("9. the filter is CASE SENSITIVE — a lowercased address matches nothing", async () => {
    // Stellar contract addresses are base32 and case-sensitive. Lowercasing
    // either side would silently match a different asset, or none, while
    // looking like it worked.
    const app = await appWith(await seededCatalog());
    try {
      const res = await get(app, `/discovery/resources?asset=${USDC_TESTNET.toLowerCase()}`);
      expect(res.statusCode, "still a well-formed request").toBe(200);
      expect(res.json().items, "but it matches nothing").toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("10. asset AND network are combined as AND, never a union", async () => {
    // MUTATION: return early with `true` once any filter matches. /both then
    // leaks into the testnet+USDT0 query, because it matches each filter
    // separately — just not together.
    const app = await appWith(await seededCatalog());
    try {
      const both = (await get(
        app,
        `/discovery/resources?asset=${USDC_TESTNET}&network=stellar:testnet`,
      )).json();
      expect(both.items.map((i: { resource: string }) => i.resource).sort()).toEqual([
        "https://a.example/usdc-only",
        "https://c.example/both",
      ]);

      // A listing with NO testnet accepts at all is excluded, proving the
      // network filter is still applied rather than being swallowed by the
      // asset one. /usdt0-only is pubnet-only, so it drops out here.
      const narrowed = (await get(
        app,
        `/discovery/resources?asset=${USDT0_PUBNET}&network=stellar:testnet`,
      )).json();
      expect(
        narrowed.items.map((i: { resource: string }) => i.resource),
        "the pubnet-only listing is filtered out by network",
      ).toEqual(["https://c.example/both"]);

      // WHY /both SURVIVES, and why that is correct rather than a leak: each
      // filter is an independent `accepts.some(...)`, so /both qualifies via
      // its USDT0/pubnet entry for the asset and its USDC/testnet entry for the
      // network. The two predicates may be satisfied by DIFFERENT accepts
      // entries. That is precisely how the pre-existing payTo/scheme/network
      // filters already behave — the asset filter deliberately matches their
      // semantics rather than inventing a stricter same-entry rule, which would
      // have silently changed what `?payTo=X&network=Y` means. A caller needing
      // "one accepts entry satisfying both" must intersect client-side.
      const bothEntries = narrowed.items[0].accepts as Array<{ asset: string; network: string }>;
      expect(bothEntries.some((a) => a.asset === USDT0_PUBNET)).toBe(true);
      expect(bothEntries.some((a) => a.network === "stellar:testnet")).toBe(true);
      expect(
        bothEntries.some((a) => a.asset === USDT0_PUBNET && a.network === "stellar:testnet"),
        "and NO single entry satisfies both — the match is across entries",
      ).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("/discovery/resources?asset= — validation", () => {
  const bad = async (url: string) => {
    const app = await appWith(await seededCatalog());
    try {
      const res = await get(app, url);
      return { status: res.statusCode, body: res.json() };
    } finally {
      await app.close();
    }
  };

  it("4. an empty asset param is 400 invalid_asset", async () => {
    // Rejected rather than ignored. Treating `?asset=` as "no filter" would
    // hand back every listing to a caller who explicitly asked to narrow.
    const { status, body } = await bad("/discovery/resources?asset=");
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_asset");
    expect(body.detail, "says what would be acceptable").toBeTruthy();
  });

  it("4b. a whitespace-only asset param is 400 — empty after trimming", async () => {
    const { status, body } = await bad("/discovery/resources?asset=%20%20%20");
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_asset");
  });

  it("5. an asset param containing whitespace is 400", async () => {
    const { status, body } = await bad(
      `/discovery/resources?asset=${encodeURIComponent("CBIELTK6 YBZJU5UP")}`,
    );
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_asset");
  });

  it("6. an asset param longer than 56 characters is 400", async () => {
    // A SAC is exactly 56 chars, so anything longer cannot be one. This is also
    // what bounds the value before it reaches the per-request scan.
    const { status, body } = await bad(`/discovery/resources?asset=${"C".repeat(57)}`);
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_asset");
  });

  it("6b. exactly 56 characters passes the length check", async () => {
    const app = await appWith(await seededCatalog());
    try {
      const res = await get(app, `/discovery/resources?asset=${"C".repeat(56)}`);
      expect(res.statusCode, "at the boundary, not over it").toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("/discovery/resources?asset= — hostile input", () => {
  const probe = async (raw: string) => {
    const app = await appWith(await seededCatalog());
    try {
      const res = await get(app, `/discovery/resources?asset=${encodeURIComponent(raw)}`);
      return { status: res.statusCode, body: res.body };
    } finally {
      await app.close();
    }
  };

  it("11. SQL-injection shaped input is never a server error", async () => {
    // It cannot reach SQL at all — catalog.list/filter is an in-memory Map scan,
    // and every statement in store.ts is a literal with bound `?` args. This
    // asserts the OBSERVABLE consequence: a structured answer, never a 500, and
    // never the whole catalog.
    for (const payload of [
      "' OR '1'='1",
      "'; DROP TABLE entry; --",
      "CBIELTK6'--",
      "\" OR 1=1 --",
      "1; SELECT * FROM ownership",
    ]) {
      const { status, body } = await probe(payload);
      expect([200, 400], `payload ${payload} gave ${status}`).toContain(status);
      if (status === 200) {
        // A well-formed-but-meaningless value matches nothing. It must NOT
        // behave like "no filter".
        expect(JSON.parse(body).items, `payload ${payload} leaked listings`).toEqual([]);
      }
      expect(status, "never a server error").not.toBe(500);
    }
  });

  it("12. a NUL byte is rejected with 400 before it reaches the filter", async () => {
    const { status, body } = await probe(`CBIELTK6${String.fromCharCode(0)}YBZJU5UP`);
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toBe("invalid_asset");
  });

  it("12b. other control characters are rejected too", async () => {
    for (const code of [1, 9, 10, 13, 31, 127]) {
      const { status } = await probe(`CBIELTK6${String.fromCharCode(code)}YBZJU5UP`);
      expect(status, `control char ${code} must be refused`).toBe(400);
    }
  });

  it("13. a 56-char string that is not a real address is accepted and matches nothing", async () => {
    // DELIBERATE: the facilitator has no registry of legitimate assets, so it
    // cannot say "that asset does not exist" without implying an allowlist it
    // does not have (docs/security-audit.md, F2). An empty result is the honest
    // answer; a 400 would be a claim it is not entitled to make.
    const app = await appWith(await seededCatalog());
    try {
      const res = await get(app, `/discovery/resources?asset=${"Z".repeat(56)}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("/supported — catalogAssets", () => {
  it("7. is always present, with both network keys, even on an empty catalog", async () => {
    // A client must be able to read catalogAssets["stellar:pubnet"] and get an
    // array rather than undefined, whatever the catalog holds.
    const app = await appWith(await BazaarCatalog.create());
    try {
      const body = (await get(app, "/supported")).json();
      expect(body).toHaveProperty("catalogAssets");
      expect(body.catalogAssets["stellar:testnet"]).toEqual([]);
      expect(body.catalogAssets["stellar:pubnet"]).toEqual([]);
      // The x402 spec fields are passed through untouched.
      expect(body).toHaveProperty("kinds");
      expect(body).toHaveProperty("extensions");
      expect(body).toHaveProperty("signers");
    } finally {
      await app.close();
    }
  });

  it("7b. reflects the assets actually in the catalog, grouped by network", async () => {
    const app = await appWith(await seededCatalog());
    try {
      const { catalogAssets } = (await get(app, "/supported")).json();
      expect(catalogAssets["stellar:testnet"]).toEqual([USDC_TESTNET]);
      expect(catalogAssets["stellar:pubnet"]).toEqual([USDT0_PUBNET]);
    } finally {
      await app.close();
    }
  });

  it("7c. de-duplicates an asset accepted by several listings", async () => {
    // USDC is on two listings in the fixture; it must appear once.
    const app = await appWith(await seededCatalog());
    try {
      const { catalogAssets } = (await get(app, "/supported")).json();
      expect(catalogAssets["stellar:testnet"]).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("8. a novel asset appears with no config change and no restart", async () => {
    // THE POINT of deriving this live. MUTATION: hardcode the asset list, or
    // cache it at boot — this then fails, because the new asset never shows up.
    const catalog = await seededCatalog();
    const app = await appWith(catalog);
    try {
      const before = (await get(app, "/supported")).json().catalogAssets["stellar:testnet"];
      expect(before).not.toContain("CNOVELASSETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

      // A real settlement catalogs a listing that accepts a previously unseen
      // asset — the same path production takes.
      await catalog.upsertFromPayment(
        disc("https://d.example/novel"),
        reqs(OWNER_B, "CNOVELASSETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      );

      const after = (await get(app, "/supported")).json().catalogAssets["stellar:testnet"];
      expect(after).toContain("CNOVELASSETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      expect(after, "and the existing one is still there").toContain(USDC_TESTNET);
    } finally {
      await app.close();
    }
  });
});

describe("/discovery/search is untouched by this change", () => {
  it("ignores an asset param rather than filtering on it", async () => {
    // asset is deliberately Omit-ted from SearchQuery. Search is out of scope,
    // and this pins that down so a future edit to ListQuery cannot quietly
    // extend the filter into the search scorer.
    const app = await appWith(await seededCatalog());
    try {
      const withAsset = await get(app, `/discovery/search?query=usdc-only&asset=${USDT0_PUBNET}`);
      expect(withAsset.statusCode, "not rejected, just not a filter here").toBe(200);
      const plain = await get(app, "/discovery/search?query=usdc-only");
      expect(withAsset.json().resources).toEqual(plain.json().resources);
    } finally {
      await app.close();
    }
  });
});
