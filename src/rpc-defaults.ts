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
 * Horizon's URL (see HORIZON_URL below) and the network passphrase (see
 * NETWORK_PASSPHRASE below) live in this same file for the same reason, each
 * as its own map rather than folded into this one — they are different
 * identities keyed the same way, and collapsing distinct identities into one
 * map just to share a file is the wrong kind of DRY. Horizon's URL was
 * originally a single inline ternary in `src/server.ts`, exempted from this
 * treatment on the grounds that one call site carries no drift risk; it
 * stopped being exempt the moment `src/payability.ts` became a second one.
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

/**
 * The network passphrase, per network — same "one place, drift-tested" fix as
 * DEFAULT_RPC above, for a pair that used to be written out independently in
 * `src/upto.ts` and `src/bond.ts`. Both copies agreed only because nobody had
 * reason to change one without the other yet.
 */
export const NETWORK_PASSPHRASE: Record<string, string> = {
  "stellar:testnet": "Test SDF Network ; September 2015",
  "stellar:pubnet": "Public Global Stellar Network ; September 2015",
};

/**
 * The passphrase for a network, or THROWS for one we have no passphrase for.
 *
 * Deliberately the opposite failure contract from `defaultRpcFor` above, not
 * an inconsistency: an RPC endpoint is read-only infrastructure, so a missing
 * default degrades to a caller-supplied fallback. A passphrase is signed into
 * every transaction — using the wrong one (or silently defaulting to
 * testnet's) produces a transaction that is valid-LOOKING and verifies
 * against the wrong network, which is exactly the silent-fallback shape that
 * produced a real defect in the companion wallet repo (RA-10). There is no
 * safe default to fall back to here, so an unrecognised network must fail
 * loudly at the point of use rather than resolve to a plausible-looking
 * wrong value three function calls downstream.
 */
export function networkPassphraseFor(network: string): string {
  const passphrase = NETWORK_PASSPHRASE[network];
  if (passphrase === undefined) {
    throw new Error(
      `networkPassphraseFor: no passphrase configured for network "${network}" — refusing to guess ` +
        `rather than silently resolve to the wrong network's passphrase`,
    );
  }
  return passphrase;
}

/**
 * Horizon's base URL, per network. Was a single inline ternary in
 * `src/server.ts` (the sponsor balance guard) until `src/payability.ts`
 * became a second call site — at which point the single-site exemption this
 * file's header comment originally gave Horizon no longer held, and a second
 * inline copy would have been exactly the drift risk DEFAULT_RPC exists to
 * prevent for Soroban RPC.
 */
export const HORIZON_URL: Record<string, string> = {
  "stellar:testnet": "https://horizon-testnet.stellar.org",
  "stellar:pubnet": "https://horizon.stellar.org",
};

/** Horizon's base URL for a network, or THROWS for one we have no URL for.
 *  Same reasoning as networkPassphraseFor: Horizon's identity is read against
 *  trustline/balance state that differs completely between networks, so a
 *  silent wrong-network fallback here would answer a real-looking question
 *  about the wrong ledger rather than failing visibly. */
export function horizonUrlFor(network: string): string {
  const url = HORIZON_URL[network];
  if (url === undefined) {
    throw new Error(`horizonUrlFor: no Horizon URL configured for network "${network}"`);
  }
  return url;
}
