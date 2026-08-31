export interface FacilitatorConfig {
  port: number;
  host: string;
  network: "stellar:testnet" | "stellar:pubnet";
  rpcUrl: string | undefined;
  sponsorSecretKey: string;
  /** Channel-account pool for ExactStellarScheme settlement concurrency —
   *  see docs/channel-pool-design.md. Exactly 50 (§2: sized for 50 true-
   *  simultaneous settlements, not a probabilistic smaller pool), never the
   *  sponsor's own key (§5: the sponsor is excluded from the pool by design,
   *  reserved for funding channel accounts and as feeBumpSigner only). Both
   *  invariants are enforced at boot in loadConfig, not left to be
   *  discovered the first time two settlements collide. */
  channelAccountSecretKeys: string[];
  maxTransactionFeeStroops: number;
  /** Our deployed `upto` settlement contract (C…). Set ⇒ the upto scheme is
   *  registered and advertised on /supported. Unset ⇒ exact only. Built from
   *  pinned source — contracts/upto-stellar/PROVENANCE.md; deployment record
   *  and wasm hash in docs/upto-deployment.md. */
  uptoContractId: string | undefined;
  /** Our deployed `bond-escrow` contract (C…). Set ⇒ a settled payment is
   *  registered with it (giving the payer standing to dispute) as part of
   *  /settle. Unset ⇒ bonding is entirely inactive; settlement behaves
   *  exactly as it does today. Original work, not vendored — deployment
   *  record and wasm hash in docs/bond-escrow-deployment.md. Must be set
   *  together with bondEscrowAdminSecretKey or not at all — see loadConfig. */
  bondEscrowContractId: string | undefined;
  /** The dedicated Stellar secret (S…) that signs `register_settlement`
   *  calls against bondEscrowContractId — deliberately NOT sponsorSecretKey.
   *  See contracts/bond-escrow/src/lib.rs, initialize's doc-comment ("Which
   *  key: a dedicated admin key, not the facilitator's payment sponsor
   *  key") for why: compromising this key lets an attacker forge dispute
   *  standing and drain bonded funds, a different blast radius than
   *  compromising the payment-sponsor key, and the two must be rotatable
   *  independently. */
  bondEscrowAdminSecretKey: string | undefined;
  /** Optional JSON file path for Bazaar catalog persistence across restarts. */
  /** libSQL/Turso URL. `file:…` locally, `libsql://…` in production. Unset means
   *  in-memory only: the catalog works but nothing survives a restart. */
  catalogDbUrl: string | undefined;
  catalogDbAuthToken: string | undefined;
  /** Base URL of the Vellar verification API (e.g. https://…/verification) for
   * the Bazaar trust layer. Unset ⇒ verification verdicts are "unknown". */
  verificationApiUrl: string | undefined;
  /** Fix 1 sponsorship spend control. Enforced on pubnet, log-only on testnet. */
  spend: {
    /** Shared window for ALL per-entity budgets below, in ms (default 60_000). */
    rateWindowMs: number;
    /** Global rolling sponsor-spend ceiling in stroops (default 50_000_000 = 5 XLM). */
    ceilingStroops: number;
    /** Global spend window in ms (default 60_000). */
    windowMs: number;
    /** F12: settles/window for one BOUND resource URL (default 10). */
    perUrlMax: number;
    /**
     * F12: settles/window per payTo (default 50). The ONLY per-payTo budget —
     * `SETTLE_RATE_MAX` used to be a second one on the same key and window, and
     * being tighter it shadowed this entirely, so this dimension never ran.
     *
     * 50 is half the global capacity (see `documented rationale` in
     * src/config.thresholds.test.ts, which asserts that relationship). It is a
     * real ratchet — no single payTo can consume the whole service — and it no
     * longer taxes an honest merchant running several bound URLs, who gets
     * `perUrlMax` on each up to this total.
     */
    perPayToMax: number;
    /** F12: settles/window shared by ALL unbound URLs (default 10). */
    unboundPoolMax: number;
  };
  /**
   * ESCAPE HATCH (F3). Permits deriving ownership bindings from an existing
   * catalog file when the companion ownership store is absent — the state a
   * first upgrade produces, and equally the state a tamperer produces. Off by
   * default; must be set deliberately and removed once the upgrade is done.
   */
  /** Fix 3 sponsor balance guard floors, in stroops. */
  balance: {
    /** Warn below this (default 250_000_000 = 25 XLM). */
    softFloorStroops: number;
    /** Refuse /settle below this (default 100_000_000 = 10 XLM). Must exceed
     * `ceilingStroops`; enforced at boot (fatal on pubnet). */
    hardFloorStroops: number;
    /** Poll interval in ms (default 60_000). */
    intervalMs: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const sponsorSecretKey = env.SPONSOR_SECRET_KEY;
  if (!sponsorSecretKey) {
    throw new Error(
      "SPONSOR_SECRET_KEY is required: a funded Stellar classic (S...) secret whose account settles payments and pays sponsored fees",
    );
  }

  const channelAccountSecretKeys = parseChannelAccountSecretKeys(env.CHANNEL_ACCOUNT_SECRET_KEYS, sponsorSecretKey);

  const network = env.STELLAR_NETWORK === "pubnet" ? "stellar:pubnet" : "stellar:testnet";

  // ==========================================================================
  // "THE FEE" IS THREE DIFFERENT NUMBERS. Read this before touching any
  // threshold below, and name the quantity whenever you cite one.
  //
  //   CHARGED   what the network actually deducted (Horizon `fee_charged`).
  //             Consumer: the SPONSOR'S BALANCE — so the balance guard, the
  //             hard floor, and any "how long can this be sustained" argument.
  //             Measured: 22,579 stroops, four Horizon-confirmed settlements
  //             (8c0d9682…, 9726d45e…, 867632de…, c4ee7bdd…, 2026-08-10).
  //
  //   BID       minResourceFee + BASE_FEE, computed from simulation BEFORE
  //             submission. Consumer: MAX_TX_FEE_STROOPS immediately below —
  //             which compares against EXACTLY THIS and never sees the charge
  //             (@x402/stellar/dist/cjs/exact/facilitator/index.js:487-489).
  //             Measured: 32,655, two independent simulations. It carries NO
  //             transaction hash AND NONE IS OBTAINABLE — a bid that is never
  //             submitted leaves no chain record. That is a property of the
  //             quantity, not a gap in the evidence.
  //
  //   ESTIMATE  a constant used for spend accounting, currently the ceiling
  //             itself (500,000). Consumer: SPEND_CEILING_STROOPS. Not a
  //             measurement at all.
  //
  // The charged fee runs ~31% BELOW the bid, which is normal: simulation
  // over-reserves. Sizing this ceiling against the charged fee would tighten it
  // by that much against a number it never sees. Sizing the balance guard
  // against the bid would overstate the burn. Conflating the three is what
  // produced the 127,808 confusion recorded in docs/security-audit.md.
  // ==========================================================================
  //
  // Raised well above @x402/stellar's 50_000 default: policy-governed
  // smart-account payments run the policy contract inside __check_auth, which
  // pushes the BID to ~130k stroops on a policy-governed account. Rejecting
  // those was the exact hosted-facilitator bug that motivated this project — so
  // this ceiling must never dip toward 50k.
  //
  // Sizing, with provenance stated per figure:
  //   - measured BID for the walkthrough wallet: 32,655 -> 500,000 clears it 15.3x
  //   - cited worst-case bid: 127,808 -> 500,000 clears it 3.9x. THIS FIGURE
  //     CARRIES NO HASH and has never been re-derived; it is retained because it
  //     is the conservative one and describes a heavier policy contract than the
  //     wallet we measured, NOT because it has been verified. Do not cite it as
  //     measured.
  // The ceiling also stays 2.5x above the documented 200k floor, and caps the
  // worst-case sponsor drain per settle at 0.05 XLM. Raise via MAX_TX_FEE_STROOPS
  // if a heavier policy ever legitimately exceeds it — the failure is loud
  // (fee_exceeds_maximum), not silent.
  const maxTransactionFeeStroops = Number(env.MAX_TX_FEE_STROOPS ?? 500_000);
  if (!Number.isInteger(maxTransactionFeeStroops) || maxTransactionFeeStroops <= 0) {
    throw new Error(`MAX_TX_FEE_STROOPS must be a positive integer, got: ${env.MAX_TX_FEE_STROOPS}`);
  }

  const spend = {
    rateWindowMs: positiveIntEnv(env.SETTLE_RATE_WINDOW_MS, 60_000, "SETTLE_RATE_WINDOW_MS"),
    // 50,000,000 stroops = 5 XLM per window. Accounted at the ESTIMATE (500,000,
    // see the three-quantities note above), so that is 100 settlements per window
    // across ALL merchants, and perPayToMax (50) is deliberately half of it.
    //
    // OPEN (pubnet tuning, deliberately NOT changed here): the estimate is 22x
    // the measured CHARGED fee, so this ceiling trips after 100 settles having
    // actually spent ~0.23 XLM of the 5 XLM it names — 4.5%. It fails safe and
    // the over-count is deliberate (server.ts), but honest throughput is
    // throttled ~22x earlier than sponsor exposure requires. Tracked in
    // docs/security-audit.md under "Still open".
    //
    // These numbers are asserted in src/config.thresholds.test.ts rather than
    // only described here: an earlier version of this comment still reasoned
    // about "1 XLM / ~20 settles per minute" long after the value had moved to
    // 5 XLM, so anyone reading it was reasoning about a system that did not
    // exist. Unreviewed against real pubnet traffic — see docs/security-audit.md.
    ceilingStroops: positiveIntEnv(env.SPEND_CEILING_STROOPS, 50_000_000, "SPEND_CEILING_STROOPS"),
    windowMs: positiveIntEnv(env.SPEND_WINDOW_MS, 60_000, "SPEND_WINDOW_MS"),
    // F12 per-entity budgets. Keyed on the DURABLE F11 ownership binding, never
    // on verifiedOwner (not persisted; resets on restart).
    perUrlMax: positiveIntEnv(env.SETTLE_PER_URL_MAX, 10, "SETTLE_PER_URL_MAX"),
    perPayToMax: positiveIntEnv(env.SETTLE_PER_PAYTO_MAX, 50, "SETTLE_PER_PAYTO_MAX"),
    unboundPoolMax: positiveIntEnv(env.SETTLE_UNBOUND_POOL_MAX, 10, "SETTLE_UNBOUND_POOL_MAX"),
  };

  // A retired knob that still parses is the next dead control: SETTLE_RATE_MAX
  // was a SECOND per-payTo budget over the same key and window, and being the
  // tighter of the two it shadowed SETTLE_PER_PAYTO_MAX so that F12's per-payTo
  // dimension never ran at all. It is gone rather than aliased, because an alias
  // would leave two names for one dimension — exactly how the shadowing arose.
  if (env.SETTLE_RATE_MAX !== undefined) {
    console.warn(
      `[config] SETTLE_RATE_MAX is RETIRED and is being IGNORED. You set ${env.SETTLE_RATE_MAX}; ` +
        `the EFFECTIVE per-payTo limit is ${spend.perPayToMax} settles per ${spend.rateWindowMs}ms. ` +
        `It was a second per-payTo budget over the same key and window, and being tighter it shadowed ` +
        `SETTLE_PER_PAYTO_MAX so that budget never ran. Set SETTLE_PER_PAYTO_MAX=${env.SETTLE_RATE_MAX} ` +
        `if you intended the old value, then remove SETTLE_RATE_MAX.`,
    );
  }

  // Balance floors. INVARIANT: the hard floor must exceed the maximum XLM a
  // single spend window can drain, because the balance verdict is up to one
  // check-interval stale. Otherwise the guard can read "above floor" and then be
  // drained straight through it before the next check — a floor that cannot
  // hold. Defaults: 25 XLM warn / 10 XLM refuse, against a 5 XLM window ceiling.
  const balance = {
    softFloorStroops: positiveIntEnv(env.SPONSOR_SOFT_FLOOR_STROOPS, 250_000_000, "SPONSOR_SOFT_FLOOR_STROOPS"),
    hardFloorStroops: positiveIntEnv(env.SPONSOR_HARD_FLOOR_STROOPS, 100_000_000, "SPONSOR_HARD_FLOOR_STROOPS"),
    intervalMs: positiveIntEnv(env.SPONSOR_BALANCE_INTERVAL_MS, 60_000, "SPONSOR_BALANCE_INTERVAL_MS"),
  };
  if (balance.hardFloorStroops <= spend.ceilingStroops) {
    const detail =
      `sponsor hard floor (${balance.hardFloorStroops} stroops) does not exceed the spend ceiling ` +
      `(${spend.ceilingStroops} stroops per window): the floor CANNOT HOLD — a single window can drain the ` +
      `sponsor through it before the next balance check. Raise SPONSOR_HARD_FLOOR_STROOPS above ` +
      `SPEND_CEILING_STROOPS, or lower the ceiling.`;
    // Fail CLOSED on pubnet, matching the spend policy itself. This is the one
    // misconfiguration that silently disables the sponsor's last protection, and
    // boot is the cheapest place to catch it — a warning on a free-tier instance
    // nobody is tailing is not a control.
    if (network === "stellar:pubnet") throw new Error(`[config] ${detail}`);
    console.warn(`[config] ${detail}`);
  }

  // Announce the escape hatch on EVERY boot while it is set, not only when it
  // is exercised. A quiet flag that silently downgrades a security control is
  // how "temporary" becomes permanent.
  // CATALOG_OWNERSHIP_BOOTSTRAP is GONE. It existed only because an ownership
  // FILE could be absent while a catalog FILE was present — indistinguishable
  // between "first upgrade" and "someone deleted it", so the migration had to be
  // opted into explicitly. A single database cannot be half-present, so the
  // ambiguity the hatch resolved no longer exists. If the variable is still set
  // anywhere, say so loudly rather than ignoring it: a stale escape hatch that
  // silently does nothing is how an operator ends up believing a migration ran.
  if (env.CATALOG_OWNERSHIP_BOOTSTRAP !== undefined) {
    console.warn(
      "[config] CATALOG_OWNERSHIP_BOOTSTRAP is set but NO LONGER EXISTS. Durable storage removed the " +
        "ambiguity it resolved (one database cannot be half-present). It is being IGNORED — remove it " +
        "from the environment so nobody reads it as still doing something.",
    );
  }
  if (env.CATALOG_FILE !== undefined) {
    console.warn(
      "[config] CATALOG_FILE is set but NO LONGER USED. The catalog is stored in libSQL/Turso — set " +
        "CATALOG_DB_URL (and CATALOG_DB_AUTH_TOKEN for a remote database) instead. The file is being " +
        "IGNORED, not migrated: there was never a durable catalog on the hosted instance to carry over, " +
        "and an importer would have to trust a file to name each resource's owner.",
    );
  }

  const bondEscrowContractId = parseBondEscrowContractId(env.BOND_ESCROW_CONTRACT_ID);
  const bondEscrowAdminSecretKey = parseBondEscrowAdminSecretKey(env.BOND_ESCROW_ADMIN_SECRET_KEY);
  // Half-configured bonding is a broken state, not a partial feature: register_settlement
  // cannot be called without both the contract to call and the key to sign with. Catching
  // this at boot, loudly, is cheaper than discovering it the first time a settlement tries
  // to register and silently can't — same "the operator set it on purpose, fail don't
  // degrade" posture as parseUptoContractId's own comment below.
  if ((bondEscrowContractId === undefined) !== (bondEscrowAdminSecretKey === undefined)) {
    throw new Error(
      "[config] BOND_ESCROW_CONTRACT_ID and BOND_ESCROW_ADMIN_SECRET_KEY must be set together or not " +
        "at all — one is set without the other, which would leave bonding half-enabled: a contract to " +
        "register settlements against with no key to sign the call, or a signing key with nothing to " +
        "call. Set both to enable bonding, or unset both to leave it off.",
    );
  }

  return {
    port: Number(env.PORT ?? 4100),
    host: env.HOST ?? "0.0.0.0",
    network,
    rpcUrl: env.STELLAR_RPC_URL,
    sponsorSecretKey,
    channelAccountSecretKeys,
    maxTransactionFeeStroops,
    uptoContractId: parseUptoContractId(env.UPTO_CONTRACT_ID),
    bondEscrowContractId,
    bondEscrowAdminSecretKey,
    catalogDbUrl: env.CATALOG_DB_URL,
    catalogDbAuthToken: env.CATALOG_DB_AUTH_TOKEN,
    verificationApiUrl: env.VERIFICATION_API_URL,
    spend,
    balance,
  };
}

/** A present-but-malformed contract ID must fail the boot, not silently
 *  disable the scheme it configures — the operator set it on purpose. */
function parseUptoContractId(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^C[A-Z2-7]{55}$/.test(raw)) {
    throw new Error(
      `[config] UPTO_CONTRACT_ID is set but is not a valid contract address (C…, 56 chars): ${raw}`,
    );
  }
  return raw;
}

