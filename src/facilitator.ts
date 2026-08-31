import { AsyncLocalStorage } from "node:async_hooks";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { createEd25519Signer } from "@x402/stellar";
import type { FacilitatorConfig } from "./config.js";
import { UptoStellarScheme } from "./upto.js";
import { ChannelPool, isPoolExhaustedError } from "./channelPool.js";

/**
 * buildFacilitator's result now carries the channel pool alongside the
 * facilitator itself (docs/channel-pool-design.md §3/§7) — the server.ts
 * call site that wraps a settle() call needs `pool.release(...)` in a
 * `finally`, which means it needs a reference to the SAME pool instance
 * `selectSigner` below acquires from, not a second, disconnected one.
 */
export interface BuiltFacilitator {
  facilitator: x402Facilitator;
  pool: ChannelPool;
}

/**
 * REAL BUG, FOUND UNDER LOAD (docs/channel-pool-design.md §9's own actual
 * Run 2 execution — 25 of 50 settlements failed with pool_exhausted at only
 * 50 real concurrent requests against a 50-account pool, exactly half
 * capacity): `selectSigner` below is called SYNCHRONOUSLY, INSIDE
 * `ExactStellarScheme.settle()` itself
 * (.../facilitator/index.js:280) — it is the ONLY real acquisition point.
 * An earlier version of this file's own caller (src/server.ts) additionally
 * called `pool.acquire()` a second time, itself, to have an address on hand
 * for `pool.release()` in its own `finally` — meaning every single /settle
 * call consumed TWO pool slots (one via selectSigner, doing the real
 * signing; one via the caller's own separate, unused acquisition), silently
 * halving real capacity. Fixed structurally, not by removing the caller's
 * safety net: `withChannelAcquisitionCapture` below scopes an
 * AsyncLocalStorage slot per settle() call (same mechanism, same reasoning,
 * as src/rpcstatus.ts's own withRpcStatusCapture — a module-level "last
 * acquired address" variable would race exactly like the sequence
 * contention this pool exists to prevent, since two concurrent settle()
 * calls' selectSigner invocations could interleave from the CALLER's own
 * perspective even though each individual selectSigner() call itself is
 * atomic). `selectSigner` records the address it actually acquired into
 * THIS scope; the caller reads it back out, still inside the same scope,
 * immediately after `settle()` resolves — there is now exactly one
 * acquisition per settle() call, not two.
 */
const channelAcquisitionStore = new AsyncLocalStorage<{ acquiredAddress?: string; poolExhausted?: boolean }>();

/**
 * Runs `fn` (a call to `facilitator.settle(...)`) with a fresh capture slot,
 * returning its value, the channel address `selectSigner` actually acquired
 * during that call (`undefined` if `fn` never reached `selectSigner` at
 * all — e.g. verification failed first, so there is nothing to release),
 * and whether `selectSigner` hit a genuinely exhausted pool.
 *
 * The `poolExhausted` flag exists because `ExactStellarScheme.settle()`
 * (the vendored library, not this file) wraps its ENTIRE body in a
 * try/catch that swallows whatever `selectSigner` throws and replaces it
 * with the single generic `errorReason: "unexpected_settle_error"` —
 * confirmed by reading its source
 * (.../facilitator/index.js: `catch (error) { console.error(...); return
 * {..., errorReason: "unexpected_settle_error"} }`). Without recording the
 * REAL cause here, in this same scope, before the vendored catch ever runs,
 * a pool_exhausted condition is indistinguishable from any other unexpected
 * throw by the time `settle()` returns — exactly the same "the library
 * discards the one piece of information a caller needs" problem
 * src/rpcstatus.ts already exists to solve for RPC status, solved here the
 * same way.
 */
export async function withChannelAcquisitionCapture<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; acquiredAddress: string | undefined; poolExhausted: boolean }> {
  return channelAcquisitionStore.run({}, async () => {
    const value = await fn();
    const slot = channelAcquisitionStore.getStore();
    return { value, acquiredAddress: slot?.acquiredAddress, poolExhausted: slot?.poolExhausted ?? false };
  });
}

