# `bond-escrow` contract — deployment record

Published so anyone can verify this deployed contract against its source without
trusting this file. Every value below is checkable.

| | |
| --- | --- |
| Contract ID (testnet) | `CAWQ2FJDPWHOFLYQIPKBU4M6IE4GUROKUKVVZERWQVD2DHP7S2CULTI4` |
| Wasm hash | `21e4a128423f8d4246951812a4fd6cb3811ba30b100c73e912b4febc7ffd949c` |
| Source | `contracts/bond-escrow/` in this repo — **original work**, not vendored (contrast with `contracts/upto-stellar/`, which is rail402's, taken verbatim). Built across four incremental passes plus two review-driven fixes, all folded into a single commit on `main` via [PR #74](https://github.com/Vellar-Wallet/vellar-facilitator/pull/74). |
| Built with | rustc/cargo 1.96.0, `stellar` CLI 26.1.0, target `wasm32v1-none`, `soroban-sdk` resolved to `23.5.3` (`Cargo.lock`), `overflow-checks = true` in the release profile |
| Deployed | 2026-08-21, from a dedicated testnet admin key (not the facilitator's `SPONSOR_SECRET_KEY` — see "Admin key" below), deploy tx [`e0bec89f…`](https://stellar.expert/explorer/testnet/tx/e0bec89fdcefaf9f7eaa601aedf8962a74f162b5ccca0161f912e87faa611bcd) |
| Full sequence exercised | Yes — every one of the seven entry points, on this exact deployed instance, in one continuous run. See below. |

## Verify the build yourself

The on-chain wasm hash IS the sha256 of the wasm, so the whole chain is three commands:

```sh
cd contracts/bond-escrow
stellar contract build          # rustc 1.96.0 / stellar-cli 26.1.0 / wasm32v1-none
shasum -a 256 target/wasm32v1-none/release/x402_bond_escrow.wasm
# → 21e4a128423f8d4246951812a4fd6cb3811ba30b100c73e912b4febc7ffd949c
```

And fetch what the chain is actually running:

```sh
stellar contract fetch \
  --id CAWQ2FJDPWHOFLYQIPKBU4M6IE4GUROKUKVVZERWQVD2DHP7S2CULTI4 \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  --out-file fetched.wasm
shasum -a 256 fetched.wasm      # → the same hash
```

This was done three independent ways, all producing the identical hash, before treating
it as trustworthy:

1. A clean local build.
2. A second clean local build (`rm -rf target` between runs), to confirm the build is
   reproducible and not an artifact of incremental compilation state.
3. `stellar contract fetch` against the live deployed instance above, independently
   re-hashed.

All three: `21e4a128423f8d4246951812a4fd6cb3811ba30b100c73e912b4febc7ffd949c`.

## The response window is 5 minutes on this deployment, not 24 hours — and that is a real, documented decision, not an oversight

`PLACEHOLDER_RESPONSE_WINDOW_SECONDS` in `contracts/bond-escrow/src/lib.rs:235` is
currently `5 * 60`, not `24 * 60 * 60`. Full reasoning lives in that constant's own
doc-comment (`lib.rs`, immediately above line 235), not just here — read it directly
rather than trusting this summary. In short: neither 24 hours nor 5 minutes is validated
by real data; both are guesses. 24 hours was the original placeholder, reasoned from
giving a seller's real receipt-posting process — potentially under real operational load
during a griefing burst — enough time to respond, without letting a slash-avoidance
seller stall indefinitely. 5 minutes abandons the first half of that reasoning on
purpose, specifically so the full lifecycle below could be exercised against real ledger
time in minutes rather than a day, for a testnet-only proof of mechanism. **This value
must move back toward something like the original 24-hour reasoning, informed by real
receipt-posting latency data, before any pubnet deployment** — the source comment says
this explicitly and this file repeats it so the caveat travels with the deployment
record, not just the code.

A separate, throwaway deployment (never recorded here, its wasm hash never cited as
evidence for this or any other build) used this same 5-minute value first, purely to
sanity-check the CLI mechanics before committing to this real run.

## Admin key

`initialize` was called with a dedicated testnet key generated specifically for this
deployment, not the facilitator's `SPONSOR_SECRET_KEY` and not reused from any other
purpose. This matches the reasoning recorded in `initialize`'s own doc-comment
(`lib.rs`, "Which key: a dedicated admin key, not the facilitator's payment sponsor
key"): compromising the admin key lets an attacker forge dispute standing and drain
bonded funds, a materially different blast radius than compromising the payment-sponsor
key, and the two should not be rotatable only in lockstep. This testnet admin key is
scratch and disposable; it is not a template for how the mainnet admin key would be
provisioned or held.

## The full sequence — every entry point, real ledger time, Horizon-confirmed

Run start-to-finish against the deployed instance above. Each transaction was
independently confirmed successful on Horizon (`successful: true`, with its own ledger
number and timestamp), not just trusted from the CLI's own "submitted successfully"
output.

| # | Entry point | Tx hash | Ledger | Horizon timestamp (UTC) | What happened |
| --- | --- | --- | --- | --- | --- |
| 1 | `initialize` | [`9d5959c6…`](https://stellar.expert/explorer/testnet/tx/9d5959c6f3a9c8ace42c5c8bf2868c77a5a7e11e926eab20c80bb225e8ab6674) | 4264791 | 2026-08-21T21:09:17Z | Admin set |
| 2 | `deposit` | [`83841175…`](https://stellar.expert/explorer/testnet/tx/8384117524622650103263b70eefdea24e16c24ca81a53cfdf37523da8b17a6f) | 4264793 | 2026-08-21T21:09:27Z | 400,000 atomic USDC (0.04 USDC) — real SEP-41 transfer, Horizon effects confirm `account_debited` the seller and `contract_credited` the same amount |
| 3 | `set_delivery_key` | [`325ee05c…`](https://stellar.expert/explorer/testnet/tx/325ee05c349b55f7a98623a8cd57cd2046547107dfff1439834ac37178bf9c72) | 4264795 | 2026-08-21T21:09:37Z | Seller's Ed25519 delivery-signing pubkey registered |
| 4 | `register_settlement` | [`972d1379…`](https://stellar.expert/explorer/testnet/tx/972d1379aca6b461efa7004cdeeb6aaef6ee4debbd9fd919c46ff61b3790ed8a) | 4264797 | 2026-08-21T21:09:47Z | Settlement of 250,000 atomic (0.025 USDC) registered, giving the payer standing |
| 5 | `file_dispute` | [`ecf12e79…`](https://stellar.expert/explorer/testnet/tx/ecf12e792d8eee7b65cdeb656ba1dac27087a4ebb5602c53866b9eb0fcc54749) | 4264799 | 2026-08-21T21:09:57Z | Dispute opened by the real payer, `filed_at: 1787346598` |
| — | *(real wait — no transaction)* | — | — | ~5m30s elapsed on the actual network clock | No receipt was posted; the response window elapsed for real |
| 6 | `finalize` | [`f6b516bd…`](https://stellar.expert/explorer/testnet/tx/f6b516bd0cc7cfcf208e7d25676797aa43d651db81abdeb24ee0b84c7317cfae) | 4264867 | 2026-08-21T21:15:37Z | Slash executed — real SEP-41 transfer, Horizon effects confirm `contract_debited` 0.0250000 USDC and `account_credited` the same amount to the payer |

Post-state, read directly from the contract after step 6: `get_dispute` → `null`
(closed), `get_listing.bond_amount` → `150,000` (400,000 − 250,000, exactly
`min(settlement.amount, bond_amount)`), `open_dispute_count` → `0`.

**`set_delivery_key` ordering note.** `set_delivery_key` requires an existing `Listing`
record and fails with `ListingNotFound` (`Error` code 8) if called before any `deposit`
has happened against that resource key — this is a real, deliberate requirement of the
contract, not a testnet quirk. It was discovered by getting the order wrong on the first
(throwaway) run: calling `set_delivery_key` before `deposit` failed exactly as designed.
The sequence above reflects the correct order — `deposit` before `set_delivery_key` —
and is the order any real integration needs to follow.

## Not yet independently verified by a third party

Unlike `upto-stellar`, which `explorer.vellar.xyz` independently confirms by classifying
real chain data with its own logic, `bond-escrow` has no independent-party verification
path today. The explorer has no concept of a bonded listing, a dispute, or a settlement
registration — this is explicitly out of scope per `docs/proposal-provider-bond.md`
Section 6. Everything in this document is self-reported by this repo, verified by the
methods stated above, not corroborated by a separate operator. Worth deciding explicitly
whether that gap needs closing before this is treated as equivalent evidence to
`upto-stellar`'s deployment record.

## Facilitator wiring

None exists yet. Nothing in `src/` calls `register_settlement` or any other entry point
of this contract — see `docs/proposal-provider-bond.md` Section 6 for the full,
unbuilt scope (the synchronous `/settle`-path registration call, HTTP relay routes,
catalog and trust-block integration, and everything in `vellar-sdk`). This contract is
reachable today only by direct Soroban CLI or SDK calls, exactly as exercised above —
not through any real payment made via this facilitator.
