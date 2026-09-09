# upto-vellar Contract Deployment

## Contract

| Field | Value |
|-------|-------|
| Contract ID | `CCZL7CTRS6GWEYXDYD54DZM3OUHQW2S2A4KSU75SH275P3SFZLL4YQAN` |
| Wasm hash | `92365d9e5effe046a1db5b959bd2357672aef3f4b2137653c8095a0764d1f6c8` |
| Network | `stellar:testnet` |
| Deployed | 2026-09-09 |
| Deployer | `GA47SADPR4XBBEOJR3WOOZOXT7SEUXGYRMO66PXOINPILE3TFSZDZPKT` |
| Status | **Deployed, first settlement confirmed on-chain** |

Deployment is **two** transactions, and both are recorded because the wasm hash
this document asserts is established by the first, not the second:

| Step | Tx | Ledger |
|---|---|---|
| Upload wasm | [`cc6243aa…`](https://stellar.expert/explorer/testnet/tx/cc6243aad7cd74d07d0545c287e656008a0ff2491c458117c4a32e99acf03991) | — |
| Create contract | [`5cdd248d…`](https://stellar.expert/explorer/testnet/tx/5cdd248deb6dc9667b02452cc990661bba4776880db653caa058a9907f882aa1) | — |

## The superseded first deployment

**`CDLSHRYCP543HUKCGYGQHT2BSXUG2BVEZLCUHZVYV2O7XOTF6UTUH5OI` (wasm
`62ae27cf…`) was deployed earlier the same day and is superseded. It could not
settle a payment.** It is recorded here rather than quietly replaced, because a
deployment record that hides a failed deployment is not a record.

**The defect.** That version moved funds with a direct
`transfer(from, to, actual_amount)`. A Soroban authorization entry commits to
**exact argument values**. The buyer signs at simulation time, when the only
amount known is the ceiling, so the signed tree contained
`transfer(from, to, 500000)`. The facilitator then executed the settlement with
the metered actual, producing `transfer(from, to, 100000)`. The two did not
match and the host refused:

```
Error(Auth, InvalidAction)
[Failed Diagnostic Event] contract:CBIELTK6…,
  topics:[error, Error(Auth, InvalidAction)],
  data:["Unauthorized function call for address", GDZ7SANN…]
```

**Why it was not caught before deploying.** All 15 tests passed. Every one used
`mock_all_auths()`, which authorizes whatever is asked and therefore cannot
detect a mismatch between the signed auth tree and the executed calls. The
contract was verifiably correct against its own tests and unable to settle a
single payment. Nothing was spent on the failure: it surfaced at simulation.

**The fix.** `approve` + `transfer_from`. The buyer's auth entry covers
`approve(from, contract, max_amount, expiration_ledger)`, and `max_amount` **is**
known at signing time, so the signed and executed sub-invocations agree. The
contract then draws `actual_amount` via `transfer_from` as the spender, which
needs no buyer signature. That indirection is the mechanism that lets `actual`
differ from the ceiling; it is not ceremony. `DESIGN.md` OQ-3 and OQ-2 are
resolved accordingly, with the original reasoning kept and marked wrong.

**The regression test.** TR-16 uses `mock_auths` — one exact authorized tree,
everything else refused — rather than `mock_all_auths`. Reverting the contract to
a direct transfer fails TR-16 and the auth-binding assertion, confirmed by
mutation. The test gap that allowed the first deployment is closed.

## First on-chain settlement

| Field | Value |
|-------|-------|
| Tx hash | [`be33bb71…`](https://stellar.expert/explorer/testnet/tx/be33bb71b0a2c74c465bf0243c45e081bc7c5b66a337e2d8a5c0bbb82f54ede6) |
| Ledger | 4587956 |
| Successful | `true` |
| Payer | `GDZ7SANN7AXJEM5OUCEXNZRX7TQXGXNDVM22G2AK3CFM4VAGWIE7IEON` |
| Recipient | `GD5EANBVMBT62T7FNFHYPYNIYXMPBG37CHPEY7KHE3LRHNTHLWGTLROC` |
| Ceiling signed | 500,000 (0.05 USDC) |
| Actual settled | 100,000 (0.01 USDC) |
| Fee charged | 40,144 stroops |
| Fee account | `GBOC2UOB7UI3LW2JDRSJQVCGI7SN7QD7AWELYCSNFY6GEWD4EPED6U3Y` |
| Date | 2026-09-09T14:16:07Z |

Asset: canonical testnet USDC
(`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`).

**The actual is 20% of the ceiling, and that is the point.** The buyer
authorized 0.05 USDC and was charged 0.01. The merchant's USDC balance moved by
exactly 0.01 (confirmed on Horizon after settlement), so the remaining 0.04 of
authorized headroom was never drawn. This is the property that distinguishes
`upto` from `exact`, and it is the property the superseded contract could not
deliver.

The fee was paid by the facilitator's sponsor, not the payer — `areFeesSponsored`
demonstrated on-chain rather than asserted.

**Facilitator support.** `src/upto.ts` speaks this contract's 7-argument
`settle` ABI, which omits `hook` entirely (`DESIGN.md` FR-2/SR-4). It briefly
also accepted the vendored contract's 8-argument form; that branch was removed
once the hosted instance cut over, because the contract-address pin made it
unreachable. The `examples/upto-buyer.mjs` flag `UPTO_NO_HOOK=1` builds the
7-argument form.

## Reproduce the wasm hash

```bash
cd contracts/upto-vellar
stellar contract build
shasum -a 256 target/wasm32v1-none/release/x402_upto_vellar.wasm
# expect 92365d9e5effe046a1db5b959bd2357672aef3f4b2137653c8095a0764d1f6c8
```

Toolchain: `rustc 1.96.0` / `stellar-cli 26.1.0` / `wasm32v1-none`.
Built size: 4,162 bytes (4,519 before optimization).

Reproducibility is not claimed beyond this toolchain. A different rustc or
stellar-cli version may produce a different hash; that is a property of the
build, not evidence of tampering. The verification below is what actually ties
this repository to the bytes the chain runs.

## Verify against on-chain bytes

```bash
stellar contract fetch \
  --id CCZL7CTRS6GWEYXDYD54DZM3OUHQW2S2A4KSU75SH275P3SFZLL4YQAN \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  --out-file fetched.wasm

shasum -a 256 fetched.wasm
# must match the hash above
```

**Verified 2026-09-09.** The fetched bytes and the locally built artifact are
both `92365d9e…`. This does not rest on the CLI's report of what it uploaded:
the bytes were fetched back from the network and hashed independently.

The deployed contract exports exactly two functions, `settle` and `is_used`,
which is `DESIGN.md` FR-1 confirmed by the build rather than by inspection.

## On the deployer

A dedicated one-time keypair, deliberately **not** the facilitator's payment
sponsor (`GBUCR6H22CZC5OYHBJIEUS2JFZBOB63AHEGTCV6UEPMD2TMLKG2ZMIW4`). Contract
deployment history stays distinct from payment sponsorship, the same separation
the original vendored `upto` contract used. The same deployer signed both the
superseded and the current deployment.

The key was generated and written directly to a mode-600 file under
`.e2e-local/` (gitignored) in a single step, so it never passed through a shell
argument or a transcript. It has no continuing role: the contract has no admin,
no owner and no upgrade path (`DESIGN.md` SR-3), so this account holds **no
privilege whatsoever** over the deployed contract. Nothing is lost if the key is
discarded.

## Design

Written from [`contracts/upto-vellar/DESIGN.md`](../contracts/upto-vellar/DESIGN.md),
committed (`f95e099`) **before** the implementation (`109a063`). The FR-6
correction that produced this deployment is recorded in that file alongside the
original, wrong reasoning.

Key differences from the vendored contract in
[`contracts/upto-stellar/`](../contracts/upto-stellar/), which is retained as
evidence for its own settlement hashes but is **not deployed and not a
supported configuration**:

- **No `hook` argument in the ABI.** The facilitator refuses it anyway; omitting
  it is better than accepting and ignoring it.
- **Explicit settlement event** reporting both `ceiling` and `actual`, so an
  indexer can classify by event rather than by invocation shape, and can see the
  authorized headroom that went unspent.
- **Nonce TTL set to `expiration_ledger` with no buffer.** FR-5 refuses any
  settlement past expiry regardless of nonce state.
- **Negative `actual_amount` rejected explicitly.**
- **Nonce keyed on `(from, nonce)`**, so two payers drawing the same random
  nonce is a collision rather than a lockout.
- **16 tests**, including balance assertions on every rejection path (TR-14), a
  zero-balance assertion on the contract itself (TR-15), and TR-16 under real
  auth.

## Integration status

Integrated into the hosted facilitator on 2026-09-09. `UPTO_CONTRACT_ID` set to
`CCZL7CTRS6GWEYXDYD54DZM3OUHQW2S2A4KSU75SH275P3SFZLL4YQAN` in the Render
environment and the service restarted. Confirmed via `GET /supported` returning
the new contract ID.

The settlement above was run against a local facilitator configured with the
same contract id, before the hosted instance was switched.
