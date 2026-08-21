// Provider bond escrow wiring for Stellar — calls OUR deployed bond-escrow contract, built
// from original source (contracts/bond-escrow/, deployment record in
// docs/bond-escrow-deployment.md), unlike upto.ts's vendored settlement contract.
//
// This file wires ONE entry point so far: register_settlement. The design document
// (docs/proposal-provider-bond.md, Section 6) locks that registration must be synchronous,
// awaited, and admin-gated — the only thing that ever gives a payer standing to dispute a
// bond, so a forged registration is a direct path to fabricated slashes. Every other entry
// point (deposit, withdraw, file_dispute, set_delivery_key, post_receipt, finalize) is
// deliberately out of scope here; they're independently callable by sellers/payers per the
// design doc's own reasoning and don't need this facilitator to mediate them.
//
// ## The admin key signs this, never the sponsor key — structurally, not just by convention
//
// registerSettlement takes `adminSecretKey`, not `sponsorSecretKey`. There is no code path in
// this file that reads config.sponsorSecretKey at all — the two keys are different fields on
// FacilitatorConfig (src/config.ts), validated independently, and this function's options type
// only has a slot for one of them. A caller cannot pass the sponsor key in by accident the way
// a same-named or same-typed parameter might invite; the field is literally called
// `adminSecretKey` and there is nothing named `sponsorSecretKey` anywhere in this module for a
// slip to reach for. See contracts/bond-escrow/src/lib.rs, initialize's doc-comment ("Which
// key: a dedicated admin key, not the facilitator's payment sponsor key") for the full
// reasoning: compromising this key lets an attacker forge dispute standing and drain bonded
// funds — a different blast radius than compromising the payment-sponsor key — and the two
// must be rotatable independently, which means never being the same secret to begin with.
//
// ## Why this call is simpler than upto.ts's settle flow
//
// upto's settle relays a BUYER's pre-signed SorobanAuthorizationEntry while the SPONSOR pays
// the fee as a separate party — two different identities, so the auth entry has to be
// extracted from the buyer's transaction and forwarded explicitly. register_settlement has
// only one party: the admin authorizes AND pays its own fee, as the transaction's source
// account. Soroban's own rule for `require_auth()` on the transaction's source account is
// satisfied by the classic transaction signature alone — no separate SorobanAuthorizationEntry
// needs to be constructed or attached, confirmed empirically: this is exactly how
// `stellar contract invoke --source <admin> -- register_settlement ...` worked without any
// manual auth-entry handling during this contract's live testnet exercises
// (docs/bond-escrow-deployment.md). One consequence worth being explicit about: the admin key
// needs its own small XLM balance to pay register_settlement's fees — it is not fee-sponsored
// by the payment sponsor. That is a deliberate cost of keeping the two identities genuinely
// independent, not an oversight.
//
// ## Distinguishing "couldn't complete the call" from "the contract said no"
//
// A caller (src/bazaar.ts, wired in a later pass) needs to know which happened, because the
// recovery path differs: an infrastructure failure is plausibly transient and retry-worthy; a
// contract-level rejection means something is genuinely wrong (a payment_id collision, a
// negative amount slipping through upstream validation, the contract not yet initialized) and
// an operator needs to see it, not have it silently retried. The split follows directly from
// how Soroban actually reports these two cases to the SDK:
//   - A THROWN exception anywhere in the RPC round-trip (network unreachable, malformed
//     response, submission failure, confirmation timeout) — the RPC never gave us a considered
//     answer about the contract's logic. Reported as `infrastructure_error`.
//   - `rpc.Api.isSimulationError(sim)` returning true — the RPC successfully ran the actual
//     contract code and it trapped (a `Result::Err` from register_settlement, or an auth
//     failure). This is caught at SIMULATION time, before anything is ever submitted, so a
//     rejection here costs nothing on-ledger. Reported as `rejected`, with the contract's own
//     error code parsed out of the message when it matches Soroban's stable
//     `Error(Contract, #N)` formatting (the same format observed directly, repeatedly, via the
//     `stellar` CLI against this exact contract during its live testnet exercises).
//   - A transaction that simulates successfully but then fails on submission/confirmation is
//     treated as `infrastructure_error` too, not `rejected` — by the time simulation already
//     succeeded, a subsequent on-ledger failure means something changed between simulate and
//     submit (a race, a transient node issue), which is a different, less certain situation
//     than a deterministic business-rule rejection. This is a deliberate simplification, stated
//     here rather than left implicit: it will occasionally misclassify a genuine late-breaking
//     rejection (e.g. a race against a second registration for the same payment_id) as
//     infrastructure. If that turns out to matter in practice, it needs its own pass to parse
//     `getTransaction`'s FAILED result for a contract error the same way simulation errors are
//     parsed below — not attempted here to keep this file's first version bounded.

