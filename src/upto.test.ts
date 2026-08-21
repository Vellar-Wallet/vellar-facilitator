import { describe, expect, it } from "vitest";
import {
  Account,
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { UptoStellarScheme, type UptoRpcLike } from "./upto.js";

// The upto scheme's validation layer — every check that runs BEFORE a network
// call, exercised without one. The live path (simulate → sign → submit →
// confirm) is proven by the deployment record (docs/upto-deployment.md, tx
// 72c816a6…, actual 400000 under a 1000000 ceiling); these tests pin the
// gate in front of it: what the facilitator refuses, and why, by reason code.

const CONTRACT = "CDHPA64M73TUTEM4MMHIWIXINBQXH7JJXFGZMGH22VJWFJFROMR6QV2S";
const OTHER_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PASSPHRASE = "Test SDF Network ; September 2015";

const payerKp = Keypair.random();
const PAYER = payerKp.publicKey();
const PAYTO = Keypair.random().publicKey();
const SPONSOR_SECRET = Keypair.random().secret();

function scheme(server?: Partial<UptoRpcLike>): UptoStellarScheme {
  return new UptoStellarScheme(
    {
      contractId: CONTRACT,
      sponsorSecretKey: SPONSOR_SECRET,
      network: "stellar:testnet",
      maxTransactionFeeStroops: 500_000,
    },
    { server: server as UptoRpcLike },
  );
}

interface TxOverrides {
  contract?: string;
  fn?: string;
  args?: xdr.ScVal[];
  hook?: xdr.ScVal;
  auth?: boolean;
  token?: string;
  payTo?: string;
  max?: bigint;
}

/** A structurally valid client transaction, offline. `auth` defaults to one
 *  dummy (unsigned) entry — parseAndValidate checks presence, not signatures;
 *  signatures are the RPC's enforcing simulation's job. */
function clientTx(o: TxOverrides = {}): string {
  const args = o.args ?? [
    nativeToScVal(o.token ?? ASSET, { type: "address" }),
    nativeToScVal(PAYER, { type: "address" }),
    nativeToScVal(o.payTo ?? PAYTO, { type: "address" }),
    nativeToScVal(o.max ?? 1_000_000n, { type: "i128" }),
    nativeToScVal(12345, { type: "u32" }),
    nativeToScVal(Buffer.alloc(32, 7), { type: "bytes" }),
    nativeToScVal(1_000_000n, { type: "i128" }),
    o.hook ?? xdr.ScVal.scvVoid(),
  ];
  const ic = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(o.contract ?? CONTRACT).toScAddress(),
    functionName: o.fn ?? "settle",
    args,
  });
  const dummyAuth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(ic),
      subInvocations: [],
    }),
  });
  return new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
    fee: "1000",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(ic),
        auth: o.auth === false ? [] : [dummyAuth],
      }),
    )
    .setTimeout(60)
    .build()
    .toXDR();
}

function payload(tx: string): PaymentPayload {
  return { x402Version: 2, accepted: reqs(), payload: { transaction: tx } } as PaymentPayload;
}

function reqs(extra: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme: "upto",
    network: "stellar:testnet",
    asset: ASSET,
    amount: "1000000",
    payTo: PAYTO,
    maxTimeoutSeconds: 120,
    extra,
  } as PaymentRequirements;
}

