import { Account, Address, Keypair, Operation, StrKey, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { TrustedDiscoveryResource } from "./trust.js";

// Live payability check (BUILD-PLAN item 2): for each accepts entry, does its
// payTo currently hold a trustline for the priced asset? Ownership answers "is
// this listing theirs"; this answers "can they be paid right now" — a buyer is
// warned before a settlement that would fail on-chain for a reason that has
// nothing to do with who owns the listing.
//
// Three-valued, same discipline as trust.ts's TrustVerification: a Horizon or
// RPC failure degrades to "unknown", NEVER "not_payable" — a check this
// deployment could not perform must never read as a proven negative.
//
// THE CORE PROBLEM THIS SOLVES. `asset` in PaymentRequirements is always a
// Stellar Asset Contract (SAC) id — a C... address — never a raw classic
// asset. Horizon's trustline data (GET /accounts/{id}) is keyed by classic
// (asset_code, asset_issuer), not by SAC contract id, and this facilitator
// maintains no asset allowlist (docs/asset-support.md) to reverse-map a
// handful of known SACs back to their classic identity. The resolution: every
// SAC exposes a read-only SEP-41 `name()` that returns "CODE:ISSUER" (or the
// literal string "native" for the native-asset SAC) — confirmed live against
// testnet USDC and the native SAC before this file was written. A non-SAC
// custom contract has no `name()` function at all and traps simulation
// distinctly (confirmed against contracts/upto-vellar's deployed testnet
// instance), which is what lets the "non-SAC token" case degrade to
// "unknown" rather than being silently misclassified as a classic asset.

export type Payability = "payable" | "not_payable" | "unknown";

export interface PayabilityResolver {
  /** Payability verdict for one (payTo, asset) pair. Cached. */
  check(payTo: string, asset: string): Promise<Payability>;
}

/** Documented limits, exported so their rationale is assertable — see
 *  src/config.thresholds.test.ts. Read-only. */
export const PAYABILITY_LIMITS = Object.freeze({
  /** How long a payable/not_payable verdict is reused. Deliberately its own
   *  constant, not TRUST_LIMITS.defaultCacheTtlMs — trustline/authorization
   *  changes are a slower-moving, rarer merchant action than a verification
   *  API re-run, and the two values must be free to diverge without one
   *  edit accidentally moving both. */
  defaultCacheTtlMs: 5 * 60_000,
  /**
   * How long an "unknown" verdict is reused. Short, and a SEPARATE constant
   * from defaultCacheTtlMs: "unknown" means THIS deployment's check failed
   * (a timeout, a transient Horizon error), not that the merchant's
   * trustline state is itself uncertain for 5 minutes. Caching a failure for
   * as long as a real answer would turn one bad Horizon call into five
   * minutes of withholding a signal that may already be available again.
   */
  unknownCacheTtlMs: 30_000,
});

export interface PayabilityResolverOptions {
  /** Soroban RPC, for simulating the SAC's name() read. */
  rpcUrl: string;
  /** Horizon, for reading a classic account's trustlines. */
  horizonUrl: string;
  /** Required for the simulated name() call — matters for real submission to
   *  a real RPC endpoint, unlike the parse-only XDR check elsewhere in this
   *  codebase where any passphrase value works. Callers already have this
   *  (see upto.ts's own PASSPHRASES map); not re-derived here to avoid a
   *  third copy of the same network->passphrase table. */
  networkPassphrase: string;
  cacheTtlMs?: number;
  unknownCacheTtlMs?: number;
  /** Injected for tests. */
  fetchFn?: typeof fetch;
  rpcServer?: Pick<rpc.Server, "simulateTransaction">;
}

/** A SAC's resolved classic identity. The first three kinds are cached
 *  PERMANENTLY, never evicted or TTL'd: once deployed, a SAC's underlying
 *  asset cannot change — this is a structural fact about the contract, not
 *  live state that can go stale. `transient_error` is deliberately NOT one
 *  of those facts — it means the simulation itself could not be completed
 *  (RPC timeout/network blip), not that the contract definitively lacks a
 *  `name()` function, so it must never be cached: doing so would permanently
 *  misclassify a legitimate SAC as non-SAC forever after one bad RPC call,
 *  with no way to recover short of a restart. */
type ClassicIdentity =
  | { kind: "native" }
  | { kind: "classic"; code: string; issuer: string }
  | { kind: "non_sac" }
  | { kind: "transient_error" };

/** A syntactically valid but arbitrary Stellar account, used only as the
 *  simulation's source. Never submitted, never funded, never signed — a
 *  read-only simulateTransaction only needs a valid account ID SHAPE for the
 *  tx envelope, not a real ledger entry. Fixed rather than regenerated per
 *  call so repeated simulations don't pay random-keypair generation cost for
 *  no benefit. */
const SIMULATION_SOURCE = Keypair.random().publicKey();

/**
 * Resolve a SAC contract id to its classic asset identity via a read-only
 * `name()` simulation. Never throws.
 *
 * Two distinct failure shapes, deliberately not collapsed — see
 * ClassicIdentity's own doc comment for why this distinction is load-bearing
 * for the permanent cache above it:
 *  - the RPC call itself fails to complete (network error, timeout) ->
 *    `transient_error`, never cached by the caller.
 *  - the RPC call completes and the contract definitively has no `name()`
 *    (or returns something not shaped like a SEP-41 name) -> `non_sac`,
 *    safe to cache forever — this contract will never grow a `name()`
 *    function later.
 */
async function resolveClassicIdentity(
  contractId: string,
  rpcServer: Pick<rpc.Server, "simulateTransaction">,
  networkPassphrase: string,
): Promise<ClassicIdentity> {
  let sim: Awaited<ReturnType<rpc.Server["simulateTransaction"]>>;
  try {
    const source = new Account(SIMULATION_SOURCE, "0");
    const ic = new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(contractId).toScAddress(),
      functionName: "name",
      args: [],
    });
    const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(ic),
          auth: [],
        }),
      )
      .setTimeout(30)
      .build();
    sim = await rpcServer.simulateTransaction(tx);
  } catch {
    // The call itself could not be completed — RPC down, timeout, bad
    // contractId shape that throws before ever reaching the network. NOT a
    // fact about the contract.
    return { kind: "transient_error" };
  }

  // Reached this point: the RPC answered. Everything below is a fact ABOUT
  // THE CONTRACT — a definitive, cacheable-forever answer, even when that
  // answer is "no name() function" (isSimulationError / malformed retval).
  if (rpc.Api.isSimulationError(sim)) return { kind: "non_sac" };
  const retval = sim.result?.retval;
  if (!retval) return { kind: "non_sac" };
  const value = scValToNative(retval);
  if (typeof value !== "string") return { kind: "non_sac" };
  if (value === "native") return { kind: "native" };
  const colon = value.indexOf(":");
  if (colon <= 0) return { kind: "non_sac" };
  const code = value.slice(0, colon);
  const issuer = value.slice(colon + 1);
  if (!StrKey.isValidEd25519PublicKey(issuer)) return { kind: "non_sac" };
  return { kind: "classic", code, issuer };
}

