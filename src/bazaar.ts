import type { x402Facilitator } from "@x402/core/facilitator";
import { BAZAAR, extractDiscoveryInfo } from "@x402/extensions/bazaar";
import type { BazaarCatalog } from "./catalog.js";
import { verifyResourceOwnership, type OwnershipVerdict } from "./ownership.js";

/** Injectable for tests; production uses the SSRF-guarded 402-challenge fetch. */
/** G-1: takes the resource's whole BOUND set, so a merchant with a rotated
 * address (runbook §1 appends rather than replaces) is settled in one fetch. */
type OwnershipVerifier = (resourceUrl: string, payTos: string[]) => Promise<OwnershipVerdict>;

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
      catalog.upsertFromPayment(discovered, requirements);
      // Settlement ground truth (trust layer): count the settlement and the
      // distinct payer against the cataloged resource.
      //
      // G-4: this runs even when the upsert above was REJECTED, which is how a
      // refused F11 hijack used to inflate the victim entry's stats. The payTo
      // is now passed through and the catalog refuses any that is not bound, so
      // the ordering here is no longer load-bearing for correctness.
      catalog.recordSettlement(discovered.resourceUrl, result.payer, requirements.payTo);

      // Fix 0 Layer 2, extended by G-1: verify ownership against the resource's
      // own 402 challenge — on the first catalog of a URL, AND on any later
      // settlement by the bound owner while the entry is still unverified.
      //
      // The second case is the one bindLoadedEntry's comment always claimed
      // existed: `verifiedOwner` is never restored from disk (RA-9), so without
      // it a restored entry served ownerVerified:false forever and
      // verified_only=true returned an empty catalog.
      //
      // FIRE-AND-FORGET IS LOAD-BEARING, not stylistic: @x402/core AWAITS this
      // hook (facilitator/index.mjs `await hook(resultContext)`), so anything
      // awaited here delays the settle response. Settlement must never wait on,
      // nor fail because of, a merchant's endpoint. `void` + `.catch()` is what
      // guarantees that; do not "clean it up" into an await.
      //
      // All gating (bound-owner check, cooldowns, in-flight dedupe, templated
      // and empty-binding skips) lives in catalog.reverify, which reads the
      // binding internally. The binding is deliberately NOT passed in or handed
      // out — entry.boundPayTo aliases the ownership tombstone, so exposing it
      // would put a durable rebinding primitive one `.push()` away.
      void catalog
        .reverify(discovered.resourceUrl, requirements.payTo, verifyOwnership)
        .catch((err) => {
          // Verification problems degrade to unverified, never surface.
          console.warn(`[bazaar] ownership verification failed for ${discovered.resourceUrl}:`, err);
        });
    } catch (err) {
      console.error("[bazaar] cataloging failed (settlement unaffected):", err);
    }
  });
}