/** Same shape as parseUptoContractId, same reasoning: fail the boot rather than silently
 *  leave bonding disabled when the operator plainly meant to turn it on. */
function parseBondEscrowContractId(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^C[A-Z2-7]{55}$/.test(raw)) {
    throw new Error(
      `[config] BOND_ESCROW_CONTRACT_ID is set but is not a valid contract address (C…, 56 chars): ${raw}`,
    );
  }
  return raw;
}

/** A Stellar classic secret key (S…, 56 chars). Deliberately validated by shape here,
 *  at config-parse time, rather than deferred to whenever bond.ts first calls
 *  Keypair.fromSecret on it — a malformed value should fail the boot immediately, the
 *  same standard the contract ID above is held to, not surface later as a confusing
 *  failure the first time a settlement tries to register. */
function parseBondEscrowAdminSecretKey(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^S[A-Z2-7]{55}$/.test(raw)) {
    throw new Error(
      "[config] BOND_ESCROW_ADMIN_SECRET_KEY is set but is not a valid Stellar secret key (S…, 56 chars)",
    );
  }
  return raw;
}

/** Exact channel-account pool size — see docs/channel-pool-design.md §2.
 *  Not 49, not 51: a silently-smaller pool loses the collision-free
 *  guarantee 50 true-simultaneous settlements were sized for, with no
 *  visible signal that it happened, so the count is enforced exactly
 *  rather than treated as a minimum. */