export function createPayabilityResolver(options: PayabilityResolverOptions): PayabilityResolver {
  const cacheTtlMs = options.cacheTtlMs ?? PAYABILITY_LIMITS.defaultCacheTtlMs;
  const unknownCacheTtlMs = options.unknownCacheTtlMs ?? PAYABILITY_LIMITS.unknownCacheTtlMs;
  const fetchFn = options.fetchFn ?? fetch;
  const rpcServer = options.rpcServer ?? new rpc.Server(options.rpcUrl);

  // Permanent — see ClassicIdentity's own doc comment for why no TTL applies.
  const identityCache = new Map<string, ClassicIdentity>();
  // TTL'd — trustline/authorization state is live and can change.
  const verdictCache = new Map<string, { verdict: Payability; at: number }>();

  async function classicIdentityFor(asset: string): Promise<ClassicIdentity> {
    const cached = identityCache.get(asset);
    if (cached) return cached;
    const identity = await resolveClassicIdentity(asset, rpcServer, options.networkPassphrase);
    // transient_error is deliberately NOT cached — see ClassicIdentity's doc
    // comment. Every other kind is a structural fact about the contract
    // (does it expose name(), and what does it say), safe to cache forever.
    if (identity.kind !== "transient_error") identityCache.set(asset, identity);
    return identity;
  }

  async function horizonTrustlineAuthorized(
    payTo: string,
    code: string,
    issuer: string,
  ): Promise<Payability> {
    try {
      const res = await fetchFn(`${options.horizonUrl}/accounts/${payTo}`);
      if (res.status === 404) return "unknown"; // account never funded — not a proof of anything
      if (!res.ok) return "unknown";
      const body = (await res.json()) as {
        balances?: Array<{
          asset_type?: string;
          asset_code?: string;
          asset_issuer?: string;
          is_authorized?: boolean;
        }>;
      };
      const line = body.balances?.find((b) => b.asset_code === code && b.asset_issuer === issuer);
      if (!line) return "not_payable";
      return line.is_authorized ? "payable" : "not_payable";
    } catch {
      return "unknown";
    }
  }

  async function horizonAccountExists(payTo: string): Promise<Payability> {
    try {
      const res = await fetchFn(`${options.horizonUrl}/accounts/${payTo}`);
      if (res.status === 404) return "unknown"; // not proof the address can never be funded
      if (!res.ok) return "unknown";
      return "payable"; // native XLM balance is always present on an existing account
    } catch {
      return "unknown";
    }
  }

  async function resolve(payTo: string, asset: string): Promise<Payability> {
    const identity = await classicIdentityFor(asset);

    if (identity.kind === "non_sac" || identity.kind === "transient_error") return "unknown";

    // A contract address holding the asset needs no classic trustline,
    // regardless of whether the asset is native or a classic-asset SAC.
    if (StrKey.isValidContract(payTo)) return "payable";

    if (!StrKey.isValidEd25519PublicKey(payTo)) return "unknown"; // not a shape this check understands

    if (identity.kind === "native") return horizonAccountExists(payTo);
    return horizonTrustlineAuthorized(payTo, identity.code, identity.issuer);
  }

  return {
    async check(payTo, asset) {
      const key = `${payTo}\u0000${asset}`;
      const cached = verdictCache.get(key);
      if (cached) {
        const ttl = cached.verdict === "unknown" ? unknownCacheTtlMs : cacheTtlMs;
        if (Date.now() - cached.at < ttl) return cached.verdict;
      }
      const verdict = await resolve(payTo, asset);
      verdictCache.set(key, { verdict, at: Date.now() });
      return verdict;
    },
  };
}

