import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { afterEach, describe, expect, it } from "vitest";
import { registerBazaar } from "./bazaar.js";
import { BazaarCatalog } from "./catalog.js";
import { readOwnership, reopen, seedRows } from "./store.testkit.js";
import type { OwnershipVerdict } from "./ownership.js";

// G-1 — re-verify on settle.
//
// verifiedOwner is deliberately not trusted from disk (RA-9), and Layer 2 fired
// only under `if (firstCatalog)`, so a restored entry served ownerVerified:false
// and verified_only=true returned an empty catalog. bindLoadedEntry's comment
// claimed "Layer 2 re-verifies from the resource on the next settlement" — that
// path did not exist. These tests assert the behaviour the comment described, so
// the comment becomes true and stays true.
//
// DESIGN (decided before implementing):
//  - Settle-triggered ONLY. No timer, no prober. A prober would grant "verified"
//    on current domain control with no contemporaneous payment — the same
//    inference refused for automated rotation (runbook procedure 1). The price
//    is that a zero-traffic resource stays unverified; that is the correct price.
//  - Verification state is in-memory ONLY: never persisted (RA-9 stays closed)
//    and never on the wire (no attacker-forceable signal for consumers).
//  - mismatch is a DEFINITE answer, unverifiable an UNCERTAIN one, so they do
//    not share a retry floor: 24h vs 15min.
//
// The 24h cooldown is the brake on amplification, so it is asserted by COUNTING
// OUTBOUND FETCHES, not by reading the bookkeeping field.

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vellar-rev-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const URL_X = "https://api.merchant.example/quote";
const OWNER = "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A";
const OTHER = "GBQ3VANQZ6X3ZVGFTQJZ2MZ4KOCPZ5EGWSVYT7OPTQJ4M7VXMKQ3OQXD";
const ASSET = "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND";

const MIN = 60_000;
const HOUR = 60 * MIN;

function reqs(payTo: string): PaymentRequirements {
  return {
    scheme: "exact", network: "stellar:testnet", asset: ASSET,
    amount: "1000000", payTo, maxTimeoutSeconds: 60, extra: {},
  } as PaymentRequirements;
}

function stubScheme(): SchemeNetworkFacilitator {
  return {
    scheme: "exact", caipFamily: "stellar:*",
    getExtra: () => undefined, getSigners: () => [],
    verify: async () => ({ isValid: true, payer: "CPAYER" }),
    settle: async () => ({ success: true, transaction: "tx", network: "stellar:testnet", payer: "CPAYER" }),
  } as unknown as SchemeNetworkFacilitator;
}

function payload(url: string, payTo: string, routeTemplate?: string): PaymentPayload {
  const extensions = declareDiscoveryExtension({
    input: { city: "lagos" },
    inputSchema: { properties: { city: { type: "string" } }, required: ["city"] },
  }) as Record<string, { info: { input: Record<string, unknown> }; routeTemplate?: string }>;
  extensions.bazaar!.info.input.method = "GET";
  // routeTemplate lives on the extension object itself (the extractor reads
  // `rawExt.routeTemplate`), not inside `info`.
  if (routeTemplate) extensions.bazaar!.routeTemplate = routeTemplate;
  return {
    x402Version: 2,
    resource: { url, description: "Quotes", serviceName: "MerchantSvc" },
    accepted: reqs(payTo),
    payload: { transaction: "AAAA" },
    extensions,
  } as PaymentPayload;
}

/** A verifier that COUNTS calls — the amplification is what is being tested. */
function counter(verdict: OwnershipVerdict | ((url: string, payTos: string[]) => OwnershipVerdict)) {
  const calls: Array<{ url: string; payTos: string[] }> = [];
  const fn = async (url: string, payTos: string[]): Promise<OwnershipVerdict> => {
    calls.push({ url, payTos: [...payTos] });
    return typeof verdict === "function" ? verdict(url, payTos) : verdict;
  };
  return { calls, fn };
}

