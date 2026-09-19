import { Account, Asset, Memo, Networks, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

/**
 * A structurally VALID transaction envelope, fixed (not a fresh Keypair
 * per call): /settle shreds unparseable XDR at the route before ever
 * reaching facilitator.settle, so tests that need to reach the balance
 * guard / spend policy / cataloging need real XDR, but its content is
 * otherwise irrelevant to what most of them assert.
 */
export const VALID_TX_XDR =
  "AAAAAgAAAAARUqIOOVQYwBn0s32MhGQwyoTHPy7SzjfXdweAw6b/4gAAAGQAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAABqdyAuAAAAAAAAAAEAAAAAAAAAAQAAAADrmp8rY1JU7CL78HNaROud45MqVmrrbxOCVuWSEz0eRwAAAAAAAAAAAJiWgAAAAAAAAAAA";

// VALID_TX_XDR is a plain Transaction (not a fee bump) — this cast is safe
// for this one known-shape fixture; fromXDR's real return type is the
// Transaction | FeeBumpTransaction union, which is why it's needed at all.
const BASE_TX = TransactionBuilder.fromXDR(VALID_TX_XDR, Networks.TESTNET) as Transaction;

/**
 * /settle dedupes by the settled transaction's own hash (2026-09-19
 * idempotency guard, src/server.ts's settleDedup — a duplicate signed
 * envelope awaits the FIRST call's result instead of independently
 * re-running the pipeline). VALID_TX_XDR above is one fixed, static
 * envelope, so any test that fires several /settle calls and expects EACH
 * to be treated as an independent attempt (as opposed to a test of the
 * dedup guard itself) must give each call its own distinct envelope —
 * reusing VALID_TX_XDR across them now correctly collapses them into one
 * dedup entry, which is real guard behavior working as intended, but
 * defeats a test that assumed every call reaches the pipeline fresh.
 *
 * Rebuilt from VALID_TX_XDR's own decoded shape (same source/sequence/fee/
 * destination/amount) with only a distinct memo — enough to change the
 * transaction hash without a second hand-crafted base XDR to maintain.
 */
export function distinctValidTxXdr(seed: number): string {
  const account = new Account(BASE_TX.source, (BigInt(BASE_TX.sequence) - 1n).toString());
  const op = BASE_TX.operations[0] as { destination: string; amount: string };
  return new TransactionBuilder(account, {
    fee: BASE_TX.fee,
    networkPassphrase: Networks.TESTNET,
    memo: Memo.text(`dedup-test-${seed}`),
  })
    .addOperation(Operation.payment({ destination: op.destination, asset: Asset.native(), amount: op.amount }))
    .setTimeout(30)
    .build()
    .toXDR();
}
