# upto-vellar Contract Deployment

## Contract

| Field | Value |
|-------|-------|
| Contract ID | `CDLSHRYCP543HUKCGYGQHT2BSXUG2BVEZLCUHZVYV2O7XOTF6UTUH5OI` |
| Wasm hash | `62ae27cf3bd07a1c144fbcd887dd9edcffd7ac4852544c1ce735ff8f2f5692a8` |
| Network | `stellar:testnet` |
| Deployed | 2026-09-09 |
| Deployer | `GA47SADPR4XBBEOJR3WOOZOXT7SEUXGYRMO66PXOINPILE3TFSZDZPKT` |
| Deployment tx | [`c08a072d…`](https://stellar.expert/explorer/testnet/tx/c08a072d1736e130279ae06b17d639472bd7fe368a34fd480499dcdc3b2b5e3d) |

Deployment is **two** transactions, and both are recorded because the wasm hash
this document asserts is established by the first, not the second:

| Step | Tx | Ledger | Fee charged |
|---|---|---|---|
| Upload wasm | [`a96e2a38…`](https://stellar.expert/explorer/testnet/tx/a96e2a3834555936aa1f2d4879b1676f44a63589e53178835445ca8a5b7ada50) | 4587142 | 2,665,382 stroops |
| Create contract | [`c08a072d…`](https://stellar.expert/explorer/testnet/tx/c08a072d1736e130279ae06b17d639472bd7fe368a34fd480499dcdc3b2b5e3d) | 4587143 | 19,484 stroops |

Both `successful: true`, Horizon-confirmed, 2026-09-09T13:08Z.

**On the deployer.** This is a dedicated one-time keypair, deliberately **not**
the facilitator's payment sponsor
(`GBUCR6H22CZC5OYHBJIEUS2JFZBOB63AHEGTCV6UEPMD2TMLKG2ZMIW4`). Contract
deployment history stays distinct from payment sponsorship, the same separation
the original `upto` contract used (deployed from `GBOC2UOB…`, see
[`upto-deployment.md`](./upto-deployment.md)). The sponsor's balance is the
hosted service's availability; it should not also appear in permanent chain
history as a contract deployer.

The deployer key was generated and written directly to a mode-600 file under
`.e2e-local/` (gitignored) in a single step, so it never passed through a shell
argument or a transcript. It has no continuing role: the contract has no admin,
no owner and no upgrade path (`DESIGN.md` SR-3), so this account holds **no
privilege whatsoever** over the deployed contract. Nothing is lost if the key is
discarded.

## Reproduce the wasm hash

```bash
cd contracts/upto-vellar
stellar contract build
shasum -a 256 target/wasm32v1-none/release/x402_upto_vellar.wasm
# expect 62ae27cf3bd07a1c144fbcd887dd9edcffd7ac4852544c1ce735ff8f2f5692a8
```

Toolchain: `rustc 1.96.0` / `stellar-cli 26.1.0` / `wasm32v1-none`.
Built size: 3,936 bytes (4,238 before optimization).

Reproducibility is not claimed beyond this toolchain. A different rustc or
stellar-cli version may produce a different hash; that is a property of the
build, not evidence of tampering. The verification below is what actually ties
this repository to the bytes the chain runs.

## Verify against on-chain bytes

```bash
stellar contract fetch \
  --id CDLSHRYCP543HUKCGYGQHT2BSXUG2BVEZLCUHZVYV2O7XOTF6UTUH5OI \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  --out-file fetched.wasm

shasum -a 256 fetched.wasm
# must match the hash above
```

**Verified 2026-09-09.** The fetched bytes, the locally built artifact, and the
hash recorded in this document are all
`62ae27cf3bd07a1c144fbcd887dd9edcffd7ac4852544c1ce735ff8f2f5692a8`. This does
not rest on the CLI's own report of what it uploaded: the bytes were fetched
back from the network and hashed independently.

The deployed contract exports exactly two functions, `settle` and `is_used`,
which is `DESIGN.md` FR-1 confirmed by the build rather than by inspection.

## Design

Written from [`contracts/upto-vellar/DESIGN.md`](../contracts/upto-vellar/DESIGN.md),
committed (`f95e099`) **before** the implementation (`109a063`). See that file
for the full requirements and the reasoning behind each decision, including the
open questions that were resolved before any Rust was written.

Key differences from the vendored reference in
[`contracts/upto-stellar/`](../contracts/upto-stellar/):

- **No `hook` argument in the ABI.** The facilitator refuses it anyway; omitting
  it is better than accepting and ignoring it.
- **Explicit settlement event** reporting both `ceiling` and `actual`, so an
  indexer can classify by event rather than by invocation shape, and can see the
  authorized headroom that went unspent.
- **Nonce TTL set to `expiration_ledger` with no buffer.** FR-5 refuses any
  settlement past expiry regardless of nonce state, so retaining the record past
  that point would pay state rent to defend an unreachable attack.
- **Negative `actual_amount` rejected explicitly.** A negative value satisfies
  `actual <= max` trivially, and SEP-41 tokens are not uniformly required to
  reject it.
- **Direct `transfer`, not `approve` + `transfer_from`.** The transfer is atomic
  within the invocation that already carries the buyer's authorization.
- **Nonce keyed on `(from, nonce)`**, so two payers drawing the same random
  nonce is a collision rather than a lockout.
- **15 tests**, including balance assertions on every rejection path (TR-14) and
  a zero-balance assertion on the contract itself (TR-15).

### On the test suite

The suite was mutation-tested against four deliberate defects. Three were caught
immediately. The fourth was not: deleting the negative-amount check left TR-11
green, because the token also rejects a negative transfer and both rejections
revert the invocation identically. TR-11 now asserts the contract's own panic
message, so the check itself is the subject under test rather than the token's
behaviour. This is recorded because a suite that passes against a broken
contract is worse than no suite.

## Status

**Deployed, not integrated.** The facilitator's `UPTO_CONTRACT_ID` still points
at the original vendored contract
(`CDHPA64M73TUTEM4MMHIWIXINBQXH7JJXFGZMGH22VJWFJFROMR6QV2S`). This contract has
not settled a live payment, and switching to it is a separate decision that
needs an end-to-end settlement against it first. Nothing in this document should
be read as saying it is in production use.