async function seeded(): Promise<BazaarCatalog> {
  const c = await BazaarCatalog.create();
  await c.upsertFromPayment(
    { resourceUrl: URL_X, x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as never,
    reqs(OWNER),
  );
  return c;
}

describe("G-1 — the behaviour bindLoadedEntry's comment promised", () => {
  it("a restored entry re-verifies on the bound owner's next settlement", async () => {
    const file = `file:${join(tmpDir(), "catalog.json.db")}`;

    // Run 1: cataloged and verified.
    const before = await BazaarCatalog.create(reopen(file));
    const v1 = counter("match");
    const f1 = new x402Facilitator().register("stellar:testnet", stubScheme());
    registerBazaar(f1, before, { verifyOwnership: v1.fn as never });
    await f1.settle(payload(URL_X, OWNER), reqs(OWNER));
    await new Promise((r) => setImmediate(r));
    expect(before.isVerifiedOwner(URL_X), "precondition: verified in run 1").toBe(true);
    await before.flush();

    // Run 2: restart. The entry is restored UNVERIFIED (RA-9 — never trusted
    // from disk), and before this fix nothing could ever restore it.
    const after = await BazaarCatalog.create(reopen(file));
    expect(after.isVerifiedOwner(URL_X), "restored entries start unverified").toBe(false);

    const v2 = counter("match");
    const f2 = new x402Facilitator().register("stellar:testnet", stubScheme());
    registerBazaar(f2, after, { verifyOwnership: v2.fn as never });
    await f2.settle(payload(URL_X, OWNER), reqs(OWNER));
    await new Promise((r) => setImmediate(r));

    expect(v2.calls, "the next settlement must re-verify").toHaveLength(1);
    expect(after.isVerifiedOwner(URL_X), "the comment's promise, now true").toBe(true);
  });

  it("re-verification asks about the BOUND owner, not the settling payTo", async () => {
    const c = await seeded();
    const v = counter("match");
    await c.reverify(URL_X, OWNER, v.fn, 0);
    expect(v.calls[0]!.payTos, "must ask about the durable binding").toEqual([OWNER]);
  });

  it("matches ANY bound address, so a runbook rotation can restore the badge", async () => {
    // The operator rotation procedure produces boundPayTo: [OLD, NEW].
    const file = `file:${join(tmpDir(), "catalog.json.db")}`;
    const c = await seeded();
    // Simulate the operator's edit by loading an ownership file with both.
    const path = `file:${join(tmpDir(), "c2.json.db")}`;
    // The operator's edit, expressed as the runbook now expresses it: a SECOND
    // ownership row for the same URL. This is the case that forced the composite
    // primary key — a one-row-per-URL schema cannot hold [OLD, NEW], and would
    // have silently broken the only recovery a squat has before displacement.
    await seedRows(path, {
      ownership: [
        { key: URL_X, payTo: OWNER },
        { key: URL_X, payTo: OTHER },
      ],
      entries: [
        {
          key: URL_X,
          payload: {
            resource: {
              resource: URL_X,
              type: "http",
              x402Version: 2,
              lastUpdated: "2026-08-01T00:00:00.000Z",
              accepts: [
                { scheme: "exact", network: "stellar:testnet", asset: ASSET, amount: "1", payTo: OWNER },
              ],
            },
            stats: { settlements: 0, payers: [], observed: 0 },
          },
        },
      ],
    });
    const rotated = await BazaarCatalog.create(reopen(path));
    const v = counter((_u, payTos) => (payTos.includes(OTHER) ? "match" : "mismatch"));
    await rotated.reverify(URL_X, OWNER, v.fn, 0);
    expect(v.calls[0]!.payTos, "one fetch, both addresses").toEqual([OWNER, OTHER]);
    expect(rotated.isVerifiedOwner(URL_X)).toBe(true);
    expect(c.size).toBe(1); // keep `file`/`c` referenced
    expect(file).toBeTruthy();
  });
});

describe("G-1 — the 24h mismatch cooldown is the brake (measured in fetches)", () => {
  it("a mismatching resource is fetched ONCE, not once per settlement", async () => {
    const c = await seeded();
    const v = counter("mismatch");
    // 50 settlements from the bound owner across 23 hours.
    for (let i = 0; i < 50; i++) {
      await c.reverify(URL_X, OWNER, v.fn, i * (27 * MIN)); // ~22.5h total
    }
    expect(v.calls.length, "24h cooldown must collapse 50 settles to 1 fetch").toBe(1);
  });

  it("retries only after the full 24h", async () => {
    const c = await seeded();
    const v = counter("mismatch");
    await c.reverify(URL_X, OWNER, v.fn, 0);
    await c.reverify(URL_X, OWNER, v.fn, 24 * HOUR - 1);
    expect(v.calls.length, "still inside the window").toBe(1);
    await c.reverify(URL_X, OWNER, v.fn, 24 * HOUR);
    expect(v.calls.length, "window elapsed").toBe(2);
  });

  it("an UNVERIFIABLE endpoint uses the shorter 15min floor, not 24h", async () => {
    // Uncertainty is not a definite answer, so it must not be parked for a day.
    const c = await seeded();
    const v = counter("unverifiable");
    await c.reverify(URL_X, OWNER, v.fn, 0);
    await c.reverify(URL_X, OWNER, v.fn, 15 * MIN - 1);
    expect(v.calls.length).toBe(1);
    await c.reverify(URL_X, OWNER, v.fn, 15 * MIN);
    expect(v.calls.length, "15min floor for uncertainty").toBe(2);
  });

  it("stops fetching entirely once verified", async () => {
    const c = await seeded();
    const v = counter("match");
    for (let i = 0; i < 20; i++) await c.reverify(URL_X, OWNER, v.fn, i * 48 * HOUR);
    expect(v.calls.length, "a verified entry is never re-probed").toBe(1);
  });
});

describe("G-1 — amplification gates: no fetch at all", () => {
  it("an UNBOUND settling payTo triggers no fetch", async () => {
    const c = await seeded();
    const v = counter("match");
    for (let i = 0; i < 10; i++) await c.reverify(URL_X, OTHER, v.fn, i * 48 * HOUR);
    expect(v.calls.length, "only the bound owner's settle may trigger a probe").toBe(0);
  });

  it("an entry with an EMPTY binding triggers no fetch", async () => {
    // bindLoadedEntry produces boundPayTo:[] for a stored entry with no accepts
    // (G-5). Probing it would pass no address and read back a false MISMATCH.
    const path = `file:${join(tmpDir(), "empty.json.db")}`;
    // An entry row with NO ownership row. Under the file store this arose from
    // an empty `accepts`; here it can only be produced by writing the database
    // directly, which is the point — it is the tampered state, and the loader
    // must refuse to serve it as owned rather than inventing an owner.
    await seedRows(path, {
      entries: [
        {
          key: URL_X,
          payload: {
            resource: {
              resource: URL_X,
              type: "http",
              x402Version: 2,
              lastUpdated: "2026-08-01T00:00:00.000Z",
              accepts: [],
            },
            stats: { settlements: 0, payers: [], observed: 0 },
          },
        },
      ],
    });
    const c = await BazaarCatalog.create(reopen(path));
    const v = counter("match");
    await c.reverify(URL_X, OWNER, v.fn, 0);
    expect(v.calls.length, "a missing claim is not a refuted claim — do not probe").toBe(0);
  });

  it("a routeTemplate key triggers no fetch", async () => {
    // The canonical key becomes `origin + /quote/:symbol`; fetching it would GET
    // a literal `:symbol`. Structurally unverifiable — skip rather than probe.
    const c = await BazaarCatalog.create();
    const f = new x402Facilitator().register("stellar:testnet", stubScheme());
    const v = counter("match");
    registerBazaar(f, c, { verifyOwnership: v.fn as never });
    await f.settle(payload("https://api.merchant.example/quote/AAPL", OWNER, "/quote/:symbol"), reqs(OWNER));
    await new Promise((r) => setImmediate(r));
    expect(v.calls.length, "templated keys must not be fetched").toBe(0);
  });

  it("an uncataloged resource triggers no fetch", async () => {
    const c = await BazaarCatalog.create();
    const v = counter("match");
    await c.reverify("https://nowhere.example/x", OWNER, v.fn, 0);
    expect(v.calls.length).toBe(0);
  });
});

describe("G-1 — a failed re-verify is never a route to rebinding", () => {
  it("no verdict, under any retry path, changes a binding", async () => {
    const path = `file:${join(tmpDir(), "bind.json.db")}`;
    const c = await BazaarCatalog.create(reopen(path));
    await c.upsertFromPayment(
      { resourceUrl: URL_X, x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as never,
      reqs(OWNER),
    );
    await c.flush();
    const ownershipBefore = JSON.stringify(await readOwnership(path));

    // Every verdict, repeatedly, across many cooldown windows.
    let t = 0;
    for (const verdict of ["mismatch", "unverifiable", "mismatch", "unverifiable"] as OwnershipVerdict[]) {
      const v = counter(verdict);
      await c.reverify(URL_X, OWNER, v.fn, t);
      t += 48 * HOUR;
    }

    expect(c.isBound(URL_X, OWNER), "the original owner stays bound").toBe(true);
    expect(c.isBound(URL_X, OTHER), "no verdict may bind anyone new").toBe(false);
    await c.flush();
    expect(JSON.stringify(await readOwnership(path)), "ownership rows unchanged").toBe(ownershipBefore);
  });

  it("a MATCH for a different address does not bind that address", async () => {
    // The verifier is told the bound set; a hostile one claiming "match" must
    // not be able to smuggle in a new owner.
    const c = await seeded();
    const v = counter("match");
    await c.reverify(URL_X, OWNER, v.fn, 0);
    expect(c.isBound(URL_X, OTHER)).toBe(false);
    expect(c.isVerifiedOwner(URL_X)).toBe(true);
  });

  it("does not hand out the ownership array (it aliases the tombstone)", async () => {
    // entry.boundPayTo IS the tombstone array object; a caller that mutated it
    // would durably rebind at the next saveOwnership.
    const c = await seeded();
    const v = counter((_u, payTos) => {
      payTos.push(OTHER); // a caller mutating what it was given
      return "match";
    });
    await c.reverify(URL_X, OWNER, v.fn, 0);
    expect(c.isBound(URL_X, OTHER), "mutation must not reach the binding").toBe(false);
  });
});

describe("G-1 — uncertainty never downgrades, and the hot path is preserved", () => {
  it("a verified entry is never re-probed, so nothing can strip its badge", async () => {
    const c = await seeded();
    await c.reverify(URL_X, OWNER, counter("match").fn, 0);
    expect(c.isVerifiedOwner(URL_X)).toBe(true);

    // Assert the MECHANISM, not just the outcome: the verifier must not be
    // consulted at all. That is what makes an existing verification
    // undowngradable — and it means the write below can only ever act on an
    // unverified entry, so a "mismatch" can never clear a live badge.
    const later = counter("unverifiable");
    await c.reverify(URL_X, OWNER, later.fn, 100 * HOUR);
    expect(later.calls.length, "a verified entry must not be re-fetched").toBe(0);
    expect(c.isVerifiedOwner(URL_X), "uncertainty never downgrades").toBe(true);
  });

  it("settlement never waits on the verification fetch", async () => {
    // @x402/core AWAITS the afterSettle hook, so a verifier that never resolves
    // would stall every settlement if the hook awaited it.
    const c = await BazaarCatalog.create();
    const f = new x402Facilitator().register("stellar:testnet", stubScheme());
    registerBazaar(f, c, { verifyOwnership: (() => new Promise<never>(() => {})) as never });
    const settled = await Promise.race([
      f.settle(payload(URL_X, OWNER), reqs(OWNER)).then(() => "settled"),
      new Promise((r) => setTimeout(() => r("STALLED"), 1_000)),
    ]);
    expect(settled, "a hanging verifier must not delay settlement").toBe("settled");
  });

  it("a THROWING verifier neither fails nor delays settlement", async () => {
    const c = await BazaarCatalog.create();
    const f = new x402Facilitator().register("stellar:testnet", stubScheme());
    registerBazaar(f, c, { verifyOwnership: (async () => { throw new Error("hostile"); }) as never });
    const res = await f.settle(payload(URL_X, OWNER), reqs(OWNER));
    await new Promise((r) => setImmediate(r));
    expect(res.success, "settlement is unaffected by verification failure").toBe(true);
  });
});
