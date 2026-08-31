// `upto` scheme facilitator for Stellar — verify/settle against OUR deployed
// settlement contract, built from pinned source (contracts/upto-stellar/,
// provenance in PROVENANCE.md, deployment record in docs/upto-deployment.md).
//
// The scheme: the buyer authorizes a CEILING — `require_auth_for_args` over
// (token, to, max_amount, expiration_ledger, nonce), deliberately excluding
// `actual_amount` — and the facilitator supplies the actual metered charge at
// settlement. The contract enforces `0 <= actual <= max` ON-LEDGER, so even a
// compromised facilitator cannot charge past the signed ceiling. Replay is
// dual-layer: the Soroban host's per-entry auth nonce plus the contract's own
// (payer, nonce) record, TTL-bounded so an authorization can never outlive the
// record that makes it single-use.
//
// Wire shape mirrors exact-stellar: `payload.payload.transaction` is a base64,
// UNSIGNED transaction envelope whose single operation invokes our contract's
// `settle` with the buyer's SIGNED auth entries attached. The facilitator
// never relays it: the op's args and auth are extracted, `actual_amount`
// (arg 6 — outside the signed tuple, so the signature stays valid) is set to
// the settle-time actual, and the transaction is REBUILT from the sponsor
// account — the buyer holds no XLM and pays no fee, same as exact.
//
// Two deliberate positions, both from the cross-implementation contract review
// (2026-08-21):
//   - The settlement HOOK is refused (`hook` must be None). It sits outside
//     the signed tuple, making it a hostile-callee surface aimed at the
//     sponsor (a panicking/CPU-burning hook reverts a settle after transfer or
//     burns sponsored fees). Nothing we run needs it; refusing is cheaper than
//     defending.
//   - `verify` simulates at the CEILING, not the eventual actual. That is the
//     question verify can actually answer before metering ("could the full
//     authorization settle?") and it is deliberately conservative: a buyer
//     holding less than max but more than the eventual actual fails verify
//     even though the settle might have succeeded.
//
// EXPERIMENTAL: the upstream wire format for upto-on-Stellar is still in
// review (x402-foundation/x402 PR #3134). This implementation is pinned to our
// deployed contract's ABI and will track the spec as it lands.

import {
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements, Network } from "@x402/core/types";

const PASSPHRASES: Record<string, string> = {
  "stellar:testnet": "Test SDF Network ; September 2015",
  "stellar:pubnet": "Public Global Stellar Network ; September 2015",
};

const DEFAULT_RPC: Record<string, string> = {
  "stellar:testnet": "https://soroban-testnet.stellar.org",
  "stellar:pubnet": "https://mainnet.sorobanrpc.com",
};

/** Argument order of the contract's `settle`, per contracts/upto-stellar/src/lib.rs. */
const ARG = { token: 0, from: 1, to: 2, max: 3, expiration: 4, nonce: 5, actual: 6, hook: 7 } as const;
const SETTLE_ARG_COUNT = 8;

export interface UptoSchemeOptions {
  /** Our deployed settlement contract (C…). See docs/upto-deployment.md. */
  contractId: string;
  sponsorSecretKey: string;
  network: "stellar:testnet" | "stellar:pubnet";
  rpcUrl?: string | undefined;
  maxTransactionFeeStroops: number;
}

interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

interface SettleResult {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: Network;
  amount?: string;
}

/** What `parseAndValidate` extracts from the client's transaction. Everything
 *  here has been checked against the payment requirements. */
interface ParsedSettle {
  auth: xdr.SorobanAuthorizationEntry[];
  args: xdr.ScVal[];
  payer: string;
  max: bigint;
}

/** TEST SEAM — the two network touchpoints, injectable so validation logic is
 *  testable without an RPC. Production uses the real server (which also means
 *  submissions flow through rpcstatus.ts's capture + retry, installed on the
 *  Server prototype at boot). */
