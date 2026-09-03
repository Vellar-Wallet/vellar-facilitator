import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { BazaarCatalog, KEY_SEPARATOR, MAX_TOOL_NAME_LEN } from "./catalog.js";
import { reopen, tmpStore } from "./store.testkit.js";

// RFP gap #3 — MCP TOOL COMPOUND KEY.
//
// THE BUG. An MCP server exposes many tools at ONE url. The catalog keyed on
// the url alone, so every tool on a server collapsed into a single entry: the
// second tool's settlement either overwrote the first's metadata, or was
// refused outright as an unbound-payTo hijack — decided only by whether the two
// tools happened to share a payTo. The x402 Bazaar spec keys an MCP resource on
// the tuple (resource.url, input.toolName); this file asserts that tuple is now
// the identity, end to end, including across a restart.
//
// THE PRIOR BUG CLASS THIS MUST NOT REPEAT (docs/closing-state.md §3.7, the
// class behind G-3, G-11 and G-14): one identity derived independently at
// several call sites, each tested against its own definition, agreeing only
// while the inputs coincided. So the assertions below are about AGREEMENT
// between the write path, the lookup paths and the boot re-canonicalisation —
// not about any one of them in isolation.

const OWNER = "GAOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "GBOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MCP_URL = "https://mcp.example.com/tools";

/** An MCP DiscoveredResource, shaped as extractDiscoveryInfo really returns it:
 *  toolName lives at discoveryInfo.input.toolName (McpDiscoveryInfo), and the
 *  SDK also copies it to a top-level toolName on DiscoveredMCPResource. Both are
 *  set here so the fixture cannot pass by accident against a reader that looks
 *  at only one of them. */
function mcp(url: string, toolName: string): DiscoveredResource {
  return {
    resourceUrl: url,
    x402Version: 2,
    toolName,
    discoveryInfo: {
      input: { type: "mcp", toolName, inputSchema: { type: "object" } },
    },
  } as unknown as DiscoveredResource;
}

