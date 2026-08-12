# Upstream issue — DRAFT, NOT FILED

**Target:** `x402-foundation/x402` (the repo `@x402/stellar` points at).
**Confirmed against:** `@x402/stellar@2.22.0` — the latest published release,
verified by unpacking the tarball, not just our pinned 2.20.0. The signing block
is byte-identical in both.
**Status:** reproduced live on testnet against a real deployed smart account,
not inferred from reading the source. Stack trace under
[Reproduction](#reproduction).

**Not opened.** It goes out under the repo owner's name, so it is here to be read
first — same handling as
[`upstream-issue-draft.md`](./upstream-issue-draft.md) (filed as
[#3125](https://github.com/x402-foundation/x402/issues/3125)).

**Why this one matters more than #3125.** #3125 makes a failure mode legible.
This one makes an entire payer class impossible. Soroban smart accounts —
policy-governed agents, passkey wallets — are the case x402 on Stellar is most
often pitched for, and the official client cannot sign for any of them.

---

## Title

`exact/stellar`: the client scheme cannot pay from a Soroban smart account —
`signAuthEntries` forces an ed25519 signature shape

## Body

### Summary

`ExactStellarScheme` (client) signs the payer's auth entry through
`AssembledTransaction.signAuthEntries`, which narrows any signer's result to a
naked signature buffer. A naked buffer routes `authorizeEntry` down its ed25519
branch, which treats the auth entry's own address as an ed25519 public key. For a
custom account contract that address is a `C…` contract id, so the call throws
before a payment can be produced.

The SDK has a documented escape hatch for exactly this case —
`authorizeEntry`'s signer may return `{ signatureScVal }`, described in its own
JSDoc as being "for custom account contracts (smart wallets, passkey/WebAuthn
signers, etc.) whose `__check_auth` expects a signature structure" of its own.
`signAuthEntries` does not expose it, and the x402 client scheme does not pass
the `authorizeEntry` override that would.

Net effect: `@x402/stellar` advertises Stellar payer support, but only classic
`G…` keypairs can actually pay.

### Where

`src/exact/client/scheme.ts` (published build,
`dist/cjs/exact/client/index.js:194-198` of 2.22.0):

```js
await tx.signAuthEntries({
  address: sourcePublicKey,
  signAuthEntry: this.signer.signAuthEntry,
  expiration: maxLedger
});
```

`signAuthEntries` accepts a fourth option, `authorizeEntry`, and it is not passed.

### The chain

Against `@stellar/stellar-sdk@16.2.0`:

1. `AssembledTransaction.signAuthEntries`
   (`lib/cjs/contract/assembled_transaction.js:615`) wraps the caller's
   `signAuthEntry` and returns **a naked buffer** at line 670:

   ```js
   return buffer.Buffer.from(signedAuthEntry, "base64");
   ```

2. `authorizeEntry` (`lib/cjs/base/auth.js`) checks for `signatureScVal` first.
   A naked buffer misses it and falls to the ed25519 branch, which derives the
   signer's public key from the entry's own credentials address (line 52) and
   verifies against it (line 58):

   ```js
   publicKey = address.Address.fromScAddress(addrAuth.address()).toString();
   ...
   if (!keypair.Keypair.fromPublicKey(publicKey).verify(payload, signature)) {
   ```

3. For a smart account that address is a `C…` contract id:

   ```
   Keypair.fromPublicKey("C…") → Error: invalid version byte. expected 48, got 16
   ```

The type layer suggests this should work — `isClientStellarSigner` accepts
`{ address, signAuthEntry }` with `signTransaction` optional, which is exactly the
shape a smart-account signer has. The runtime path does not.

### Reproduction

Run live on testnet against a **real deployed smart account** funded with the
payment asset (2026-08-12). Not a constructed mock: the only unusual property of
the signer is that its `address` is a `C…` contract id, which is what a smart
account is.

```js
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const signer = {
  address: "CBOTN25T3HPF6UKAYX5EO7BE3HGGLPNMV4GEWV75PRL6I7NFDHQSQD3Q", // smart account
  signAuthEntry: async () => ({ signedAuthEntry: Buffer.alloc(64).toString("base64") }),
};

const scheme = new ExactStellarScheme(signer, { url: "https://soroban-testnet.stellar.org" });
await scheme.createPaymentPayload(2, {
  scheme: "exact",
  network: "stellar:testnet",
  amount: "1000000",
  asset: "CACDPE626YV7HGDGAMFETFJK2P5SOEYFYIN5IC5I2HBDTLG42R7KX6UB",
  payTo: "GC6NI7Z2UNXIGC5ULVQ7P6K765GRC6EF7NT2FAZ2EU3WU46EFTNHWAQO",
  maxTimeoutSeconds: 120,
  extra: { areFeesSponsored: true },
});
```

Result:

```
Error: invalid version byte. expected 48, got 16
    at decodeCheck (@stellar/stellar-sdk/lib/esm/base/strkey.js:349:11)
    at StrKey.decodeEd25519PublicKey (@stellar/stellar-sdk/lib/esm/base/strkey.js:58:12)
    at Keypair.fromPublicKey (@stellar/stellar-sdk/lib/esm/base/keypair.js:83:36)
    at authorizeEntry (@stellar/stellar-sdk/lib/esm/base/auth.js:56:18)
    at async AssembledTransaction.signAuthEntries (…/contract/assembled_transaction.js:658:24)
    at async ExactStellarScheme.createPaymentPayload (@x402/stellar/dist/esm/chunk-SOJRTSRS.mjs:77:5)
```

**Note where it does not fail.** Simulation succeeded — the account is funded and
the transfer assembles cleanly. Execution reaches `authorizeEntry` and dies
purely on signature shaping, so this is not a funding, trustline or
configuration problem.

Executed against `@x402/stellar@2.20.0` with `@stellar/stellar-sdk@16.2.0`. The
signing block in `2.22.0` is byte-identical, verified by unpacking the published
tarball, so the same failure applies to the latest release.

### Proposed fix

Thread an optional `authorizeEntry` through the client scheme and forward it.
`signAuthEntries` already accepts the parameter, so this is a pass-through — no
`@stellar/stellar-sdk` change required:

```js
constructor(signer, rpcConfig, options = {}) {
  this.authorizeEntry = options.authorizeEntry;   // optional
  …
}

await tx.signAuthEntries({
  address: sourcePublicKey,
  signAuthEntry: this.signer.signAuthEntry,
  expiration: maxLedger,
  ...(this.authorizeEntry ? { authorizeEntry: this.authorizeEntry } : {}),
});
```

A caller with a smart account then supplies an `authorizeEntry` that returns
`{ signatureScVal }` in whatever shape its `__check_auth` expects. Classic
keypairs are unaffected — the default path is unchanged when the option is
omitted.

An alternative that avoids a constructor argument is to let
`ClientStellarSigner.signAuthEntry` optionally return `{ signatureScVal }` and
have the scheme detect it, but that requires `signAuthEntries` in the SDK to stop
narrowing to a buffer, which is the larger change across two repos.

### Reference implementation

`examples/buyer.mjs` in
[Vellar-Wallet/vellar-facilitator](https://github.com/Vellar-Wallet/vellar-facilitator)
is a working smart-account payer against a live facilitator, written against the
raw SDK precisely because the client scheme cannot express it. It signs a
policy-governed Vellar smart account with an ed25519 session key; the settlement
hashes are in `docs/decisions.md`. Its sibling `examples/buyer-classic.mjs` is
~12 lines on the official client, which is the gap this issue is about.
