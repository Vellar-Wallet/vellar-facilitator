import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { registerBazaar } from "./bazaar.js";
import { BazaarCatalog } from "./catalog.js";
import type { TrustedDiscoveryResource } from "./trust.js";

// G-4 — settlement stats were writable by anyone.
//
// `recordSettlement` had no payTo check AND ran unconditionally in bazaar.ts
// AFTER `upsertFromPayment`, including when that upsert was REJECTED as an F11
// hijack. So a payment that the catalog had just refused to associate with an
// entry still incremented that entry's settlements, uniquePayers and
// lastSettled — and `statsSource` still read "observed", asserting a provenance
// the data did not have.
//
// That ordering is how the bug got through, so the central test below drives the
// REAL onAfterSettle hook rather than calling recordSettlement directly.
//
// Scope of the fix, stated honestly: it makes it IMPOSSIBLE to move an entry you
// are not the bound owner of. It does NOT stop a bound owner inflating their own
// stats by paying themselves — the facilitator cannot distinguish that from a
// real customer. See the audit doc for the cost bound on that residual.

const VICTIM_URL = "https://api.victim.example/weather";
const OWNER = "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A";
const ATTACKER = "GBQ3VANQZ6X3ZVGFTQJZ2MZ4KOCPZ5EGWSVYT7OPTQJ4M7VXMKQ3OQXD";
const ASSET = "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND";

function reqs(payTo: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: ASSET,
    amount: "1000000",
    payTo,
    maxTimeoutSeconds: 60,
    extra: {},
  } as PaymentRequirements;
}

function stubScheme(payer: string): SchemeNetworkFacilitator {
  return {
    scheme: "exact",
    caipFamily: "stellar:*",
    getExtra: () => undefined,
    getSigners: () => [],
    verify: async () => ({ isValid: true, payer }),
    settle: async () => ({
      success: true,
      transaction: "stub-tx-hash",
      network: "stellar:testnet",
      payer,
    }),
  } as unknown as SchemeNetworkFacilitator;
}

function payload(url: string, payTo: string): PaymentPayload {
  const extensions = declareDiscoveryExtension({
    input: { city: "lagos" },
    inputSchema: { properties: { city: { type: "string" } }, required: ["city"] },
  }) as Record<string, { info: { input: Record<string, unknown> } }>;
  extensions.bazaar!.info.input.method = "GET";
  return {
    x402Version: 2,
    resource: { url, description: "Weather", serviceName: "VictimSvc" },
    accepted: reqs(payTo),
    payload: { transaction: "AAAA" },
    extensions,
  } as PaymentPayload;
}

/** A facilitator whose settlements are attributed to `payer`. */
async function build(payer: string) {
  const catalog = await BazaarCatalog.create();
  const facilitator = new x402Facilitator().register("stellar:testnet", stubScheme(payer));
  registerBazaar(facilitator, catalog);
  return { catalog, facilitator };
}

function stats(catalog: BazaarCatalog) {
  return (catalog.list().items[0] as TrustedDiscoveryResource | undefined)?.trust;
}

