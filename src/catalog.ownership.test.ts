import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import type { TrustedDiscoveryResource } from "./trust.js";

/** list() adds a `trust` stats block at runtime; the upstream wire type omits
 * it, so read it back through the trust-annotated shape. */
function settlements(item: unknown): number | undefined {
  return (item as TrustedDiscoveryResource | undefined)?.trust?.settlements;
}

// Fix 0 Layer 1 — TOFU (trust-on-first-use) ownership binding. The first
// settlement to catalog a canonical resourceUrl binds it to that payment's
// payTo. Later settlements for the same URL may only append an accepts entry
// (or overwrite metadata) if their payTo is already bound; otherwise the write
// is rejected and the existing entry is left untouched. Enforced identically in
// upsertFromPayment and load() so a crafted CATALOG_FILE cannot bypass it.

const URL_X = "https://api.weather.com/quote";

function reqs(payTo: string, asset: string, amount = "1000000"): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset,
    amount,
    payTo,
    maxTimeoutSeconds: 60,
    extra: {},
  } as PaymentRequirements;
}

function disc(over: Partial<DiscoveredResource> = {}): DiscoveredResource {
  return {
    resourceUrl: URL_X,
    description: "Legit weather API",
    serviceName: "WeatherSvc",
    tags: ["weather"],
    x402Version: 2,
    discoveryInfo: { input: { type: "http", method: "GET" } },
    ...over,
  } as DiscoveredResource;
}

const tmpFiles: string[] = [];
function tmpFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "vellar-cat-"));
  const path = join(dir, "catalog.json");
  writeFileSync(path, JSON.stringify(contents, null, 2));
  tmpFiles.push(dir);
  return path;
}
afterEach(() => {
  while (tmpFiles.length) rmSync(tmpFiles.pop()!, { recursive: true, force: true });
});

describe("Fix 0 Layer 1 — TOFU ownership binding (upsertFromPayment)", () => {
  it("binds the canonical URL to the first settlement's payTo", () => {
    const cat = new BazaarCatalog();
    cat.upsertFromPayment(disc(), reqs("GLEGIT_A", "CASSET_LEGIT"));
    expect(cat.isBound(URL_X, "GLEGIT_A")).toBe(true);
    expect(cat.isBound(URL_X, "GATTACKER_B")).toBe(false);
  });

  it("rejects an appended accepts entry from an UNBOUND payTo (hijack blocked)", () => {
    const cat = new BazaarCatalog();
    cat.upsertFromPayment(disc(), reqs("GLEGIT_A", "CASSET_LEGIT"));
    cat.recordSettlement(URL_X, "GPAYER1");

    // Attacker settles the same URL with a different payTo.
    cat.upsertFromPayment(
      disc({ description: "PAY HERE — cheapest" }),
      reqs("GATTACKER_B", "CASSET_ATTACKER", "1"),
    );

    const item = cat.list().items[0]!;
    // Only the legitimate accepts entry survives; attacker's is not appended.
    expect(item.accepts).toHaveLength(1);
    expect(item.accepts[0]!.payTo).toBe("GLEGIT_A");
    // Metadata is NOT overwritten by an unbound settlement.
    expect(item.description).toBe("Legit weather API");
    // Stats are unchanged after a rejected attempt.
    expect(settlements(item)).toBe(1);
  });

  it("allows an appended accepts entry from a BOUND payTo (legit multi-option)", () => {
    const cat = new BazaarCatalog();
    cat.upsertFromPayment(disc(), reqs("GLEGIT_A", "CASSET_LEGIT"));
    // Same owner adds a second payment option (different asset, same payTo).
    cat.upsertFromPayment(disc(), reqs("GLEGIT_A", "CASSET_USDC"));

    const item = cat.list().items[0]!;
    expect(item.accepts).toHaveLength(2);
    expect(item.accepts.map((a) => a.asset).sort()).toEqual(["CASSET_LEGIT", "CASSET_USDC"]);
  });

  it("allows metadata overwrite only from a BOUND payTo", () => {
    const cat = new BazaarCatalog();
    cat.upsertFromPayment(disc(), reqs("GLEGIT_A", "CASSET_LEGIT"));
    cat.upsertFromPayment(
      disc({ description: "Updated by the real owner", serviceName: "WeatherSvc v2" }),
      reqs("GLEGIT_A", "CASSET_LEGIT"),
    );
    const item = cat.list().items[0]!;
    expect(item.description).toBe("Updated by the real owner");
    expect(item.serviceName).toBe("WeatherSvc v2");
  });
});

describe("Fix 0 Layer 1 — TOFU enforcement at load() (CATALOG_FILE cannot bypass)", () => {
  it("quarantines a stored entry whose accepts contains conflicting payTos", () => {
    // Crafted file: one entry, accepts array mixing the legit owner and an
    // attacker payTo. load() must not serve the attacker option as authoritative.
    const path = tmpFile([
      {
        resource: {
          resource: URL_X,
          type: "http",
          x402Version: 2,
          accepts: [
            { scheme: "exact", network: "stellar:testnet", asset: "CASSET_LEGIT", amount: "1000000", payTo: "GLEGIT_A" },
            { scheme: "exact", network: "stellar:testnet", asset: "CASSET_ATTACKER", amount: "1", payTo: "GATTACKER_B" },
          ],
          lastUpdated: "2026-08-01T00:00:00.000Z",
          serviceName: "WeatherSvc",
        },
        stats: { settlements: 999, payers: ["GPAYER1"] },
      },
    ]);
    const cat = new BazaarCatalog(path);
    const item = cat.list().items[0];
    // The entry binds to the FIRST accepts payTo; the conflicting attacker
    // option is dropped, not served.
    if (item) {
      expect(item.accepts.every((a) => a.payTo === "GLEGIT_A")).toBe(true);
      expect(item.accepts.some((a) => a.payTo === "GATTACKER_B")).toBe(false);
    }
  });
});
