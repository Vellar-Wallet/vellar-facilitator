/**
 * The default Soroban RPC endpoint per network, in ONE place.
 *
 * This pair used to be written out three times: `src/upto.ts`, `src/bond.ts`,
 * and an inline ternary in `src/server.ts`. They agreed only because f1d078b
 * checked them by hand, and nothing would have caught a fourth copy or a typo
 * in one of them.
 *
 * That is the `docs/closing-state.md` §3.7 shape, "one identity, several
 * derivations, no test that they agree", which has already produced a real
 * defect here once (G-3: the spend policy keyed on the raw URL while the
 * catalog keyed on the canonical one, and they agreed only because the demo
 * seller happened to report one stable URL). The drift is silent when it
 * happens: a facilitator settling on pubnet while resolving trust against
 * testnet returns "unknown" verdicts rather than an error.
 *
 * `src/rpc-defaults.test.ts` asserts every consumer resolves to these values,
 * so a future divergence fails CI instead of being found by hand.
 *
 * NOT included here: the Horizon pair in `src/server.ts` (balance polling).
 * Different service, different hostnames, and it exists at exactly one site, so
 * it carries no drift risk today. Folding it in would mean one map holding two
 * unrelated identities keyed the same way, which is worse than the duplication
 * it would remove.
 */
export const DEFAULT_RPC: Record<string, string> = {
  "stellar:testnet": "https://soroban-testnet.stellar.org",
  "stellar:pubnet": "https://mainnet.sorobanrpc.com",
};

/**
 * The default RPC for a network, or undefined for a network we have no default
 * for. Callers pass `config.network`, which is typed to the two known values,
 * so the undefined branch is unreachable in production and exists for the
 * hand-constructed case in tests.
 */
export function defaultRpcFor(network: string): string | undefined {
  return DEFAULT_RPC[network];
}
