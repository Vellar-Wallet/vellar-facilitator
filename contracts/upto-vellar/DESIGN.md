# Vellar `upto` Settlement Contract — Design Brief

**Status:** design, no implementation. This document is committed before any
Rust is written, so the history shows the design preceded the code.

## Purpose

A Soroban smart contract that enforces the x402 `upto` payment scheme on
Stellar. The buyer signs a ceiling authorization once. The facilitator settles
the actual metered amount. The contract enforces `actual <= ceiling` on-ledger
before moving any funds.

## Provenance — stated precisely

This contract is designed from the x402 `upto` scheme description and Soroban's
authorization model, and the design is recorded here before implementation.

It is **not** described as clean-room, and that word is deliberately avoided.
This repository already vendors a working `upto` implementation at
[`contracts/upto-stellar/`](../upto-stellar/), taken verbatim from
[`tolgayayci/rail402`](https://github.com/tolgayayci/rail402) (Apache-2.0, see
that directory's `PROVENANCE.md`), and the authors of this design have read it.
A clean-room claim asserts the designer had no access to the reference
implementation. That is not true here, so it is not claimed.

What *is* claimed, and what the git history actually supports:

- the design was written from the scheme's requirements rather than transcribed
  from existing code;
- the design decisions and their open questions were recorded **before** the
  first line of Rust, and can be checked against the commit order;
- the differences from the vendored implementation are deliberate and are
  named in [§ What is distinct here](#what-is-distinct-here), not incidental.

The vendored contract is Apache-2.0, so nothing about this work requires the
stronger claim. Overstating provenance would cost more credibility than the
claim could ever buy.

## Functional requirements

### FR-1 — one entry point

The contract exposes one state-changing function: `settle`. There is no admin,
no upgrade path, and no owner. The deployer holds no special privilege after
deployment.

### FR-2 — argument order

```
settle(
  token: Address,
  from: Address,
  to: Address,
  max_amount: i128,
  expiration_ledger: u32,
  nonce: BytesN<32>,
  actual_amount: i128,
)
```

There is **no `hook` argument**. The facilitator refuses `hook` already, so the
ABI omits it rather than accepting and ignoring it. An argument that is parsed
but never honoured is a surface a caller can reason wrongly about.

### FR-3 — on-ledger enforcement

`actual_amount <= max_amount` is verified inside the contract before any
transfer. If `actual_amount` exceeds `max_amount`, the invocation fails and no
funds move.

`actual_amount >= 0` is also enforced. A negative amount would otherwise invert
the comparison in FR-3 and pass a ceiling check while moving value the wrong
way; SEP-41 implementations are not uniformly required to reject it.

### FR-4 — nonce consumption

Each `(from, nonce)` pair may be used exactly once. A replayed nonce fails
before any transfer. Storage policy is **OQ-1**, unresolved.

The nonce is keyed by `(from, nonce)` rather than by `nonce` alone, so one
payer cannot consume another payer's nonce space.

### FR-5 — expiry enforcement

The invocation is rejected when the current ledger sequence exceeds
`expiration_ledger`. Expiry is in ledgers, not wall-clock time.

### FR-6 — SEP-41 token interface

The contract moves funds through the SEP-41 interface and does not assume a
specific token contract.

**Mechanism:** `approve(from, contract, max_amount, expiration_ledger)`, which
the buyer's auth entry covers, followed by
`transfer_from(contract, from, to, actual_amount)`, which this contract makes as
the spender and which needs no buyer signature.

> **Correction (2026-09-09).** This section originally specified a single direct
> `transfer(from, to, actual_amount)`, on the reasoning that an allowance written
> and consumed in the same invocation was redundant. **That reasoning was wrong,
> and the resulting contract could not settle a payment at all.**
>
> A Soroban authorization entry commits to **exact argument values**. The buyer
> signs at simulation time, when the only amount known is the ceiling, so the
> signed tree contains `transfer(from, to, MAX)`. The facilitator then executes
> the settlement with the metered amount, producing `transfer(from, to, ACTUAL)`.
> The two do not match, and the host refuses with `Error(Auth, InvalidAction)` —
> *"Unauthorized function call for address"*.
>
> This was not caught before deployment: all 15 tests used `mock_all_auths()`,
> which authorizes whatever is asked and therefore cannot detect an argument
> mismatch. It surfaced on the first real testnet settlement against
> `CDLSHRYCP…`, which is now superseded. See
> [`docs/upto-vellar-deployment.md`](../../docs/upto-vellar-deployment.md).
>
> `approve` + `transfer_from` is the mechanism that resolves it, not ceremony:
> `approve` is signed for `max_amount`, which **is** known at signing time, so
> the signed and executed sub-invocations agree; the contract then draws
> `actual_amount` as spender. The indirection is exactly what allows `actual` to
> differ from the ceiling.
>
> **OQ-3 is resolved: `approve` + `transfer_from`. OQ-2 follows and resolves to
> `max_amount`** — the approval must match what the buyer signed, so it cannot be
> narrowed to `actual`.
>
> The regression test is **TR-16**, which uses `mock_auths` (one exact authorized
> tree) rather than `mock_all_auths`. Reverting the contract to a direct transfer
> fails TR-16 and the auth-binding test, verified by mutation.

The allowance is left at its post-draw value rather than reset. Resetting would
require a **second** `approve` sub-invocation, which the buyer did not sign and
which therefore cannot be authorized. It is bounded in both directions anyway:
it expires at `expiration_ledger`, and the consumed nonce (FR-4) makes the
authorization single-use, so no second settlement can draw the remainder.

### FR-7 — settlement event

Every successful settlement emits an explicit event:

```
{
  payer: Address,
  recipient: Address,
  ceiling: i128,
  actual: i128,
  nonce: BytesN<32>,
}
```

This lets an indexer classify `upto` settlements by event rather than by
invocation shape. The explorer's classifier currently infers the `upto` shape
structurally and reads ground truth from the token's own `transfer` event
(`vellar-explorer`, `src/classify.ts`, v3); an explicit event from this
contract is more robust and more legible than inferring intent from argument
positions.

Note the event reports both `ceiling` and `actual`, so an observer can see the
headroom that was authorized but not spent — which is the property that
distinguishes `upto` from `exact` and is otherwise invisible on-chain.

### FR-8 — read-only query

```
is_used(from: Address, nonce: BytesN<32>) -> bool
```

Allows a pre-flight check without submitting a transaction.

## Security requirements

### SR-1 — no custody

The contract holds no funds at any point. Value moves directly from payer to
recipient within a single invocation. There is no balance for an attacker to
drain and no state in which funds are resident in the contract.

### SR-2 — auth model

The buyer's Soroban auth entry authorizes the `settle` invocation over:

```
(token, from, to, max_amount, expiration_ledger, nonce)
```

and **not** `actual_amount`.

This is the core property of the scheme: **the buyer signs the ceiling, not the
charge.** The facilitator supplies `actual_amount` at settlement time, and the
contract's only guarantee about it is FR-3 — that it does not exceed what the
buyer signed, and is not negative.

The consequence should be stated plainly rather than left implicit: within the
ceiling, the facilitator chooses the amount. `upto` moves trust in the metered
amount from the chain to the facilitator, and bounds the damage at
`max_amount`. A buyer signing an `upto` authorization is accepting that bound,
not an exact price.

### SR-3 — no upgradability

No upgrade path, no admin key. Once deployed, the code is fixed.

The trade is deliberate and it cuts both ways: a money-moving contract with no
upgrade path is far simpler to audit and cannot be silently changed under its
users, but a defect found after deployment can only be addressed by deploying a
new contract and migrating. Given that the contract holds no funds (SR-1) and
has one entry point (FR-1), the blast radius of that trade is small.

### SR-4 — no hook argument

Restates FR-2 as a security property: the ABI has no `hook` parameter. An
omitted argument cannot be exploited by a caller who assumes it is honoured.

## Open questions — resolve before writing Rust

### OQ-1 — nonce storage TTL

| | Option | Trade |
| --- | --- | --- |
| a | Permanent, no expiry | Simplest and safest against replay. Storage grows without bound, and Soroban state has rent costs. |
| b | `expiration_ledger` + buffer | Self-cleaning: a nonce cannot be replayed while the authorization is still valid, and the record expires shortly after the authorization does. More logic, and the buffer size is a judgment call. |
| c | Fixed TTL (e.g. 24h in ledgers) | Predictable and independent of the authorization. Wrong in both directions: too short for a long-dated authorization, wastefully long for a short one. |

Unresolved. Note that (b) is the only option whose safety argument is
self-contained: once the authorization has expired, FR-5 rejects the
transaction regardless of nonce state, so retaining the nonce past that point
protects nothing.

### OQ-2 — approval amount — **RESOLVED: `max_amount`**

The earlier reasoning here was that `actual_amount` is tighter and there is no
case for approving the larger figure. That is wrong for the same reason the
direct transfer was wrong: **the approval is the thing the buyer signs**, and at
signing time the only amount known is the ceiling. Approving `actual` would
require the buyer to have signed an amount that did not exist yet.

The tightness that was wanted is still there, just enforced elsewhere: the
contract draws only `actual_amount` via `transfer_from`, and FR-3 bounds that
on-ledger. The allowance is a ceiling, not a disbursement.

### OQ-3 — direct transfer or approve + transfer_from — **RESOLVED: `approve` + `transfer_from`**

Not a preference. A direct transfer **cannot work** for this scheme, because a
Soroban auth entry commits to exact argument values and the buyer cannot sign an
amount that is not determined until settlement. See the correction under FR-6.

The original argument for the direct transfer — fewer moving parts, no
intermediate allowance state — was sound engineering reasoning applied to a
constraint that had been misunderstood. It is recorded rather than deleted
because the mistake is instructive: the atomicity of the invocation was never
the issue, the *signability* of the arguments was.

## What is distinct here

Relative to the vendored implementation in `contracts/upto-stellar/`:

1. **No `hook` argument in the ABI** (FR-2, SR-4).
2. **An explicit settlement event** carrying both ceiling and actual (FR-7),
   so indexers classify by event rather than by invocation shape.
3. **A stated nonce TTL policy** (OQ-1), decided deliberately rather than
   inherited.
4. **`actual_amount >= 0` enforced explicitly** (FR-3).
5. **The design recorded before the implementation**, with open questions
   named rather than settled silently.

## Test requirements

| # | Case |
| --- | --- |
| TR-1 | Successful settlement within the ceiling |
| TR-2 | Rejection when `actual_amount > max_amount` |
| TR-3 | Nonce replay rejected |
| TR-4 | Expired ledger rejected |
| TR-5 | Settlement event emitted with correct fields |
| TR-6 | `is_used` returns `true` after settle |
| TR-7 | `is_used` returns `false` before settle |
| TR-8 | Zero `actual_amount` (nonce burn) succeeds and consumes the nonce |
| TR-9 | `actual_amount == max_amount` (exact ceiling) succeeds |
| TR-10 | Different nonces, same payer, are isolated |

Added beyond the initial list, because each is a failure this design's own
requirements imply:

| # | Case |
| --- | --- |
| TR-11 | Negative `actual_amount` rejected (FR-3) |
| TR-12 | Settlement at exactly `expiration_ledger` succeeds; one ledger later fails (FR-5 boundary) |
| TR-13 | Same nonce, different payers, both succeed (FR-4 keying) |
| TR-14 | No funds move on any rejection path — payer and recipient balances unchanged after TR-2, TR-3, TR-4 and TR-11 |
| TR-15 | Contract balance is zero before and after a settlement (SR-1) |

TR-14 is the one that matters most: every rejection test above asserts that the
call failed, and a call can fail *after* moving funds. Asserting balances
directly is what makes SR-1 and FR-3 verified rather than assumed.
