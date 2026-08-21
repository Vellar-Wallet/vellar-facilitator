# `upto` settlement contract — deployment record

Published so anyone can verify our deployed contract against its source
without trusting this file. Every value below is checkable.

| | |
| --- | --- |
| Contract ID (testnet) | `CDHPA64M73TUTEM4MMHIWIXINBQXH7JJXFGZMGH22VJWFJFROMR6QV2S` |
| Wasm hash (on-chain) | `c276b905981eab91704ce9b9046ebb4867b164dd7e4ba0e0ecda841527d398a9` |
| Source | `contracts/upto-stellar/` in this repo — vendored verbatim from rail402 at commit `ff504b85ac065369dc985759afe4164a4541d861` (see `PROVENANCE.md` there; Apache-2.0) |
| Built with | rustc/cargo 1.96.0, `stellar` CLI 26.1.0, target `wasm32v1-none`, soroban-sdk 23, `overflow-checks = true` in the release profile (upstream `Cargo.toml`, unchanged) |
| Deployed | 2026-08-21, from this repo's sponsor account |
| First settlement | tx `72c816a63ab9da21b1403ff5199e4f21b9947c0769c55312a8cf0dc7e6ecf3db` (ledger 4250665): ceiling 1,000,000 atomic USDC authorized, **actual 400,000 settled** — Horizon effects show exactly 0.04 USDC moved, fee paid by the facilitator sponsor, buyer holds no XLM |

## Verify the build yourself

The on-chain wasm hash IS the sha256 of the wasm, so the whole chain is three
commands:

```sh
cd contracts/upto-stellar
stellar contract build          # rustc 1.96.0 / stellar-cli 26.1.0 / wasm32v1-none
shasum -a 256 target/wasm32v1-none/release/x402_upto_stellar.wasm
# → c276b905981eab91704ce9b9046ebb4867b164dd7e4ba0e0ecda841527d398a9
```

And fetch what the chain is actually running:

```sh
stellar contract fetch \
  --id CDHPA64M73TUTEM4MMHIWIXINBQXH7JJXFGZMGH22VJWFJFROMR6QV2S \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  --out-file fetched.wasm
shasum -a 256 fetched.wasm      # → the same hash
```

Both were run on 2026-08-21 and matched. Toolchain versions matter for
reproducing the hash — a different rustc can produce a byte-different (still
correct) wasm.

## Why our own deployment

The source was reviewed line-by-line before vendoring (contract shape:
minimal, admin-free, non-custodial bounded-draw; dual-layer replay protection
with the nonce-TTL bound; 17 upstream tests, re-run here). rail402's own
deployed instance of the same source was NOT used because nothing ties its
on-chain wasm hash to a reproducible build — exactly the gap this record
closes for ours.

## Facilitator wiring

`UPTO_CONTRACT_ID=<contract id>` registers the scheme; `/supported` then
advertises `upto` with `extra.uptoContract`, and `/verify`//`/settle` accept
`scheme: "upto"` payloads (see `src/upto.ts` for the wire shape and the two
deliberate positions: the settlement hook is refused, and verify simulates at
the ceiling). Unset, the facilitator is exact-only.

`examples/upto-buyer.mjs` is the end-to-end client: authorize a ceiling with
one signature, settle for the metered actual.

## Verified independently — not just by this repo

[`explorer.vellar.xyz`](https://explorer.vellar.xyz) is a separate,
independently operated service (`Vellar-Wallet/vellar-explorer`) that
classifies real Stellar ledger data directly — it does not read anything
this facilitator reports about itself. Three settlements against the hosted
instance on 2026-08-21, each independently confirmed successful on Horizon
before being checked there:

| Tx | Ceiling → actual (stroops) | Explorer shows |
| --- | --- | --- |
| `0e5fffea1794800fd46a77919fe183bc4639d7dd5ffaf90ad7c2f336cf2e3f1e` | 2000000 → 730000 | not indexed — settled before the explorer's classifier recognized `upto` (below) |
| `be72877332bbd7f8d38511cccf00620fb20869cfedbc7530588ca856ac646d9a` | 1500000 → 555000 | `scheme: upto`, `settled by: vellar`, `0.0555 USDC` |
| `f558307ef7366be7d70967d1bd2acb65da19f24627a0f91cd62b95cf70c9693e` | 800000 → 312000 | `scheme: upto`, `settled by: vellar`, `0.0312 USDC` |
| `12f0fa5c720d6791018d30261fa88b5d0934bb8a2dc141cd28b6ded3e432d21a` | 1200000 → 417000 | `scheme: upto`, `settled by: vellar`, `0.0417 USDC` |

**One real gap found and fixed along the way.** The first settlement above
(`0e5fffea…`) did not appear on the explorer at all — not lag, a genuine
classifier gap: its heuristic only recognized a top-level `transfer(from, to,
amount)` call directly on the watched USDC SAC (the `exact`-scheme shape).
An `upto` settlement invokes a different contract's `settle(...)`; the actual
token movement happens as a nested sub-invocation the classifier never
inspected. Root-caused by reading `vellar-explorer`'s own `classify.ts`, then
fixed there: the classifier now recognizes an `upto`-contract invocation by
shape and reads the *actual* settled amount from the token's own emitted
`transfer` event, since the signed ceiling and the facilitator-supplied
actual in the envelope's args are not ground truth for what the chain moved
— the event is. The three later transactions above are the proof the fix
holds, run after the fix deployed.

As of this writing, per the explorer's own "Who settled it" breakdown: **6
of 4,799** payments indexed across the whole visible testnet ecosystem carry
a known, identified facilitator, and all six are ours — the rest is
unattributed traffic. A small, testnet-scale number, not a market-share
claim, but a true and independently-checkable one: right now, this is
essentially the only identifiable facilitator among that traffic.
