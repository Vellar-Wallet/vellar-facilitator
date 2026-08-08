export interface FacilitatorConfig {
  port: number;
  host: string;
  network: "stellar:testnet" | "stellar:pubnet";
  rpcUrl: string | undefined;
  sponsorSecretKey: string;
  maxTransactionFeeStroops: number;
  /** Optional JSON file path for Bazaar catalog persistence across restarts. */
  catalogFile: string | undefined;
  /** Base URL of the Vellar verification API (e.g. https://…/verification) for
   * the Bazaar trust layer. Unset ⇒ verification verdicts are "unknown". */
  verificationApiUrl: string | undefined;
  /** Fix 1 sponsorship spend control. Enforced on pubnet, log-only on testnet. */
  spend: {
    /** Max settlements per payTo per window (default 30). */
    rateMax: number;
    /** Per-payTo rate window in ms (default 60_000). */
    rateWindowMs: number;
    /** Global rolling sponsor-spend ceiling in stroops (default 5 XLM). */
    ceilingStroops: number;
    /** Global spend window in ms (default 60_000). */
    windowMs: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const sponsorSecretKey = env.SPONSOR_SECRET_KEY;
  if (!sponsorSecretKey) {
    throw new Error(
      "SPONSOR_SECRET_KEY is required: a funded Stellar classic (S...) secret whose account settles payments and pays sponsored fees",
    );
  }

  const network = env.STELLAR_NETWORK === "pubnet" ? "stellar:pubnet" : "stellar:testnet";

  // Default raised well above @x402/stellar's 50_000 default: policy-governed
  // smart-account payments run the policy contract inside __check_auth, which
  // pushes the simulation-derived fee to ~140k stroops. Rejecting those was
  // the exact hosted-facilitator bug that motivated this project.
  const maxTransactionFeeStroops = Number(env.MAX_TX_FEE_STROOPS ?? 2_000_000);
  if (!Number.isInteger(maxTransactionFeeStroops) || maxTransactionFeeStroops <= 0) {
    throw new Error(`MAX_TX_FEE_STROOPS must be a positive integer, got: ${env.MAX_TX_FEE_STROOPS}`);
  }

  const spend = {
    rateMax: positiveIntEnv(env.SETTLE_RATE_MAX, 30, "SETTLE_RATE_MAX"),
    rateWindowMs: positiveIntEnv(env.SETTLE_RATE_WINDOW_MS, 60_000, "SETTLE_RATE_WINDOW_MS"),
    // 5 XLM = 50,000,000 stroops. NOTE (Fix 1): review before pubnet — chosen
    // as a conservative default, not derived from measured live spend.
    ceilingStroops: positiveIntEnv(env.SPEND_CEILING_STROOPS, 50_000_000, "SPEND_CEILING_STROOPS"),
    windowMs: positiveIntEnv(env.SPEND_WINDOW_MS, 60_000, "SPEND_WINDOW_MS"),
  };

  return {
    port: Number(env.PORT ?? 4100),
    host: env.HOST ?? "0.0.0.0",
    network,
    rpcUrl: env.STELLAR_RPC_URL,
    sponsorSecretKey,
    maxTransactionFeeStroops,
    catalogFile: env.CATALOG_FILE,
    verificationApiUrl: env.VERIFICATION_API_URL,
    spend,
  };
}

/** Parse a positive-integer env var, falling back to `fallback` when unset.
 * Throws on a present-but-invalid value (fail fast at startup, never silently
 * coerce a spend limit to NaN). */
function positiveIntEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}