const CHANNEL_POOL_SIZE = 50;

/**
 * Parses CHANNEL_ACCOUNT_SECRET_KEYS: a comma-separated list of Stellar
 * classic secret keys (S…, 56 chars each — same shape
 * parseBondEscrowAdminSecretKey validates), one per channel account in the
 * settlement pool (docs/channel-pool-design.md).
 *
 * Three ways this fails the boot, loudly, rather than silently degrading —
 * same "the operator set it on purpose, a malformed or wrong-shaped value
 * fails immediately" posture as every other secret/ID parser in this file:
 *
 *   1. Missing entirely — required, unlike the optional contract IDs above.
 *      There is no "channel pool disabled" fallback: settling with a single
 *      shared signer under real concurrency is exactly the bug this pool
 *      exists to close (docs/channel-pool-design.md §1), so there is no
 *      safe default to fall back to.
 *   2. Wrong count — anything other than exactly CHANNEL_POOL_SIZE. Named
 *      explicitly in the error (actual vs. required), because "49 instead
 *      of 50" is the one misconfiguration that would otherwise look
 *      identical to a working pool right up until the 50th concurrent
 *      settlement collides with one of the other 49.
 *   3. Malformed key, or the sponsor's own key present in the list — the
 *      latter is checked here (not left to be discovered later) because
 *      the sponsor is excluded from the pool by design decision (§5): it
 *      may only ever be the fee-bump payer, never a settlement source
 *      account, and a misconfiguration that adds it to both lists would
 *      silently reintroduce the exact contention this pool removes it to
 *      avoid.
 */