/**
 * Annotate PER accepts entry, index-aligned — same shape as trust.ts's
 * annotateTrust. Payability is independent of the ownership/verification
 * trust layer: a listing can be fully owner-verified and still have a
 * not_payable accepts option (the merchant removed a trustline), and vice
 * versa, so this never clamps against or reads ownerVerified.
 */
export async function annotatePayability(
  items: TrustedDiscoveryResource[],
  resolver: PayabilityResolver,
): Promise<TrustedDiscoveryResource[]> {
  return Promise.all(
    items.map(async (item) => {
      const acceptsPayability = await Promise.all(
        item.accepts.map((a) => (a.payTo ? resolver.check(a.payTo, a.asset) : Promise.resolve<Payability>("unknown"))),
      );
      // Explicit field-by-field, same discipline as trust.ts's own
      // annotateTrust — NOT a blind `...item.trust` spread. This runs either
      // standalone (trust layer disabled) or after annotateTrust already
      // populated every other field; either way, listing each field here
      // (rather than trusting the type to carry an invariant it cannot
      // express) is what keeps this correct under exactOptionalPropertyTypes
      // without depending on call-order knowledge the type checker can't see.
      return {
        ...item,
        trust: {
          settlements: item.trust?.settlements ?? 0,
          uniquePayers: item.trust?.uniquePayers ?? 0,
          ...(item.trust?.lastSettled ? { lastSettled: item.trust.lastSettled } : {}),
          ...(item.trust?.verification !== undefined ? { verification: item.trust.verification } : {}),
          ...(item.trust?.acceptsVerification !== undefined
            ? { acceptsVerification: item.trust.acceptsVerification }
            : {}),
          ...(item.trust?.ownerVerified !== undefined ? { ownerVerified: item.trust.ownerVerified } : {}),
          ...(item.trust?.ownershipState !== undefined ? { ownershipState: item.trust.ownershipState } : {}),
          ...(item.trust?.observedSettlements !== undefined
            ? { observedSettlements: item.trust.observedSettlements }
            : {}),
          ...(item.trust?.statsSource !== undefined ? { statsSource: item.trust.statsSource } : {}),
          acceptsPayability,
        },
      };
    }),
  );
}

/**
 * payable_only: prune NOT_PAYABLE accepts entries, keep payable and unknown
 * ones visible with their verdict, drop the whole listing only if nothing
 * remains. Never silently promotes "unknown" to either side — an unknown
 * option is kept, not hidden and not assumed payable, because this check has
 * no deployment-level "unavailable" state to refuse against the way
 * verified_only does (Horizon/RPC endpoints are always derived from
 * config.network — there is no unconfigured case): "unknown" here means one
 * specific (payTo, asset) lookup failed, not that payability cannot be asked
 * about at all.
 */
export function filterPayableOnly(items: TrustedDiscoveryResource[]): TrustedDiscoveryResource[] {
  return items
    .map((item) => {
      const existingTrust = item.trust;
      const verdicts = existingTrust?.acceptsPayability;
      if (!existingTrust || !verdicts) return item;
      const keptIndices = item.accepts
        .map((_, i) => i)
        .filter((i) => verdicts[i] !== "not_payable");
      // existingTrust is narrowed non-undefined above, and already known to
      // satisfy TrustedDiscoveryResource["trust"] — only acceptsPayability
      // actually changes, so mutate a shallow copy of exactly that field
      // rather than re-deriving a fresh literal from the spread, which is
      // what trips exactOptionalPropertyTypes into re-checking every other
      // field's optionality from scratch.
      const trust: NonNullable<TrustedDiscoveryResource["trust"]> = { ...existingTrust };
      trust.acceptsPayability = keptIndices.map((i) => verdicts[i]!);
      return {
        ...item,
        accepts: keptIndices.map((i) => item.accepts[i]!),
        trust,
      };
    })
    .filter((item) => item.accepts.length > 0);
}
