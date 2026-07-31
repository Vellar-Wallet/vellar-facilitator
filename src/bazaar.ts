import type { x402Facilitator } from "@x402/core/facilitator";
import { BAZAAR, extractDiscoveryInfo } from "@x402/extensions/bazaar";
import type { BazaarCatalog } from "./catalog.js";

/**
 * Wires Bazaar discovery into the facilitator:
 *
 * - registers the official BAZAAR extension so GET /supported advertises
 *   `extensions: ["bazaar"]` to sellers and clients;
 * - catalogs resources automatically from payment traffic: when a payment
 *   SETTLES successfully and its payload carries the bazaar discovery
 *   extension, the resource is upserted into the catalog.
 *
 * Catalog-on-settle (not on verify) is deliberate: a resource enters the
 * public catalog only after at least one real payment settled on-chain for
 * it, which keeps unpaid/spammed declarations out. extractDiscoveryInfo is
 * the official trust-boundary helper — it validates the extension against
 * its schema, drops unsafe routeTemplates (catalog poisoning), and
 * sanitizes serviceName/tags/iconUrl.
 *
 * Cataloging must never affect settlement: the hook swallows its own errors.
 */
export function registerBazaar(facilitator: x402Facilitator, catalog: BazaarCatalog): void {
  facilitator.registerExtension(BAZAAR);

  facilitator.onAfterSettle(async ({ paymentPayload, requirements, result }) => {
    try {
      if (!result.success) return;
      const discovered = extractDiscoveryInfo(paymentPayload, requirements);
      if (!discovered) return;
      catalog.upsertFromPayment(discovered, requirements);
    } catch (err) {
      console.error("[bazaar] cataloging failed (settlement unaffected):", err);
    }
  });
}
