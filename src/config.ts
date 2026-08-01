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

  return {
    port: Number(env.PORT ?? 4100),
    host: env.HOST ?? "0.0.0.0",
    network,
    rpcUrl: env.STELLAR_RPC_URL,
    sponsorSecretKey,
    maxTransactionFeeStroops,
    catalogFile: env.CATALOG_FILE,
    verificationApiUrl: env.VERIFICATION_API_URL,
  };
}
