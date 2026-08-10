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