describe("upto parseAndValidate — the gate in front of the network", () => {
  it("accepts a well-formed authorization and extracts payer and ceiling", () => {
    const r = scheme().parseAndValidate(payload(clientTx()), reqs());
    expect(typeof r).not.toBe("string");
    if (typeof r !== "string") {
      expect(r.payer).toBe(PAYER);
      expect(r.max).toBe(1_000_000n);
      expect(r.auth).toHaveLength(1);
    }
  });

  it.each([
    ["missing transaction", { payload: {} }, "invalid_upto_stellar_payload_transaction_missing"],
    [
      "malformed transaction",
      { payload: { transaction: "not-xdr" } },
      "invalid_upto_stellar_payload_transaction_malformed",
    ],
  ] as const)("%s", (_n, pl, reason) => {
    const p = { x402Version: 2, accepted: reqs(), ...pl } as unknown as PaymentPayload;
    expect(scheme().parseAndValidate(p, reqs())).toBe(reason);
  });

  it("refuses an invocation of any other contract", () => {
    expect(scheme().parseAndValidate(payload(clientTx({ contract: OTHER_CONTRACT })), reqs())).toBe(
      "invalid_upto_stellar_wrong_contract",
    );
  });

  it("refuses any function other than settle", () => {
    expect(scheme().parseAndValidate(payload(clientTx({ fn: "is_used" })), reqs())).toBe(
      "invalid_upto_stellar_wrong_function",
    );
  });

  it("refuses a non-void hook — the hostile-callee surface is refused, not defended", () => {
    const hooked = clientTx({ hook: nativeToScVal(OTHER_CONTRACT, { type: "address" }) });
    expect(scheme().parseAndValidate(payload(hooked), reqs())).toBe(
      "invalid_upto_stellar_hook_not_supported",
    );
  });

  it.each([
    ["asset", { token: OTHER_CONTRACT.replace("C", "C") }, "invalid_upto_stellar_asset_mismatch"],
    ["payTo", { payTo: Keypair.random().publicKey() }, "invalid_upto_stellar_payto_mismatch"],
    ["ceiling", { max: 999_999n }, "invalid_upto_stellar_ceiling_mismatch"],
  ] as const)("refuses a %s that disagrees with the requirements", (_n, o, reason) => {
    const withAsset =
      "token" in o ? clientTx({ token: "CDHPA64M73TUTEM4MMHIWIXINBQXH7JJXFGZMGH22VJWFJFROMR6QV2S" }) : clientTx(o);
    expect(scheme().parseAndValidate(payload(withAsset), reqs())).toBe(reason);
  });

  it("refuses a transaction carrying no authorization entries", () => {
    expect(scheme().parseAndValidate(payload(clientTx({ auth: false })), reqs())).toBe(
      "invalid_upto_stellar_no_authorization",
    );
  });
});

describe("upto verify — simulation failures surface as reasons, not throws", () => {
  it("maps a simulation error to an invalidReason with the payer identified", async () => {
    const fake: Partial<UptoRpcLike> = {
      getAccount: async () => new Account(Keypair.random().publicKey(), "0"),
      simulateTransaction: async () =>
        ({ error: "HostError: Error(Auth, InvalidAction)", events: [], id: "1", latestLedger: 1 }) as never,
    };
    const v = await scheme(fake).verify(payload(clientTx()), reqs());
    expect(v.isValid).toBe(false);
    expect(v.invalidReason).toContain("invalid_upto_stellar_simulation_failed");
    expect(v.payer).toBe(PAYER);
  });
});

describe("upto settle — the actual amount is bounded before anything is spent", () => {
  const noNetwork = {} as UptoRpcLike; // must never be reached in these cases

  it("refuses actual > ceiling", async () => {
    const s = await scheme(noNetwork).settle(payload(clientTx()), reqs({ actualAmount: "1000001" }));
    expect(s.success).toBe(false);
    expect(s.errorReason).toBe("invalid_upto_stellar_actual_exceeds_ceiling");
  });

  it("refuses a negative actual", async () => {
    const s = await scheme(noNetwork).settle(payload(clientTx()), reqs({ actualAmount: "-1" }));
    expect(s.success).toBe(false);
    expect(s.errorReason).toBe("invalid_upto_stellar_actual_amount_negative");
  });

  it("refuses a malformed actual", async () => {
    const s = await scheme(noNetwork).settle(payload(clientTx()), reqs({ actualAmount: "4e5" }));
    expect(s.success).toBe(false);
    expect(s.errorReason).toBe("invalid_upto_stellar_actual_amount_malformed");
  });
});

describe("upto supported-surface", () => {
  it("advertises the contract and sponsorship, and the sponsor as signer", () => {
    const s = scheme();
    expect(s.scheme).toBe("upto");
    expect(s.caipFamily).toBe("stellar:*");
    expect(s.getExtra("stellar:testnet")).toEqual({
      uptoContract: CONTRACT,
      areFeesSponsored: true,
    });
    expect(s.getSigners("stellar:testnet")).toEqual([
      Keypair.fromSecret(SPONSOR_SECRET).publicKey(),
    ]);
  });
});