function parseChannelAccountSecretKeys(raw: string | undefined, sponsorSecretKey: string): string[] {
  if (raw === undefined || raw === "") {
    throw new Error(
      `[config] CHANNEL_ACCOUNT_SECRET_KEYS is required: a comma-separated list of exactly ` +
        `${CHANNEL_POOL_SIZE} funded Stellar classic (S...) secrets, one per channel account in the ` +
        `settlement pool — see docs/channel-pool-design.md. There is no default: settling every ` +
        `payment from a single shared signer under concurrent load produces txBadSeq failures (§1).`,
    );
  }

  const keys = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  if (keys.length !== CHANNEL_POOL_SIZE) {
    throw new Error(
      `[config] CHANNEL_ACCOUNT_SECRET_KEYS must contain exactly ${CHANNEL_POOL_SIZE} keys, got ${keys.length}. ` +
        `The pool is sized for ${CHANNEL_POOL_SIZE} true-simultaneous settlements with zero sequence ` +
        `collisions (docs/channel-pool-design.md §2) — a smaller count silently loses that guarantee, ` +
        `and a larger count is rejected rather than trimmed, since an operator adding extra keys almost ` +
        `certainly meant something the pool is not sized to give them.`,
    );
  }

  const seen = new Set<string>();
  for (const key of keys) {
    if (!/^S[A-Z2-7]{55}$/.test(key)) {
      // SECURITY (found in review): never interpolate the raw value here —
      // a malformed key is still real (or near-real) secret material, and
      // this error is uncaught at boot, so it would otherwise land in
      // process/host logs. Same convention as parseBondEscrowAdminSecretKey
      // above, which validates the identical shape and never includes the
      // value either.
      throw new Error(
        "[config] CHANNEL_ACCOUNT_SECRET_KEYS contains a value that is not a valid Stellar secret key " +
          "(S…, 56 chars)",
      );
    }
    if (key === sponsorSecretKey) {
      throw new Error(
        "[config] CHANNEL_ACCOUNT_SECRET_KEYS contains SPONSOR_SECRET_KEY. The sponsor account is " +
          "deliberately excluded from the channel pool (docs/channel-pool-design.md §5) — it is reserved " +
          "for funding channel accounts and as the feeBumpSigner only, and must never also be a " +
          "settlement source account in the pool. Remove it from the list.",
      );
    }
    if (seen.has(key)) {
      throw new Error(
        "[config] CHANNEL_ACCOUNT_SECRET_KEYS contains a duplicate key. Each of the " +
          `${CHANNEL_POOL_SIZE} channel accounts must be distinct — a duplicate silently shrinks the ` +
          "pool below its configured size, the exact failure mode the exact-count check above exists to catch.",
      );
    }
    seen.add(key);
  }

  return keys;
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
