# vellar-facilitator

An x402 payment facilitator for Stellar, with Bazaar (discovery) support.

> **Status: early planning, not yet building.** This repo is a placeholder
> while we scope the project against
> [SCF #45's "X402 Facilitator with Bazaar (Discovery) Support" RFP](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/rfp-track).
> Nothing here is production code yet.

## What this will be

A production `verify`/`settle` facilitator for the [x402 protocol](https://x402.org)
on Stellar, plus a Bazaar discovery layer so agents can find and pay for
x402-protected resources without hardcoded integrations.

Planned scope, mirrored from the RFP:

- x402 v2 spec implementation for Stellar via `@x402/stellar`
- Any SEP-41 token, USDC default; sponsored network fees
- Support for both classic keypairs and Soroban smart accounts
- Correct fee handling for policy-governed smart-account payments (a real
  bug we already found and fixed in our own testing — see
  [Vellar's x402 payer-side work](https://docs.vellar.xyz/docs/x402))
- Bazaar discovery: `GET /discovery/resources`, `GET /discovery/search`,
  an MCP discovery server for agent integration
- Testnet and mainnet support, public operational telemetry, security
  review before production

## Relationship to Vellar

This is **separate infrastructure** from the Vellar wallet product. Vellar
(the passkey smart wallet — [vellar-dapp](https://github.com/Vellar-Wallet/vellar-dapp),
[vellar-sdk](https://github.com/Vellar-Wallet/vellar-sdk)) is the **payer**
side of x402: a smart account that pays x402-protected resources under an
on-chain spending policy. This repo, if funded and built, would be the
**facilitator** side: the verify/settle service other apps and agents call
to transact — usable by Vellar wallets and non-Vellar wallets alike.

The two are related by shared x402 expertise, not shared code.

## License

Apache-2.0
