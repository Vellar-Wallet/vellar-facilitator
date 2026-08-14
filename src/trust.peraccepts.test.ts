import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { annotateTrust, type TrustedDiscoveryResource, type TrustResolver } from "./trust.js";

// Fix 0 Layer 3 — per-accepts trust annotation. Redirection (F11) lives in an
// individual accepts element, so trust must be annotated per accepts entry, not
// once per resource. And an entry whose OWNER is unverified (Layer 2) must never
// surface a "verified" badge over any of its accepts — the entry-level verdict
// is the strict minimum across accepts, further clamped by owner-verification.

function resolver(map: Record<string, "verified" | "unverified" | "unknown">): TrustResolver {
  return { hasVerdictSource: true, assetStatus: async (id) => map[id] ?? "unknown" };
}

function item(assets: string[], resource = "https://api.example.com/r"): TrustedDiscoveryResource {
  return {
    resource,
    type: "http",
    x402Version: 2,
    accepts: assets.map(
      (a) => ({ scheme: "exact", network: "stellar:testnet", asset: a, amount: "1", payTo: "G", maxTimeoutSeconds: 60, extra: {} }) as PaymentRequirements,
    ),
    lastUpdated: new Date().toISOString(),
  };
}

describe("Fix 0 Layer 3 — per-accepts trust annotation", () => {
  it("annotates each accepts entry with its own asset's verdict", async () => {
    // Owner verified so per-asset verdicts are not clamped down.
    const [annotated] = await annotateTrust(
      [item(["CV", "CU"])],
      resolver({ CV: "verified", CU: "unverified" }),
      () => true,
    );
    expect(annotated!.trust?.acceptsVerification).toEqual(["verified", "unverified"]);
  });

  it("entry-level verdict is the strict minimum across accepts", async () => {
    const [annotated] = await annotateTrust(
      [item(["CV", "CU"])],
      resolver({ CV: "verified", CU: "unverified" }),
      () => true,
    );
    // verified + unverified → entry min is unverified.
    expect(annotated!.trust?.verification).toBe("unverified");
  });

  it("clamps every accepts verdict to at most 'unknown' when the owner is UNVERIFIED", async () => {
    // Both assets are individually verified, but the resource owner failed the
    // 402 challenge (Layer 2). No accepts option may claim 'verified'.
    const [annotated] = await annotateTrust(
      [item(["CV", "CV2"])],
      resolver({ CV: "verified", CV2: "verified" }),
      () => false, // owner NOT verified
    );
    expect(annotated!.trust?.acceptsVerification).toEqual(["unknown", "unknown"]);
    expect(annotated!.trust?.verification).toBe("unknown");
    expect(annotated!.trust?.ownerVerified).toBe(false);
  });

  it("surfaces ownerVerified=true and preserves verified badge when owner passed L2", async () => {
    const [annotated] = await annotateTrust(
      [item(["CV"])],
      resolver({ CV: "verified" }),
      () => true,
    );
    expect(annotated!.trust?.ownerVerified).toBe(true);
    expect(annotated!.trust?.verification).toBe("verified");
    expect(annotated!.trust?.acceptsVerification).toEqual(["verified"]);
  });

  it("preserves stats provenance through annotation", async () => {
    // annotateTrust rebuilds the trust block; it must not drop the fields that
    // disclose whether settlement counts came from disk.
    const withStats = {
      ...item(["CV"]),
      trust: {
        settlements: 9999,
        uniquePayers: 3,
        observedSettlements: 0,
        statsSource: "persisted" as const,
      },
    };
    const [annotated] = await annotateTrust([withStats], resolver({ CV: "verified" }), () => true);
    expect(annotated!.trust?.observedSettlements).toBe(0);
    expect(annotated!.trust?.statsSource).toBe("persisted");
  });

  it("defaults ownerVerified to false when no owner-check is supplied (safe default)", async () => {
    const [annotated] = await annotateTrust([item(["CV"])], resolver({ CV: "verified" }));
    // Without an owner check, we cannot assert ownership → never show verified.
    expect(annotated!.trust?.ownerVerified).toBe(false);
    expect(annotated!.trust?.verification).not.toBe("verified");
  });
});
