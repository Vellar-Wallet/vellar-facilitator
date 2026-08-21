import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { createEd25519Signer } from "@x402/stellar";
import type { FacilitatorConfig } from "./config.js";
import { UptoStellarScheme } from "./upto.js";

export function buildFacilitator(config: FacilitatorConfig): x402Facilitator {
  const sponsorSigner = createEd25519Signer(config.sponsorSecretKey, config.network);

  const scheme = new ExactStellarScheme([sponsorSigner], {
    maxTransactionFeeStroops: config.maxTransactionFeeStroops,
    ...(config.rpcUrl ? { rpcConfig: { url: config.rpcUrl } } : {}),
  });

  const facilitator = new x402Facilitator().register(config.network, scheme);

  // `upto` is opt-in by contract ID: unset means exact-only, which is every
  // deployment that predates the scheme. The contract is OUR build from pinned
  // source (contracts/upto-stellar/PROVENANCE.md) — never a third party's
  // deployed instance whose wasm hash we have not verified.
  if (config.uptoContractId) {
    facilitator.register(
      config.network,
      new UptoStellarScheme({
        contractId: config.uptoContractId,
        sponsorSecretKey: config.sponsorSecretKey,
        network: config.network,
        rpcUrl: config.rpcUrl,
        maxTransactionFeeStroops: config.maxTransactionFeeStroops,
      }) as unknown as Parameters<x402Facilitator["register"]>[1],
    );
  }

  return facilitator;
}
