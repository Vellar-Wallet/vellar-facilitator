import { rpc, xdr } from "@stellar/stellar-sdk";
import type { DiscoveryResource } from "@x402/extensions/bazaar";

// The trust layer (BUILD-PLAN Phase 5): verification-provenance annotation for
// Bazaar entries. Verification truth lives in the Vellar verification service
// (consumed over its public HTTP API — no cross-repo code dependency) plus a
// best-effort live wasm-hash cross-check over public RPC, which catches the
// upgraded-since-verification (TOCTOU) case at read time.
//
// Verdicts are deliberately three-valued and degrade to "unknown", never
// block: a verification-API outage must not take discovery down with it.
//
//   verified   — latest verification run succeeded AND (when RPC is
//                reachable) the live executable hash still equals the
//                verified build's hash
//   unverified — latest run failed / nothing ever submitted / the live hash
//                drifted from the verified one (upgraded since verification)
//   unknown    — the verification API could not be consulted
//
// Honesty bar (design-provenance-gated-spending.md): verified means
// REPRODUCIBLE SOURCE PROVENANCE, not audited/benign/safe.

export type TrustVerification = "verified" | "unverified" | "unknown";

/** Wire shape of a trust-annotated Bazaar entry: the standard DiscoveryResource
 * plus an additive `trust` block (settlement stats come from the catalog;
 * the verification fields are filled in by `annotateTrust`).
 *
 * Fix 0 Layer 3: verification is annotated PER accepts entry, because payment
 * redirection (F11) lives in an individual accepts element, not in the entry.
 * `acceptsVerification[i]` is the verdict for `accepts[i]`. `verification` is
 * the entry-level roll-up: the strict minimum across all accepts. Both are
 * clamped by `ownerVerified` — an accepts option can only read "verified" when
 * its asset is verified AND the resource owner passed the Layer 2 402 challenge.
 * An owner-unverified entry never surfaces a verified badge. */
export type TrustedDiscoveryResource = DiscoveryResource & {
  trust?: {
    settlements: number;
    uniquePayers: number;
    lastSettled?: string;
    /** Entry-level roll-up: strict min across acceptsVerification. */
    verification?: TrustVerification;
    /** Per-accepts verdicts, index-aligned with `accepts`. */
    acceptsVerification?: TrustVerification[];
    /** Whether the resource owner passed Layer 2 402-challenge verification. */
    ownerVerified?: boolean;
  };
};

/** Owner-verification lookup (Fix 0 Layer 2): does the catalog consider this
 * resourceUrl's bound owner confirmed by its own 402 challenge? */
export type OwnerVerifiedFn = (resourceUrl: string) => boolean;

/** Rank order for the strict-minimum roll-up: verified is best (0). */
const RANK: Record<TrustVerification, number> = { verified: 0, unknown: 1, unverified: 2 };

function strictMin(verdicts: TrustVerification[]): TrustVerification {
  if (verdicts.length === 0) return "unknown";
  return verdicts.reduce((worst, v) => (RANK[v] > RANK[worst] ? v : worst), "verified" as TrustVerification);
}

export interface TrustResolver {
  /** Verification verdict for one contract id (cached). */
  assetStatus(contractId: string): Promise<TrustVerification>;
}

export interface TrustResolverOptions {
  /** Base URL of the verification API (e.g. https://…/verification). Unset ⇒
   * lookups are disabled and every verdict is "unknown". */
  verificationApiUrl?: string | undefined;
  /** Soroban RPC for the live wasm-hash cross-check. Unset ⇒ the check is
   * skipped and the API verdict stands. */
  rpcUrl?: string | undefined;
  cacheTtlMs?: number;
  /** Injected for tests. */
  fetchFn?: typeof fetch;
  rpcServer?: Pick<rpc.Server, "getContractData">;
}

interface HistoryResponse {
  records?: Array<{ status?: string; outputHash?: string }>;
}