describe("G-4 — the REJECTED-upsert path must not move an entry's stats", () => {
  it("an unbound payTo settling against a cataloged URL leaves every stat untouched", async () => {
    // The victim establishes the entry with one genuine settlement.
    const { catalog, facilitator } = await build("CVICTIMPAYER");
    await facilitator.settle(payload(VICTIM_URL, OWNER), reqs(OWNER));
    const before = stats(catalog);
    expect(before?.settlements, "precondition: the owner's own settlement counted").toBe(1);

    // The attacker now settles against the SAME resource url with their own
    // payTo. upsertFromPayment refuses it (F11), but recordSettlement used to
    // run anyway — this is the exact ordering that produced the bug.
    const attacker = new x402Facilitator().register("stellar:testnet", stubScheme("CATTACKER"));
    registerBazaar(attacker, catalog);
    for (let i = 0; i < 5; i++) {
      await attacker.settle(payload(VICTIM_URL, ATTACKER), reqs(ATTACKER));
    }

    const after = stats(catalog);
    expect(after?.settlements, "G-4: a refused upsert must not count").toBe(1);
    expect(after?.uniquePayers, "G-4: attacker must not appear as a payer").toBe(1);
    expect(after?.lastSettled, "G-4: lastSettled must not be refreshed").toBe(before?.lastSettled);
  });

  it("keeps the provenance claim honest: observed stays truthful", async () => {
    // statsSource:"observed" asserts these settlements were witnessed FOR this
    // entry. If refused settlements could increment it, the label would be
    // asserting a provenance the data does not have.
    const { catalog, facilitator } = await build("CVICTIMPAYER");
    await facilitator.settle(payload(VICTIM_URL, OWNER), reqs(OWNER));
    const attacker = new x402Facilitator().register("stellar:testnet", stubScheme("CATTACKER"));
    registerBazaar(attacker, catalog);
    await attacker.settle(payload(VICTIM_URL, ATTACKER), reqs(ATTACKER));

    const t = stats(catalog);
    expect(t?.observedSettlements, "observed must count only settlements to the bound owner").toBe(1);
    expect(t?.statsSource).toBe("observed");
  });

  it("does NOT create a false negative: the bound owner's settlements still count", async () => {
    const { catalog, facilitator } = await build("CPAYER1");
    await facilitator.settle(payload(VICTIM_URL, OWNER), reqs(OWNER));
    // A second, different customer paying the SAME bound owner.
    const second = new x402Facilitator().register("stellar:testnet", stubScheme("CPAYER2"));
    registerBazaar(second, catalog);
    await second.settle(payload(VICTIM_URL, OWNER), reqs(OWNER));

    const t = stats(catalog);
    expect(t?.settlements, "genuine repeat business must count").toBe(2);
    expect(t?.uniquePayers, "distinct payers to the bound owner must count").toBe(2);
  });
});