import {
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

const PASSPHRASES: Record<string, string> = {
  "stellar:testnet": "Test SDF Network ; September 2015",
  "stellar:pubnet": "Public Global Stellar Network ; September 2015",
};

const DEFAULT_RPC: Record<string, string> = {
  "stellar:testnet": "https://soroban-testnet.stellar.org",
  "stellar:pubnet": "https://mainnet.sorobanrpc.com",
};

/** Only the codes register_settlement can actually return, per
 *  contracts/bond-escrow/src/lib.rs's Error enum (AlreadyInitialized=1,
 *  NotInitialized=2, SettlementAlreadyRegistered=3, InvalidAmount=4 — the rest of the
 *  21-variant enum belongs to other entry points this file doesn't call). Deliberately NOT
 *  a full duplicate of the Rust enum: keeping this list scoped to what this one call can
 *  reach avoids two enums that need to stay in lockstep for codes this function can never
 *  see. An unrecognized code (wrong contract deployed, a future contract version) falls
 *  back to a generic "unknown contract error #N" rather than silently mislabeling it. */
const REGISTER_SETTLEMENT_CONTRACT_ERRORS: Record<number, string> = {
  2: "NotInitialized",
  3: "SettlementAlreadyRegistered",
  4: "InvalidAmount",
};

export interface BondEscrowOptions {
  /** Our deployed bond-escrow contract (C…). See docs/bond-escrow-deployment.md. */
  contractId: string;
  /** The dedicated admin key — NEVER config.sponsorSecretKey. See the header comment. */
  adminSecretKey: string;
  network: "stellar:testnet" | "stellar:pubnet";
  rpcUrl?: string | undefined;
  /** Reused from config.maxTransactionFeeStroops rather than a new dedicated ceiling — a
   *  deliberate choice, not an oversight: register_settlement's resource cost (storage
   *  writes only, no token transfer) is a strict subset of what that ceiling was already
   *  sized to clear, so a second knob for a smaller number would be complexity without a
   *  need it currently serves. Revisit if that stops being true. */
  maxTransactionFeeStroops: number;
}

export interface RegisterSettlementParams {
  /** 32 bytes, hex-encoded (64 hex chars). A Stellar transaction hash is already exactly
   *  32 bytes and already unique per settlement, making it a natural, ready-made source —
   *  the specific derivation is the calling site's decision (a later pass), not this
   *  function's; it only requires the shape. */
  paymentId: string;
  /** The verified payer's G… address. */
  payer: string;
  /** The listing's seller G… address. */
  seller: string;
  /** The canonical resource key as a plain string (e.g.
   *  BazaarCatalog.canonicalResourceKey's output) — UTF-8 encoded here, NOT pre-hashed.
   *  The contract hashes it on-ledger itself; see contracts/bond-escrow/src/lib.rs's
   *  "Resource-key encoding" section for why. */
  resourceKey: string;
  /** Settled amount, atomic units. Must be a positive integer as a string or bigint —
   *  the contract itself rejects <= 0 (InvalidAmount), but malformed input (not an
   *  integer at all) is this function's own caller's bug and throws synchronously rather
   *  than being reported as a `rejected` outcome, which is reserved for the contract
   *  actually running and saying no. */
  amount: string | bigint;
}

export type RegisterSettlementResult =
  | { outcome: "registered"; transaction: string }
  | {
      outcome: "rejected";
      /** Human-readable detail — either a recognized contract error name or the raw
       *  (truncated) simulation error string when the code isn't one of the three above. */
      detail: string;
      /** The numeric Soroban contract error code, when the failure was parseable as
       *  `Error(Contract, #N)`. Absent for an auth-shaped trap or an unparseable message. */
      contractErrorCode?: number;
    }
  | { outcome: "infrastructure_error"; detail: string };

/** TEST SEAM — same shape and purpose as upto.ts's UptoRpcLike: the network touchpoints,
 *  injectable so this function is testable without a real RPC. */
export interface BondEscrowRpcLike {
  getAccount(address: string): Promise<ConstructorParameters<typeof TransactionBuilder>[0]>;
  simulateTransaction(tx: unknown): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: unknown): Promise<{ status: string; hash: string }>;
  getTransaction(hash: string): Promise<{ status: string }>;
}

/** Soroban's own stable error-message formatting for a contract-level trap, observed
 *  directly and repeatedly against this exact contract via the `stellar` CLI during its
 *  live testnet exercises (docs/bond-escrow-deployment.md) — e.g. "Error(Contract, #8)". */
