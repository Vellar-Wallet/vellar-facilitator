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
  catalogOwnershipBootstrap: boolean;
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

  const network = env.STELLAR_NETWORK === "pubnet" ? "stellar:pubnet" : "stellar:testnet";

  // Raised well above @x402/stellar's 50_000 default: policy-governed
  // smart-account payments run the policy contract inside __check_auth, which
  // pushes the simulation-derived fee to ~130k stroops. Rejecting those was the
  // exact hosted-facilitator bug that motivated this project — so this ceiling
  // must never dip toward 50k.
  //
  // Sized from MEASURED testnet data rather than guessed: across the dedicated
  // facilitator sponsor's settlement history the worst real settlement charged
  // 127,808 stroops (higher-fee transactions on shared dev accounts are contract
  // deploys and add_signer calls, which never reach /settle). 500,000 clears that
  // by ~3.9x and stays 2.5x above the documented 200k floor, while cutting the
  // worst-case sponsor drain per settle from 0.2 XLM to 0.05 XLM. Raise via
  // MAX_TX_FEE_STROOPS if a heavier policy ever legitimately exceeds it — the
  // failure is loud (fee_exceeds_maximum), not silent.
  const maxTransactionFeeStroops = Number(env.MAX_TX_FEE_STROOPS ?? 500_000);
  if (!Number.isInteger(maxTransactionFeeStroops) || maxTransactionFeeStroops <= 0) {
    throw new Error(`MAX_TX_FEE_STROOPS must be a positive integer, got: ${env.MAX_TX_FEE_STROOPS}`);
  }

  const spend = {
    rateWindowMs: positiveIntEnv(env.SETTLE_RATE_WINDOW_MS, 60_000, "SETTLE_RATE_WINDOW_MS"),
    // 50,000,000 stroops = 5 XLM per window. At the 500,000-stroop worst-case
    // fee that is 100 settlements per window across ALL merchants, and
    // perPayToMax (50) is deliberately half of it.
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
  const catalogOwnershipBootstrap = /^(1|true)$/i.test(env.CATALOG_OWNERSHIP_BOOTSTRAP ?? "");
  if (catalogOwnershipBootstrap) {
    console.warn(
      "[config] CATALOG_OWNERSHIP_BOOTSTRAP is SET. On boot, if the catalog file exists without its " +
        "companion ownership store, ownership bindings will be DERIVED FROM THAT CATALOG FILE. " +
        "It grants no more trust than that file already had — if an attacker wrote the file, they " +
        "choose the owners. This exists only to migrate a pre-existing catalog once; REMOVE IT " +
        "immediately afterwards. While it is set, the fail-closed protection against a missing or " +
        "deleted ownership store is DISABLED.",
    );
  }

  return {
    port: Number(env.PORT ?? 4100),
    catalogOwnershipBootstrap,
    host: env.HOST ?? "0.0.0.0",
    network,
    rpcUrl: env.STELLAR_RPC_URL,
    sponsorSecretKey,
    maxTransactionFeeStroops,
    catalogFile: env.CATALOG_FILE,
    verificationApiUrl: env.VERIFICATION_API_URL,
    spend,
    balance,
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
