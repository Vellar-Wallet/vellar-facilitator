import type { x402Facilitator } from "@x402/core/facilitator";
import { BAZAAR, extractDiscoveryInfo } from "@x402/extensions/bazaar";
import type { BazaarCatalog } from "./catalog.js";
import { verifyResourceOwnership, type OwnershipVerdict } from "./ownership.js";

/** Injectable for tests; production uses the SSRF-guarded 402-challenge fetch. */
type OwnershipVerifier = (resourceUrl: string, payTo: string) => Promise<OwnershipVerdict>;

export interface RegisterBazaarOptions {
  /** Layer 2 verifier. Defaults to the real SSRF-guarded fetch; unset in tests
   * or when Layer 2 is disabled leaves entries at TOFU-only (unverified). */
  verifyOwnership?: OwnershipVerifier;
}

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
export function registerBazaar(
  facilitator: x402Facilitator,
  catalog: BazaarCatalog,
  options: RegisterBazaarOptions = {},
): void {
  facilitator.registerExtension(BAZAAR);
  const verifyOwnership = options.verifyOwnership ?? verifyResourceOwnership;

  facilitator.onAfterSettle(async ({ paymentPayload, requirements, result }) => {
    try {
      if (!result.success) return;
      const discovered = extractDiscoveryInfo(paymentPayload, requirements);
      if (!discovered) return;
      const firstCatalog = catalog.upsertFromPayment(discovered, requirements);
      // Settlement ground truth (trust layer): count the settlement and the
      // distinct payer against the cataloged resource.
      catalog.recordSettlement(discovered.resourceUrl, result.payer);

      // Fix 0 Layer 2: on the FIRST catalog of a URL, verify ownership against
      // the resource's own 402 challenge — asynchronously, fire-and-forget.
      // Settlement has already been recorded above and returns immediately; the
      // verification never blocks, delays, or fails it (§ "off the hot path").
      if (firstCatalog) {
        const { resourceUrl } = discovered;
        const { payTo } = requirements;
        void verifyOwnership(resourceUrl, payTo)
          .then((verdict) => {
            catalog.setVerifiedOwner(resourceUrl, verdict === "match");
            if (verdict === "mismatch") {
              console.warn(
                `[bazaar] ownership MISMATCH for ${resourceUrl}: settled payTo ${payTo} not in ` +
                  `the resource's 402 challenge — accepts left non-authoritative (F11 Layer 2)`,
              );
            }
          })
          .catch((err) => {
            // Verification errors degrade to unverified, never surface.
            console.warn(`[bazaar] ownership verification failed for ${resourceUrl}:`, err);
          });
      }
    } catch (err) {
      console.error("[bazaar] cataloging failed (settlement unaffected):", err);
    }
  });
}