/** An ordinary HTTP DiscoveredResource — no toolName anywhere. */
function http(url: string): DiscoveredResource {
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

describe("canonicalResourceKey — the compound derivation itself", () => {
  it("keys an MCP resource on (url, toolName), separated by the Unit Separator", () => {
    expect(BazaarCatalog.canonicalResourceKey(MCP_URL, "weather")).toBe(
      `${MCP_URL}${KEY_SEPARATOR}weather`,
    );
  });

  it("two tools on ONE url produce two different keys", () => {
    // The whole point of the change, at the derivation level.
    const a = BazaarCatalog.canonicalResourceKey(MCP_URL, "weather");
    const b = BazaarCatalog.canonicalResourceKey(MCP_URL, "forecast");
    expect(a).not.toBe(b);
  });

  it("an omitted toolName returns the url-only key, byte-identical to before", () => {
    // MUTATION: always append the separator. Every stored HTTP key then stops
    // matching its own row and the whole catalog silently unbinds on restart.
    expect(BazaarCatalog.canonicalResourceKey("https://api.example.com/quote")).toBe(
      "https://api.example.com/quote",
    );
    expect(BazaarCatalog.canonicalResourceKey("https://api.example.com/quote")).not.toContain(
      KEY_SEPARATOR,
    );
  });

  it("url canonicalisation still applies underneath the compound key", () => {
    // The compound key is built ON the canonical url, not the raw one — so the
    // G-3/G-11 family (trailing slash, case, query, double slash) collapses
    // exactly as it does for HTTP resources.
    const canonical = BazaarCatalog.canonicalResourceKey(MCP_URL, "weather");
    for (const spelling of [
      "https://mcp.example.com/tools/",
      "https://MCP.EXAMPLE.COM/tools",
      "https://mcp.example.com//tools",
      "https://mcp.example.com/tools?x=1",
    ]) {
      expect(BazaarCatalog.canonicalResourceKey(spelling, "weather"), spelling).toBe(canonical);
    }
  });
});

describe("canonicalResourceKey — toolName is seller-supplied and hostile", () => {
  it("strips the separator from toolName, so a seller cannot forge a key boundary", () => {
    // The separator must only ever be OURS. A surviving separator would let a
    // toolName draw its own boundary inside the key.
    const key = BazaarCatalog.canonicalResourceKey(MCP_URL, "wea\x1Fther");
    expect(key).toBe(`${MCP_URL}${KEY_SEPARATOR}weather`);
    // Exactly one separator in the whole key: the one we put there.
    expect(key!.split(KEY_SEPARATOR)).toHaveLength(2);
  });

  it("collision resistance: (a, b\\x1Fc) and (a\\x1Fb, c) cannot produce the same key", () => {
    // THE ATTACK the separator choice exists to defeat. With a printable
    // separator these two collide exactly, letting a hostile seller pick a
    // toolName that lands on a victim's entry. Here the separator is stripped from
    // the toolName, and percent-encoded out of the url by new URL(), so the
    // two are unequal by construction.
    const left = BazaarCatalog.canonicalResourceKey("https://x.example/a", "b\x1Fc");
    const right = BazaarCatalog.canonicalResourceKey("https://x.example/a\x1Fb", "c");
    expect(left).not.toBe(right);
  });

  it("the separator cannot survive into the key from the URL side either", () => {
    // new URL() percent-encodes U+001F in the path, so the url half can never
    // contribute a second separator.
    const key = BazaarCatalog.canonicalResourceKey("https://x.example/a\x1Fb", "tool");
    expect(key!.split(KEY_SEPARATOR)).toHaveLength(2);
  });

  it("rejects an empty toolName rather than silently returning a url-only key", () => {
    // MUTATION: fall back to the url-only key when toolName is empty. The MCP
    // resource then lands on the plain url entry — which may belong to a
    // different seller — which is the silent merge this change removes.
    expect(BazaarCatalog.canonicalResourceKey(MCP_URL, "")).toBeUndefined();
    // Empty only AFTER stripping counts as empty too.
    expect(BazaarCatalog.canonicalResourceKey(MCP_URL, "\x1F\x1F")).toBeUndefined();
  });

  it("rejects a toolName over the cap — never truncates it", () => {
    // Truncation would map two distinct long tool names onto ONE key, which is
    // the exact collision compound keying exists to remove. Rejection is the
    // only safe answer, matching canonicalPayTo's undefined for an over-long
    // payTo.
    const atCap = "t".repeat(MAX_TOOL_NAME_LEN);
    const overCap = "t".repeat(MAX_TOOL_NAME_LEN + 1);
    expect(BazaarCatalog.canonicalResourceKey(MCP_URL, atCap)).toBe(
      `${MCP_URL}${KEY_SEPARATOR}${atCap}`,
    );
    expect(BazaarCatalog.canonicalResourceKey(MCP_URL, overCap)).toBeUndefined();
    // And two distinct over-cap names are BOTH refused, rather than colliding
    // on a shared truncated prefix.
    expect(BazaarCatalog.canonicalResourceKey(MCP_URL, `${overCap}A`)).toBeUndefined();
    expect(BazaarCatalog.canonicalResourceKey(MCP_URL, `${overCap}B`)).toBeUndefined();
  });

  it("the cap is measured AFTER stripping, so separator padding cannot smuggle length", () => {
    const padded = "t".repeat(MAX_TOOL_NAME_LEN) + "\x1F".repeat(50);
    expect(BazaarCatalog.canonicalResourceKey(MCP_URL, padded)).toBe(
      `${MCP_URL}${KEY_SEPARATOR}${"t".repeat(MAX_TOOL_NAME_LEN)}`,
    );
  });
});

describe("splitResourceKey — the inverse used by the boot re-canonicalisation", () => {
  it("round-trips a compound key through split → re-derive, unchanged", () => {
    // THE FIXED-POINT PROPERTY. This is what stops the key growing a segment
    // per restart: re-deriving an already-canonical stored key returns it
    // exactly, so the tenth boot produces the same key as the first.
    const key = BazaarCatalog.canonicalResourceKey(MCP_URL, "weather")!;
    let current = key;
    for (let i = 0; i < 10; i++) {
      const parts = BazaarCatalog.splitResourceKey(current);
      current = BazaarCatalog.canonicalResourceKey(parts.url, parts.toolName)!;
      expect(current, `restart ${i + 1}`).toBe(key);
    }
  });

  it("re-canonicalising a COMPOUND key returns it unchanged — the fixed-point property", () => {
    // THE BUG THIS CAUGHT, and why it needs its own test. Every url-only call
    // site (isBound, isVerifiedOwner, setVerifiedOwner, recordSettlement, …)
    // hands its argument straight back through canonicalResourceKey. For an
    // HTTP key that is a no-op. For a compound key it was NOT: `new URL()`
    // percent-encodes the separator, so the key came back as
    // `…/tools%1Fweather` and no lookup could match the entry the write path
    // had stored — the write and lookup derivations disagreeing, which is
    // exactly the G-3/G-11 class (docs/closing-state.md §3.7).
    //
    // MUTATION: drop the compound-input branch at the top of
    // canonicalResourceKey. This fails, and so does every restart test below.
    const key = BazaarCatalog.canonicalResourceKey(MCP_URL, "weather")!;
    expect(BazaarCatalog.canonicalResourceKey(key), "must be a fixed point").toBe(key);
    expect(BazaarCatalog.canonicalResourceKey(key), "and must not percent-encode").not.toContain("%1F");
  });

  it("an HTTP key has no separator and round-trips with toolName undefined", () => {
    const key = "https://api.example.com/quote";
    const parts = BazaarCatalog.splitResourceKey(key);
    expect(parts.toolName).toBeUndefined();
    expect(BazaarCatalog.canonicalResourceKey(parts.url, parts.toolName)).toBe(key);
  });
});

describe("upsertFromPayment — two tools on one MCP url are two entries", () => {
  it("catalogs each tool separately instead of merging them", async () => {
    // THE HEADLINE CASE. Before this change the second settle either overwrote
    // the first entry's metadata or was refused as an unbound-payTo hijack.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);

    expect(await catalog.upsertFromPayment(mcp(MCP_URL, "weather"), reqs(OWNER))).toBe(true);
    expect(await catalog.upsertFromPayment(mcp(MCP_URL, "forecast"), reqs(OWNER))).toBe(true);

    expect(catalog.size, "two tools, two entries").toBe(2);
  });

  it("a DIFFERENT seller's tool on the same server url is not refused as a hijack", async () => {
    // The url-only key made this indistinguishable from an F11 hijack: a second
    // seller on the same MCP host was locked out of their own tool. They are
    // different resources and must bind independently.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);

    expect(await catalog.upsertFromPayment(mcp(MCP_URL, "weather"), reqs(OWNER))).toBe(true);
    expect(await catalog.upsertFromPayment(mcp(MCP_URL, "billing"), reqs(OTHER))).toBe(true);
    expect(catalog.size).toBe(2);
  });

  it("the SAME tool settled twice is still one entry — compound keys do not multiply entries", async () => {
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    expect(await catalog.upsertFromPayment(mcp(MCP_URL, "weather"), reqs(OWNER))).toBe(true);
    expect(await catalog.upsertFromPayment(mcp(MCP_URL, "weather"), reqs(OWNER))).toBe(false);
    expect(catalog.size).toBe(1);
  });

  it("an HTTP resource at the same url does not collide with the MCP entries", async () => {
    // The HTTP key has no separator, so it cannot equal any compound key built
    // on the same url.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);

    expect(await catalog.upsertFromPayment(http(MCP_URL), reqs(OWNER))).toBe(true);
    expect(await catalog.upsertFromPayment(mcp(MCP_URL, "weather"), reqs(OWNER))).toBe(true);
    expect(catalog.size, "http entry and mcp entry are distinct").toBe(2);
  });

  it("refuses an MCP resource whose toolName is over the cap — no partial entry", async () => {
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    const outcome = { cataloged: false } as { cataloged: boolean; reason?: string };

    expect(
      await catalog.upsertFromPayment(mcp(MCP_URL, "t".repeat(MAX_TOOL_NAME_LEN + 1)), reqs(OWNER), outcome),
    ).toBe(false);
    expect(catalog.size, "nothing was written").toBe(0);
    expect(outcome).toEqual({ cataloged: false, reason: "invalid_tool_name" });
  });

  it("refuses an MCP resource whose toolName is empty — never falls back to the url-only key", async () => {
    // The dangerous fallback: an empty toolName landing on the plain url entry,
    // which may belong to someone else.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);

    expect(await catalog.upsertFromPayment(http(MCP_URL), reqs(OWNER)), "http entry exists first").toBe(true);
    expect(await catalog.upsertFromPayment(mcp(MCP_URL, "\x1F"), reqs(OTHER))).toBe(false);
    expect(catalog.size, "the http entry was not touched").toBe(1);
    expect(catalog.isBound(MCP_URL, OWNER), "and still belongs to its owner").toBe(true);
  });
});

describe("boot re-canonicalisation — compound keys survive a real restart", () => {
  it("rebuilds both tools' keys from the store, leaving neither unbound", async () => {
    // THE CRITICAL TEST for Option A2. Against a REAL libSQL file reopened by a
    // second client — the testkit's own model of a restart — because the hazard
    // is specifically that a reloaded key stops matching its ownership row.
    //
    // MUTATION THAT MUST BREAK THIS: in the ownership loop, re-derive with
    // canonicalResourceKey(b.resourceKey, parts.toolName) instead of
    // splitting first. The key gains a second \x1FtoolName segment on every boot
    // and both entries silently unbind.
    const { store, url } = tmpStore();
    const before = await BazaarCatalog.create(store);
    await before.upsertFromPayment(mcp(MCP_URL, "weather"), reqs(OWNER));
    await before.upsertFromPayment(mcp(MCP_URL, "forecast"), reqs(OWNER));
    expect(before.size).toBe(2);
    await store.close();

    const after = await BazaarCatalog.create(reopen(url));
    expect(after.size, "both entries came back").toBe(2);

    // The bindings still resolve under the SAME compound keys — this is the
    // property that was at risk, not merely the entry count.
    const weatherKey = BazaarCatalog.canonicalResourceKey(MCP_URL, "weather")!;
    const forecastKey = BazaarCatalog.canonicalResourceKey(MCP_URL, "forecast")!;
    expect(after.isBound(weatherKey, OWNER), "weather still bound").toBe(true);
    expect(after.isBound(forecastKey, OWNER), "forecast still bound").toBe(true);

    // And the owner is not locked out: a further settle for either tool is an
    // ordinary update, not a refused hijack.
    expect(await after.upsertFromPayment(mcp(MCP_URL, "weather"), reqs(OWNER))).toBe(false);
    expect(after.size, "still two entries, no third created").toBe(2);
  });

  it("stays a fixed point across repeated restarts — the key does not grow", async () => {
    // Three boots on one database. A key that gained a segment per boot would
    // show up as a growing entry count or a lost binding by the third.
    const { store, url } = tmpStore();
    const first = await BazaarCatalog.create(store);
    await first.upsertFromPayment(mcp(MCP_URL, "weather"), reqs(OWNER));
    await store.close();

    const key = BazaarCatalog.canonicalResourceKey(MCP_URL, "weather")!;
    for (let boot = 2; boot <= 4; boot++) {
      const s = reopen(url);
      const c = await BazaarCatalog.create(s);
      expect(c.size, `boot ${boot}: one entry`).toBe(1);
      expect(c.isBound(key, OWNER), `boot ${boot}: still bound under the same key`).toBe(true);
      expect(c.list().items[0]!.resource, `boot ${boot}: served url is the plain url`).toBe(MCP_URL);
      await s.close();
    }
  });

  it("an HTTP row (no separator) reloads under its url-only key, unchanged", async () => {
    // The no-regression half: HTTP rows written before this change contain no
    // \x1F, so split yields toolName undefined and the key is byte-identical.
    const { store, url } = tmpStore();
    const before = await BazaarCatalog.create(store);
    await before.upsertFromPayment(http("https://api.example.com/quote"), reqs(OWNER));
    await store.close();

    const after = await BazaarCatalog.create(reopen(url));
    expect(after.size).toBe(1);
    expect(after.isBound("https://api.example.com/quote", OWNER)).toBe(true);
    // Every spelling still resolves, exactly as the G-11 family requires.
    expect(after.isBound("https://api.example.com/quote/", OWNER)).toBe(true);
  });

  it("an MCP entry and an HTTP entry on one url both survive a restart, still distinct", async () => {
    const { store, url } = tmpStore();
    const before = await BazaarCatalog.create(store);
    await before.upsertFromPayment(http(MCP_URL), reqs(OWNER));
    await before.upsertFromPayment(mcp(MCP_URL, "weather"), reqs(OWNER));
    await store.close();

    const after = await BazaarCatalog.create(reopen(url));
    expect(after.size, "still two").toBe(2);
    expect(after.isBound(MCP_URL, OWNER), "http key").toBe(true);
    expect(
      after.isBound(BazaarCatalog.canonicalResourceKey(MCP_URL, "weather")!, OWNER),
      "compound key",
    ).toBe(true);
  });
});

describe("lookup call sites agree with the write path for MCP entries", () => {
  it("recordSettlement, isVerifiedOwner and setVerifiedOwner all resolve the compound key", async () => {
    // §3.7's agreement assertion, for the compound identity. The twelve
    // url-only call sites take a KEY, so they must be handed the compound key
    // — and must then find exactly the entry the write path created.
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(mcp(MCP_URL, "weather"), reqs(OWNER));
    await catalog.upsertFromPayment(mcp(MCP_URL, "forecast"), reqs(OWNER));

    const weatherKey = BazaarCatalog.canonicalResourceKey(MCP_URL, "weather")!;
    const forecastKey = BazaarCatalog.canonicalResourceKey(MCP_URL, "forecast")!;

    expect(catalog.recordSettlement(weatherKey, "CPAYER", OWNER)).toBe(true);
    catalog.setVerifiedOwner(weatherKey, true);
    expect(catalog.isVerifiedOwner(weatherKey), "the tool we marked").toBe(true);
    // And ONLY that tool — the sibling entry must be untouched, which is the
    // whole difference between two entries and one merged one.
    expect(catalog.isVerifiedOwner(forecastKey), "the sibling tool is unaffected").toBe(false);
  });

  it("the plain url does not resolve an MCP entry — no accidental url-only match", async () => {
    const { store } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(mcp(MCP_URL, "weather"), reqs(OWNER));
    // MUTATION: key the write path on the url alone. This then passes, and the
    // two-entries property above breaks.
    expect(catalog.isBound(MCP_URL, OWNER), "the bare url is not the MCP identity").toBe(false);
  });
});