const CONTRACT_ERROR_PATTERN = /Error\(Contract, #(\d+)\)/;

function parseContractError(rawMessage: string): { code: number; name: string } | undefined {
  const match = CONTRACT_ERROR_PATTERN.exec(rawMessage);
  if (!match || !match[1]) return undefined;
  const code = Number(match[1]);
  return { code, name: REGISTER_SETTLEMENT_CONTRACT_ERRORS[code] ?? `unknown contract error #${code}` };
}

/** Register a settlement with the bond-escrow contract, giving its payer standing to later
 *  file a dispute. Synchronous by design — the caller (src/bazaar.ts, a later pass) awaits
 *  this before treating a settlement as fully complete. See the header comment for the full
 *  reasoning on the admin/sponsor key split and the rejected/infrastructure_error split. */
export async function registerSettlement(
  opts: BondEscrowOptions,
  params: RegisterSettlementParams,
  deps?: { server?: BondEscrowRpcLike },
): Promise<RegisterSettlementResult> {
  // Caller-bug validation — thrown synchronously, not reported as `rejected` or
  // `infrastructure_error`, both of which are reserved for the call actually reaching the
  // network. A malformed paymentId or address here means src/bazaar.ts's wiring is broken,
  // not that anything happened on-chain.
  const paymentIdBytes = Buffer.from(params.paymentId, "hex");
  if (paymentIdBytes.length !== 32) {
    throw new Error(
      `[bond] paymentId must be 32 bytes (64 hex chars), got ${paymentIdBytes.length} bytes: ${params.paymentId}`,
    );
  }
  let payerAddress: Address, sellerAddress: Address, contractAddress: Address;
  try {
    payerAddress = Address.fromString(params.payer);
    sellerAddress = Address.fromString(params.seller);
    contractAddress = Address.fromString(opts.contractId);
  } catch (err) {
    throw new Error(`[bond] payer, seller, or contractId is not a valid Stellar address: ${err}`);
  }
  const amount = BigInt(params.amount);
  if (amount <= 0n) {
    throw new Error(`[bond] amount must be a positive integer, got ${params.amount}`);
  }
  if (params.resourceKey.length === 0) {
    throw new Error("[bond] resourceKey must not be empty");
  }

  const admin = Keypair.fromSecret(opts.adminSecretKey);
  const passphrase = PASSPHRASES[opts.network]!;
  const server =
    deps?.server ?? (new rpc.Server(opts.rpcUrl ?? DEFAULT_RPC[opts.network]!) as unknown as BondEscrowRpcLike);

  const args = [
    nativeToScVal(paymentIdBytes, { type: "bytes" }),
    nativeToScVal(payerAddress.toString(), { type: "address" }),
    nativeToScVal(sellerAddress.toString(), { type: "address" }),
    nativeToScVal(Buffer.from(params.resourceKey, "utf8"), { type: "bytes" }),
    nativeToScVal(amount, { type: "i128" }),
  ];
  const ic = new xdr.InvokeContractArgs({
    contractAddress: contractAddress.toScAddress(),
    functionName: "register_settlement",
    args,
  });

  try {
    // Admin is the source account, so its require_auth() is satisfied by the transaction's
    // own signature — no separate SorobanAuthorizationEntry to construct. See the header
    // comment.
    const account = await server.getAccount(admin.publicKey());
    const tx = new TransactionBuilder(account, { fee: "1000", networkPassphrase: passphrase })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(ic),
          auth: [],
        }),
      )
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      const parsed = parseContractError(sim.error);
      return parsed
        ? { outcome: "rejected", detail: parsed.name, contractErrorCode: parsed.code }
        : { outcome: "rejected", detail: sim.error.slice(0, 200) };
    }

    const assembled = rpc
      .assembleTransaction(tx, sim as rpc.Api.SimulateTransactionSuccessResponse)
      .build();
    if (Number(assembled.fee) > opts.maxTransactionFeeStroops) {
      return { outcome: "infrastructure_error", detail: "fee_exceeds_maximum" };
    }

    assembled.sign(admin);
    const sent = await server.sendTransaction(assembled);
    if (sent.status !== "PENDING") {
      return { outcome: "infrastructure_error", detail: `submission_failed: status ${sent.status}` };
    }
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const got = await server.getTransaction(sent.hash);
      if (got.status === "SUCCESS") return { outcome: "registered", transaction: sent.hash };
      if (got.status === "FAILED")
        return { outcome: "infrastructure_error", detail: `transaction_failed_post_simulation: ${sent.hash}` };
    }
    return { outcome: "infrastructure_error", detail: `confirmation_timeout: ${sent.hash}` };
  } catch (err) {
    return { outcome: "infrastructure_error", detail: `${err instanceof Error ? err.message : err}` };
  }
}