export interface UptoRpcLike {
  getAccount(address: string): Promise<ConstructorParameters<typeof TransactionBuilder>[0]>;
  simulateTransaction(tx: unknown): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: unknown): Promise<{ status: string; hash: string }>;
  getTransaction(hash: string): Promise<{ status: string }>;
}

export class UptoStellarScheme {
  readonly scheme = "upto";
  readonly caipFamily = "stellar:*";

  private readonly contractId: string;
  private readonly sponsor: Keypair;
  private readonly network: "stellar:testnet" | "stellar:pubnet";
  private readonly passphrase: string;
  private readonly maxFee: number;
  private readonly server: UptoRpcLike;

  constructor(opts: UptoSchemeOptions, deps?: { server?: UptoRpcLike }) {
    this.contractId = opts.contractId;
    this.sponsor = Keypair.fromSecret(opts.sponsorSecretKey);
    this.network = opts.network;
    this.passphrase = PASSPHRASES[opts.network]!;
    this.maxFee = opts.maxTransactionFeeStroops;
    this.server =
      deps?.server ??
      (new rpc.Server(opts.rpcUrl ?? DEFAULT_RPC[opts.network]!) as unknown as UptoRpcLike);
  }

  getExtra(_network: Network): Record<string, unknown> {
    return { uptoContract: this.contractId, areFeesSponsored: true };
  }

  getSigners(_network: string): string[] {
    return [this.sponsor.publicKey()];
  }

  /** Every structural/requirements check, BEFORE any network call — and the
   *  reason every rejection carries. Returns a string reason on failure. */
  parseAndValidate(payload: PaymentPayload, requirements: PaymentRequirements): ParsedSettle | string {
    const txB64 = (payload.payload as { transaction?: unknown })?.transaction;
    if (typeof txB64 !== "string" || txB64.length === 0)
      return "invalid_upto_stellar_payload_transaction_missing";

    let tx;
    try {
      tx = TransactionBuilder.fromXDR(txB64, this.passphrase);
    } catch {
      return "invalid_upto_stellar_payload_transaction_malformed";
    }
    if (!("operations" in tx) || tx.operations.length !== 1)
      return "invalid_upto_stellar_payload_operation_count";
    const op = tx.operations[0] as Operation.InvokeHostFunction;
    if (op.type !== "invokeHostFunction")
      return "invalid_upto_stellar_payload_not_invoke_host_function";

    const fn = op.func;
    if (fn.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract())
      return "invalid_upto_stellar_payload_not_contract_invocation";
    const ic = fn.invokeContract();

    if (Address.fromScAddress(ic.contractAddress()).toString() !== this.contractId)
      return "invalid_upto_stellar_wrong_contract";
    if (ic.functionName().toString() !== "settle")
      return "invalid_upto_stellar_wrong_function";
    const args = ic.args();
    if (args.length !== SETTLE_ARG_COUNT)
      return "invalid_upto_stellar_wrong_argument_count";

    // The hook is refused, not defended — see the header.
    if (args[ARG.hook]!.switch() !== xdr.ScValType.scvVoid())
      return "invalid_upto_stellar_hook_not_supported";

    let token: string, payer: string, to: string, max: bigint;
    try {
      token = Address.fromScAddress(args[ARG.token]!.address()).toString();
      payer = Address.fromScAddress(args[ARG.from]!.address()).toString();
      to = Address.fromScAddress(args[ARG.to]!.address()).toString();
      max = scValToNative(args[ARG.max]!) as bigint;
    } catch {
      return "invalid_upto_stellar_arguments_malformed";
    }

    if (token !== requirements.asset) return "invalid_upto_stellar_asset_mismatch";
    if (to !== requirements.payTo) return "invalid_upto_stellar_payto_mismatch";
    if (max !== BigInt(requirements.amount)) return "invalid_upto_stellar_ceiling_mismatch";

    const auth = (op.auth ?? []) as xdr.SorobanAuthorizationEntry[];
    if (auth.length === 0) return "invalid_upto_stellar_no_authorization";

    return { auth, args: [...args], payer, max };
  }

