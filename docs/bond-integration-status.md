# Provider bond system — where it stands, and how to finish it

**Status:** the contract is complete and proven on testnet. The facilitator is wired for
exactly one of its seven entry points. This document is the guide for picking the rest
back up — what's done, what isn't, what needs a real decision before more code gets
written, and the concrete order to do it in. Written at a deliberate pause point, not a
stopping point: the design and the first real connection are solid enough to stand on
their own for now (see "Why we're pausing here" at the end).

---

## 1. What's actually done, with evidence

**The design.** `docs/proposal-provider-bond.md` — every decision locked, every trade-off
argued through, not just concluded. Merged to `main` in
[PR #74](https://github.com/Vellar-Wallet/vellar-facilitator/pull/74).

**The contract.** `contracts/bond-escrow/` — original work, not vendored. All seven entry
points from the design document exist and are tested: `register_settlement`, `deposit`,
`withdraw`, `file_dispute`, `set_delivery_key`, `post_receipt`, `finalize`. **89 tests
passing** (`cargo test`, verified directly, not from memory, while writing this doc).
Merged in the same PR #74, commit `7d91620` (amended once for the claim-filing-window fix
and the dedicated-admin-key decision — see `docs/proposal-provider-bond.md`'s own history
if the exact diff matters later).

**Two real testnet deployments**, not simulated:

1. A 24-hour-response-window instance, `CAJKUV7LHB7HLLUBRSFCET44ZTDRL4XCWOSKKQA2E2CMITJEDFTD3CLP`.
   Steps 1-5 of the full lifecycle were run for real against it before the response window
   was changed (see item 2 below) — this instance is now **abandoned**, not because
   anything failed, but because its source no longer matches what's committed. It still
   holds a small amount of real testnet USDC and an open dispute that will never resolve
   through any code path that still exists. Harmless, just stale. Do not use it.
