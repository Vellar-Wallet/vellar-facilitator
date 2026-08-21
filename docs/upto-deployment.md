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
