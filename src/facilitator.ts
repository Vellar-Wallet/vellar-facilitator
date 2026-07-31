import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { createEd25519Signer } from "@x402/stellar";
import type { FacilitatorConfig } from "./config.js";

export function buildFacilitator(config: FacilitatorConfig): x402Facilitator {
  const sponsorSigner = createEd25519Signer(config.sponsorSecretKey, config.network);

  const scheme = new ExactStellarScheme([sponsorSigner], {
    maxTransactionFeeStroops: config.maxTransactionFeeStroops,
    ...(config.rpcUrl ? { rpcConfig: { url: config.rpcUrl } } : {}),
  });

  return new x402Facilitator().register(config.network, scheme);
}