describe("G-4 — recordSettlement is gated at the catalog, not at the caller", () => {
  it("refuses an unbound payTo even when called directly", async () => {
    // The gate lives in BazaarCatalog so a future caller cannot reintroduce the
    // bug by forgetting to check — which is exactly what bazaar.ts did.
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(
      { resourceUrl: VICTIM_URL, x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as never,
      reqs(OWNER),
    );
    expect(catalog.recordSettlement(VICTIM_URL, "CPAYER", ATTACKER)).toBe(false);
    expect(stats(catalog)?.settlements).toBe(0);

    expect(catalog.recordSettlement(VICTIM_URL, "CPAYER", OWNER)).toBe(true);
    expect(stats(catalog)?.settlements).toBe(1);
  });

  it("still ignores settlements for uncataloged resources", async () => {
    const catalog = await BazaarCatalog.create();
    expect(catalog.recordSettlement("https://nowhere.example/x", "CPAYER", OWNER)).toBe(false);
    expect(catalog.size).toBe(0);
  });

  it("canonicalizes the url, so a query string cannot bypass the gate", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(
      { resourceUrl: VICTIM_URL, x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as never,
      reqs(OWNER),
    );
    // Both must resolve to the same entry: the owner's counts, the attacker's not.
    expect(catalog.recordSettlement(`${VICTIM_URL}?city=lagos`, "CPAYER", ATTACKER)).toBe(false);
    expect(catalog.recordSettlement(`${VICTIM_URL}?city=lagos`, "CPAYER", OWNER)).toBe(true);
    expect(stats(catalog)?.settlements).toBe(1);
  });
});

// ============================================================================
// O-7 — `statsSource` asserted a provenance it did not have.
//
// G-4 above fixed the WRITE path: stats can no longer be moved by a payTo that
// is not bound. The same assertion survived on the READ path. `statsSource` was
// derived as `settlements === observed`, which answers "was the inherited
// portion zero?" — not "did this process witness these numbers?". A restored
// entry whose stored count is 0 satisfies `0 === 0` and was therefore labelled
// "observed", claiming witness for an entry the process had never seen.
//
// That is the live case rather than a corner one, because G-4's own gate is what
// produces the zeros: a resource can take real, settled payments indefinitely
// and keep a stored count of 0 whenever the paying `payTo` is not bound to it.
// Observed in production — two successful on-chain payments against a URL bound
// to a different payTo left the counter unmoved, and the entry then reported
// that 0 as "observed".
// ============================================================================

describe("O-7 — statsSource reports provenance, not arithmetic", () => {
  it("a restored entry NEVER reports observed — including when its stored count is 0", async () => {
    const { reopen } = await import("./store.testkit.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = `file:${join(mkdtempSync(join(tmpdir(), "o7-")), "catalog.db")}`;

    // Run 1: the entry is cataloged, but NO settlement is ever attributed to it
    // — exactly what the G-4 gate leaves behind when the payer is unbound.
    const before = await BazaarCatalog.create(reopen(file));
    await before.upsertFromPayment(
      { resourceUrl: VICTIM_URL, x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as never,
      reqs(OWNER),
    );
    expect(stats(before)?.settlements, "precondition: nothing counted").toBe(0);
    expect(stats(before)?.statsSource, "in-process, so genuinely observed").toBe("observed");
    await before.flush();

    // Run 2: same database, fresh process. The numbers are identical and their
    // provenance is not — this process witnessed none of it.
    const after = await BazaarCatalog.create(reopen(file));
    const t = stats(after);
    expect(t?.settlements, "the stored zero survives").toBe(0);
    expect(t?.observedSettlements, "this process saw nothing").toBe(0);
    expect(t?.statsSource, "O-7: a restored zero must not claim to be observed").toBe("persisted");
  });

  it("stays persisted after a restored entry witnesses new settlements", async () => {
    const { reopen } = await import("./store.testkit.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = `file:${join(mkdtempSync(join(tmpdir(), "o7b-")), "catalog.db")}`;

    const before = await BazaarCatalog.create(reopen(file));
    await before.upsertFromPayment(
      { resourceUrl: VICTIM_URL, x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as never,
      reqs(OWNER),
    );
    await before.flush();

    const after = await BazaarCatalog.create(reopen(file));
    expect(after.recordSettlement(VICTIM_URL, "CPAYER", OWNER)).toBe(true);
    // Re-upserting must not launder the provenance either.
    await after.upsertFromPayment(
      { resourceUrl: VICTIM_URL, x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as never,
      reqs(OWNER),
    );

    const t = stats(after);
    expect(t?.settlements).toBe(1);
    expect(t?.observedSettlements, "the new one WAS witnessed").toBe(1);
    // Deliberately conservative: the arithmetic (1 === 1) would say "observed",
    // but the baseline came from disk. Under-claiming is the safe direction, and
    // observedSettlements still carries the exact witnessed count.
    expect(t?.statsSource, "restored entries do not become observed").toBe("persisted");
  });

  it("an entry created in this process reports observed", async () => {
    const catalog = await BazaarCatalog.create();
    await catalog.upsertFromPayment(
      { resourceUrl: VICTIM_URL, x402Version: 2, discoveryInfo: { input: { type: "http", method: "GET" } } } as never,
      reqs(OWNER),
    );
    expect(catalog.recordSettlement(VICTIM_URL, "CPAYER", OWNER)).toBe(true);
    expect(stats(catalog)?.statsSource).toBe("observed");
  });

  it("a crafted file cannot forge observed provenance", async () => {
    const { reopen, seedRows } = await import("./store.testkit.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = `file:${join(mkdtempSync(join(tmpdir(), "o7c-")), "catalog.db")}`;

    // A payload asserting its own provenance, the way a tampered file would.
    await seedRows(file, {
      ownership: [{ key: VICTIM_URL, payTo: OWNER }],
      entries: [
        {
          key: VICTIM_URL,
          payload: {
            resource: {
              resource: VICTIM_URL,
              type: "http",
              x402Version: 2,
              accepts: [reqs(OWNER)],
              lastUpdated: new Date().toISOString(),
            },
            stats: { settlements: 999, payers: ["CPAYER"] },
            restored: false,
          },
        },
      ],
    });

    const catalog = await BazaarCatalog.create(reopen(file));
    const t = stats(catalog);
    expect(t?.observedSettlements, "never read from the file").toBe(0);
    expect(t?.statsSource, "the load path decides provenance, not the payload").toBe("persisted");
  });
});
