# Provenance — x402 `upto` settlement contract

**Vendored, not authored here.** This crate is rail402's `upto` settlement
contract, taken verbatim from:

- Upstream: `https://github.com/tolgayayci/rail402` — `contracts/upto-stellar/`
- Pinned commit: `ff504b85ac065369dc985759afe4164a4541d861` (also in `UPSTREAM_PIN`)
- License: Apache-2.0 (upstream `Cargo.toml` declares it; attribution retained)
- Vendored: 2026-08-21, after a line-by-line review recorded in the
  competitor-evaluation record and summarized in `technical-doc.md` §9.2

Why vendored rather than referenced: we deploy **our own build from this
pinned source** and never point at rail402's deployed contract instance, whose
wasm hash has not been verified against a reproducible build. Building from a
source we have read and pinned is the whole point; our deployed contract ID
and wasm hash are published in `docs/upto-deployment.md` so anyone can verify
our build the same way.

Local changes: **none**. `diff` this directory against the pinned upstream
path to confirm — any divergence is a defect in this statement.