export function createTrustResolver(options: TrustResolverOptions): TrustResolver {
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  const fetchFn = options.fetchFn ?? fetch;
  const rpcServer =
    options.rpcServer ?? (options.rpcUrl ? new rpc.Server(options.rpcUrl) : undefined);
  const cache = new Map<string, { verdict: TrustVerification; at: number }>();

  async function liveHash(contractId: string): Promise<string | undefined> {
    if (!rpcServer) return undefined;
    const entry = await rpcServer.getContractData(
      contractId,
      xdr.ScVal.scvLedgerKeyContractInstance(),
      rpc.Durability.Persistent,
    );
    const executable = entry.val.contractData().val().instance().executable();
    if (executable.switch() !== xdr.ContractExecutableType.contractExecutableWasm()) {
      return undefined;
    }
    return executable.wasmHash().toString("hex").toLowerCase();
  }

  return {
    async assetStatus(contractId) {
      if (!options.verificationApiUrl) return "unknown";

      const cached = cache.get(contractId);
      if (cached && Date.now() - cached.at < cacheTtlMs) return cached.verdict;

      let verdict: TrustVerification;
      try {
        const base = options.verificationApiUrl.replace(/\/$/, "");
        const res = await fetchFn(`${base}/${contractId}`);
        if (!res.ok) throw new Error(`verification API HTTP ${res.status}`);
        const body = (await res.json()) as HistoryResponse;
        const latest = body.records?.[0];

        if (latest?.status !== "verified") {
          verdict = "unverified";
        } else {
          verdict = "verified";
          // Best-effort TOCTOU tightening: a contract upgraded since its
          // verification is no longer running the verified code. RPC trouble
          // leaves the API verdict standing (uncertainty never downgrades);
          // a confirmed drift does downgrade.
          if (latest.outputHash) {
            try {
              const live = await liveHash(contractId);
              if (live !== undefined && live !== latest.outputHash.toLowerCase()) {
                verdict = "unverified";
              }
            } catch {
              /* keep the API verdict */
            }
          }
        }
      } catch {
        // The verification API being unreachable must never block discovery.
        verdict = "unknown";
      }

      cache.set(contractId, { verdict, at: Date.now() });
      return verdict;
    },
  };
}

/**
 * Fix 0 Layer 3: annotate verification PER accepts entry. For each accepts
 * option, resolve its asset's verdict, then clamp: an option may read "verified"
 * only if the resource owner passed Layer 2 (`ownerVerified`). When the owner is
 * NOT verified, every option is clamped to at most "unknown", so no redirection
 * option can wear a verified badge. The entry-level `verification` is the strict
 * minimum across the (clamped) per-accepts verdicts.
 *
 * `ownerVerifiedFn` is optional: when omitted, ownership cannot be asserted, so
 * `ownerVerified` is false and nothing shows verified (the safe default).
 */
export async function annotateTrust(
  items: TrustedDiscoveryResource[],
  resolver: TrustResolver,
  ownerVerifiedFn?: OwnerVerifiedFn,
): Promise<TrustedDiscoveryResource[]> {
  return Promise.all(
    items.map(async (item) => {
      const ownerVerified = ownerVerifiedFn ? ownerVerifiedFn(item.resource) : false;

      // Per-accepts asset verdicts, index-aligned with item.accepts, then clamped.
      const rawVerdicts = await Promise.all(
        item.accepts.map((a) => (a.asset ? resolver.assetStatus(a.asset) : Promise.resolve<TrustVerification>("unknown"))),
      );
      const acceptsVerification = rawVerdicts.map((v) => clampByOwner(v, ownerVerified));
      const verification = strictMin(acceptsVerification);

      return {
        ...item,
        trust: {
          settlements: item.trust?.settlements ?? 0,
          uniquePayers: item.trust?.uniquePayers ?? 0,
          ...(item.trust?.lastSettled ? { lastSettled: item.trust.lastSettled } : {}),
          verification,
          acceptsVerification,
          ownerVerified,
        },
      };
    }),
  );
}

/** An option can only be "verified" if the owner is verified; otherwise the best
 * it can read is "unknown" (never downgrade an already-"unverified" asset). */
function clampByOwner(verdict: TrustVerification, ownerVerified: boolean): TrustVerification {
  if (ownerVerified) return verdict;
  return verdict === "verified" ? "unknown" : verdict;
}

/** Keep only entries whose verification verdict is "verified". */
export function filterVerifiedOnly(items: TrustedDiscoveryResource[]): TrustedDiscoveryResource[] {
  return items.filter((item) => item.trust?.verification === "verified");
}

/** Stable rerank: verified entries first, existing order preserved within
 * groups (search relevance stays intact inside each band). */
export function rerankVerifiedFirst(items: TrustedDiscoveryResource[]): TrustedDiscoveryResource[] {
  const rank = (item: TrustedDiscoveryResource) =>
    item.trust?.verification === "verified" ? 0 : item.trust?.verification === "unknown" ? 1 : 2;
  return [...items].sort((a, b) => rank(a) - rank(b));
}