export function buildFacilitator(config: FacilitatorConfig): BuiltFacilitator {
  const sponsorSigner = createEd25519Signer(config.sponsorSecretKey, config.network);

  // Channel-account pool (docs/channel-pool-design.md §1/§2/§5): one signer
  // per channel account, built the same way the sponsor signer already is
  // (createEd25519Signer takes the secret directly — it derives the Keypair
  // and address internally, see @x402/stellar's own createEd25519Signer).
  // The pool is seeded from `channelSigners.map(s => s.address)` — the exact
  // same array `channelSigners` itself came from — so the pool's managed
  // addresses and `signerMap`'s keys (built by ExactStellarScheme's own
  // constructor from this same `channelSigners` array, see below) can never
  // drift out of sync: there is structurally only one source array, not two
  // lists that happen to agree today.
  const channelSigners = config.channelAccountSecretKeys.map((secret) =>
    createEd25519Signer(secret, config.network),
  );
  const pool = new ChannelPool(channelSigners.map((s) => s.address));

  // §5, locked and enforced HERE structurally, not just by convention:
  // sponsorSigner is passed ONLY as feeBumpSigner below — it is never an
  // element of channelSigners, so it can never appear in signerMap and can
  // never be returned by selectSigner. It funds the channel accounts and
  // pays every settlement's network fee (§4/§6); it is never itself a
  // settlement source account.
  const scheme = new ExactStellarScheme(channelSigners, {
    maxTransactionFeeStroops: config.maxTransactionFeeStroops,
    feeBumpSigner: sponsorSigner,
    // §3: acquire() is synchronous and returns the acquired address
    // directly — exactly the shape selectSigner's own interface requires
    // ((addrs: string[]) => string). Confirmed against the vendored source
    // (node_modules/@x402/stellar/dist/cjs/exact/facilitator/index.js:280,
    // 290) that this returned address is what signerMap.get(...) resolves
    // back to a signer with, and signer.address is exactly what reaches
    // server.getAccount(...) three lines later — no other indirection
    // between what selectSigner returns and which account's sequence
    // number settle() actually consumes.
    //
    // THE ONLY acquisition point (see the load-bug comment above) — records
    // the acquired address into the current AsyncLocalStorage scope (if
    // one is active; a call outside withChannelAcquisitionCapture, e.g. a
    // test constructing the scheme directly, still works exactly as before,
    // it just has nowhere to record the address for later release).
    selectSigner: () => {
      let address: string;
      try {
        address = pool.acquire();
      } catch (err) {
        // Record the REAL cause before it disappears into the vendored
        // library's own generic catch (see withChannelAcquisitionCapture's
        // own doc comment) — then re-throw, since selectSigner's interface
        // has no other way to signal failure to its caller.
        if (isPoolExhaustedError(err)) {
          const slot = channelAcquisitionStore.getStore();
          if (slot) slot.poolExhausted = true;
        }
        throw err;
      }
      const slot = channelAcquisitionStore.getStore();
      if (slot) slot.acquiredAddress = address;
      return address;
    },
    ...(config.rpcUrl ? { rpcConfig: { url: config.rpcUrl } } : {}),
  });

  const facilitator = new x402Facilitator().register(config.network, scheme);

  // `upto` is opt-in by contract ID: unset means exact-only, which is every
  // deployment that predates the scheme. The contract is OUR build from pinned
  // source (contracts/upto-stellar/PROVENANCE.md) — never a third party's
  // deployed instance whose wasm hash we have not verified.
  //
  // NOT wired into the channel pool — this scheme still calls getAccount()
  // directly on the sponsor's own key (src/upto.ts:219, KNOWN LIMITATION
  // comment there), a gap this step does not close. See
  // docs/channel-pool-design.md §8.
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

  return { facilitator, pool };
}