2. A 5-minute-response-window instance, `CAWQ2FJDPWHOFLYQIPKBU4M6IE4GUROKUKVVZERWQVD2DHP7S2CULTI4`
   — **this is the one that matters**. Wasm hash `21e4a128423f8d4246951812a4fd6cb3811ba30b100c73e912b4febc7ffd949c`,
   confirmed three independent ways (two clean local builds, one `stellar contract fetch`
   against the live instance). Every one of the seven entry points was exercised for real
   against it, with real ledger time (not the test harness's synthetic clock) and every
   transaction independently confirmed on Horizon. Full record —
   contract ID, wasm hash, every tx hash, the `set_delivery_key`-after-`deposit` ordering
   requirement, the 5-minute-vs-24-hour caveat — is written up in
   `docs/bond-escrow-deployment.md`.

   **That file is currently local-only, not pushed, not merged, not on `main`** — confirmed
   directly while writing this doc (`git show main:docs/bond-escrow-deployment.md` fails).
   It exists as a real, complete, accurate commit (`282ebee` on the local branch
   `docs/bond-escrow-deployment-record`) — pushing and opening a PR for it is a small,
   safe, low-effort first step whenever this work resumes, and probably the very first
   thing to do (see the roadmap below).

**The facilitator connection — one entry point, wired and proven.**
[PR #75](https://github.com/Vellar-Wallet/vellar-facilitator/pull/75), merged to `main`
(`025bfa5`), three commits:

- `src/config.ts` — `BOND_ESCROW_CONTRACT_ID` / `BOND_ESCROW_ADMIN_SECRET_KEY`, same
  validation convention as `UPTO_CONTRACT_ID`, both-or-neither enforced at boot.
- `src/bond.ts` — `registerSettlement()`, the Soroban invocation wiring. Admin-key-signs
  (never the sponsor key), and a `rejected`/`infrastructure_error` split that mirrors how
  Soroban actually reports the two cases, not a guess.
- `src/server.ts` — `register_settlement` called synchronously inside `/settle`, before
  success is reported. Unconfigured, `/settle` is byte-for-byte unchanged.

**436 TypeScript tests passing** (verified directly while writing this doc:
`npm test` on current `main`). CI green before merge on both PRs.

**Confirmed end-to-end, for real** — the actual proof this whole thing works together, not
just in isolation: a real facilitator process, pointed at the 5-minute contract above,
settled a real payment through the demo seller. `/settle` returned `200`. The resulting
`SettlementRecord` was independently confirmed on-chain:

```
settlement tx      5f20dcfd96c083fedebb7d9ff5d6761b32d4fb39de864c41d0b16c3bda3683d5
contract            CAWQ2FJDPWHOFLYQIPKBU4M6IE4GUROKUKVVZERWQVD2DHP7S2CULTI4
SettlementRecord    { amount: 200000, payer: <real buyer G-address>, seller: <real PAYTO> }
```

That is a real payer with real, on-chain standing to dispute a real settlement. It is the
one thing in this whole system that has been proven to work end to end, not just at each
layer independently.

---

## 2. What's explicitly not done — precisely, not vaguely

The contract has all seven entry points. The facilitator only calls one of them
(`register_settlement`), and only calls it on the facilitator's own behalf, using the
facilitator's own admin key. Everything else requires a **buyer or seller** to act, and
nothing in this codebase lets them do that through the facilitator yet:

| Entry point | Contract status | Facilitator status |
| --- | --- | --- |
| `register_settlement` | done, tested, proven live | **wired** — `/settle` calls it |
| `deposit` | done, tested, proven live | not callable through the facilitator at all |
| `set_delivery_key` | done, tested, proven live | not callable through the facilitator at all |
| `withdraw` | done, tested, proven live | not callable through the facilitator at all |
| `file_dispute` | done, tested, proven live | not callable through the facilitator at all |
| `post_receipt` | done, tested, proven live | not callable through the facilitator at all |
| `finalize` | done, tested, proven live (permissionless) | not callable through the facilitator at all |

Also not built, per `docs/proposal-provider-bond.md` Section 6, unchanged since that
document was written:

- No `bonded_only` filter in `catalog.ts`, `server.ts`'s discovery routes, or `mcp.ts`.
- No bond resolver in `trust.ts` — the discovery response's `trust` block carries nothing
  about bonds today.
- No caching of bond/dispute state in `store.ts`, and no polling process for the
  time-based state changes (a dispute window elapsing) that have no triggering
  transaction.
- Nothing in `vellar-sdk` (a separate repo) — it remains payer-only, no seller-side
  receipt-signing helper, no new MCP tools for filing a dispute or verifying a receipt.
- No independent third-party verification path — `vellar-explorer` has zero bond-escrow
  awareness, unlike `upto-stellar`'s explorer confirmation.

---

## 3. Real decisions needed before more code gets written — not just tasks

These aren't implementation work, they're calls that shape the implementation work, and
skipping them means building the wrong thing first.

**a. Does the facilitator relay `deposit`/`withdraw`/`file_dispute`/`post_receipt` as
sponsored HTTP routes, or stay purely direct-to-contract?** `register_settlement` didn't
need this call — it's entirely facilitator-signed. Every remaining entry point is signed
by a *seller* or a *payer*, which is a materially different integration shape:

- **Relay (recommended, matching the existing `/verify`+`/settle` value proposition)**: the
  facilitator accepts a signed request, builds and submits the Soroban transaction,
  sponsors the fee — buyers and sellers never need to hold XLM or run a Soroban SDK
  themselves. This is real new surface: new routes, new request/response shapes, new
  error handling, and the SDK-side counterpart (`vellar-sdk`) needs a way to produce
  whatever signed payload the relay expects.
- **Direct-to-contract**: sellers and buyers call the contract themselves via CLI or a
  hand-rolled client, exactly like the confirmation test in `docs/bond-escrow-deployment.md`
  did. Zero new facilitator routes, but it means real users need Soroban tooling and
  testnet/pubnet XLM of their own — a much higher bar than this product has asked of
  anyone so far, and a real UX regression from what `/settle` already provides for
  payments.

This should be decided once, explicitly, before touching any of the remaining entry
points — not re-litigated per entry point.

**b. What should the real response window actually be?** The only currently-live,
fully-proven contract instance uses 5 minutes, deliberately compressed for a same-day
demo and explicitly marked in its own source comment as not shippable toward mainnet as
is. Before any further real-facilitator work happens against a bond contract, this needs
either a fresh deployment with a genuinely defensible value (the original 24-hour
reasoning, or something informed by real data if any exists by then) or an explicit,
conscious decision to keep testing against the 5-minute instance a while longer with that
tradeoff understood. Don't let "the contract we happen to have deployed" quietly become
"the value we ship" by default.

**c. Who holds the real admin key for whatever gets deployed next?** The admin key
currently in use (`GAGSR7PBRCU2JC6FOEHIVQKNTBWIDOIEHONB43YYWAC6SMYGAIKWT7BI`) was generated
ad hoc for this session's testing. Fine for continued manual/local work; not something
that should become the facilitator's live bond-admin key by default just because it's the
one that already exists. A real deployment — even testnet-only, even before this goes to
any real users — should get its own deliberately-provisioned, tracked key, matching the
same discipline this whole feature is built around (a dedicated key, not a reused one).

---

## 4. The completion roadmap, in order

1. **Push and open a PR for `docs/bond-escrow-deployment.md`.** It's finished, accurate,
   and already committed locally (`282ebee`) — this is nearly free and makes the testnet
   proof-of-life a matter of public record instead of a local file.
2. **Decide 3a and 3b above** (relay vs. direct-to-contract; the real response-window
   value). Both are cheap to decide and expensive to build around incorrectly.
3. **If relaying**: design and build the HTTP routes for `deposit`, `set_delivery_key`,
   `file_dispute`, `post_receipt`, and `withdraw` — matching `/settle`'s existing pattern
   of accepting a signed payload and sponsoring the fee, one route at a time, same
   discipline as the `register_settlement` build (tests before moving to the next,
   confirmation against a real deployed instance before calling any one of them done).
   `finalize` needs no route at all — it's permissionless by design; anyone (including a
   simple cron-style job the facilitator could run, or just documentation telling
   claimants they can call it themselves) can trigger it once a window elapses.
4. **`trust.ts`'s bond resolver and the `bonded_only` filter**, once there's something
   real for a buyer to filter on — building this before step 3 exists would mean
   surfacing bond data nobody can act on yet.
5. **`store.ts` caching plus a poller**, once discovery is actually reading bond state
   on every request and the live-query cost becomes real rather than theoretical.
6. **`vellar-sdk`** — the seller-side receipt-signing helper and payer-side MCP tools,
   once there's a real relay API for them to call against.
7. **`vellar-explorer` independent verification**, last — it's explicitly a follow-on per
   the design document, not blocking anything else, and is most useful once real bonded
   listings with real dispute history exist to show.

Each step should get the same treatment `register_settlement` got: real tests, a real
confirmation against a real deployed contract before calling it done, and an honest
accounting — in the PR, not just in chat — of what was decided versus what was
specified.

---

## 5. Why we're pausing here

Not because anything is blocked — because what exists right now is a complete, honest,
independently-verifiable story on its own: a contract proven end to end on testnet, a
design document that argues every decision rather than just asserting it, and one real
payment that created real, on-chain, checkable dispute standing. That's a genuine
milestone, not a partial one pretending to be further along than it is. The remaining
work is real, substantial, and better done deliberately — after the decisions in section 3
are actually made — than rushed to make the story sound more finished than it is.