  /** The settle-time actual: `requirements.extra.actualAmount` when the seller
   *  metered less than the ceiling, else the full ceiling. */
  private actualFor(requirements: PaymentRequirements, max: bigint): bigint | string {
    const raw = (requirements.extra as { actualAmount?: unknown })?.actualAmount;
    let actual: bigint;
    try {
      actual = raw === undefined ? max : BigInt(raw as string);
    } catch {
      return "invalid_upto_stellar_actual_amount_malformed";
    }
    if (actual < 0n) return "invalid_upto_stellar_actual_amount_negative";
    if (actual > max) return "invalid_upto_stellar_actual_exceeds_ceiling";
    return actual;
  }

  /** Rebuild from the sponsor with `actual` in arg 6, then simulate. */
  private async buildAndSimulate(parsed: ParsedSettle, actual: bigint) {
    const args = [...parsed.args];
    args[ARG.actual] = nativeToScVal(actual, { type: "i128" });
    const ic = new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(this.contractId).toScAddress(),
      functionName: "settle",
      args,
    });
    // KNOWN LIMITATION: this call shares the sponsor account's sequence
    // number with any concurrent upto settlement. Multiple concurrent upto
    // settlements can produce txBadSeq. Tracked for a follow-up pool
    // extension — see docs/channel-pool-design.md §8.
    const account = await this.server.getAccount(this.sponsor.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: "1000",
      networkPassphrase: this.passphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(ic),
          auth: parsed.auth,
        }),
      )
      .setTimeout(60)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      return { error: `simulation_failed: ${sim.error.slice(0, 200)}` };
    }
    const assembled = rpc.assembleTransaction(tx, sim as rpc.Api.SimulateTransactionSuccessResponse).build();
    if (Number(assembled.fee) > this.maxFee) {
      return { error: "fee_exceeds_maximum" };
    }
    return { assembled };
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult> {
    const parsed = this.parseAndValidate(payload, requirements);
    if (typeof parsed === "string") return { isValid: false, invalidReason: parsed };
    // Verify at the CEILING — the question answerable before metering.
    const built = await this.buildAndSimulate(parsed, parsed.max);
    if ("error" in built)
      return { isValid: false, invalidReason: `invalid_upto_stellar_${built.error}`, payer: parsed.payer };
    return { isValid: true, payer: parsed.payer };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResult> {
    const fail = (errorReason: string, transaction = ""): SettleResult => ({
      success: false,
      errorReason,
      transaction,
      network: this.network,
    });
    const parsed = this.parseAndValidate(payload, requirements);
    if (typeof parsed === "string") return fail(parsed);
    const actual = this.actualFor(requirements, parsed.max);
    if (typeof actual === "string") return fail(actual);

    const built = await this.buildAndSimulate(parsed, actual);
    if ("error" in built) return fail(`settle_upto_stellar_${built.error}`);

    built.assembled.sign(this.sponsor);
    const sent = await this.server.sendTransaction(built.assembled);
    if (sent.status !== "PENDING") {
      // rpcstatus.ts's capture (installed on the Server prototype) has already
      // recorded the real status and retried TRY_AGAIN_LATER before this point.
      return fail("settle_upto_stellar_transaction_submission_failed");
    }
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const got = await this.server.getTransaction(sent.hash);
      if (got.status === "SUCCESS")
        return {
          success: true,
          transaction: sent.hash,
          network: this.network,
          payer: parsed.payer,
          amount: actual.toString(),
        };
      if (got.status === "FAILED")
        return fail("settle_upto_stellar_transaction_failed", sent.hash);
    }
    return fail("settle_upto_stellar_confirmation_timeout", sent.hash);
  }
}
