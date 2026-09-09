> **Not deployed, and not a supported configuration.** The facilitator speaks
> only the 7-argument ABI of `contracts/upto-vellar/` — see
> [`docs/upto-vellar-deployment.md`](../../docs/upto-vellar-deployment.md). The
> 8-argument path that once accepted this contract was removed from
> `src/upto.ts` after the cutover.
>
> This source is retained as **evidence**, not as a build target: it is what the
> four `upto` settlement hashes in
> [`docs/upto-deployment.md`](../../docs/upto-deployment.md) were settled
> through, and what that document's reproducible-build steps rebuild. Deleting
> it would make those published hashes unverifiable from a fresh clone.

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

Three paths here are absent upstream and none of them is a change to vendored
code: this file, `UPSTREAM_PIN`, and `test_snapshots/`. The last is generated
Soroban test-runner output from executing the upstream test suite; it is build
output rather than authored content, and it is untracked, so it is not part of
the committed vendored tree. `diff -ru` reports all three as "Only in ." and
still exits 0, since they are additions and not content differences. To compare
only the vendored files:

```sh
diff -ru -x test_snapshots -x PROVENANCE.md -x UPSTREAM_PIN -x target \
  <pinned-upstream>/contracts/upto-stellar contracts/upto-stellar
```
