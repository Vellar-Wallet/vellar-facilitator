# Proposal — voluntary rotation via a marker settlement (Case 1 of O-17)

**Status: PROPOSAL. Not approved, not implemented, no code written.** Drafted
per request, grounded directly in the current codebase
(`src/catalog.ts`, verified against `main` at `afbbb28`). Companion to
`decision-verified-binding-rotation.md`, which this fleshes option D into a
concrete, implementable design rather than a paragraph of intent.

**Scope reminder, so this isn't read as more than it is.** This solves
**voluntary rotation only** — the legitimate merchant still holds the old key.
The lost-key case has no in-band answer (confirmed twice now, independently —
our own latch and rail402's SEP-1 approach both hit the identical wall) and is
handled separately, procedurally, in `proposal-operator-rotation-procedure.md`
(not yet written — see the closing note).

---

## The key insight that makes this cheap

In the `exact` scheme, **`payTo` never signs anything.** It's a receiving
address. The party that signs is the *payer*. So "make the old owner prove
they still hold the key" cannot be done by watching them receive — it can only
be done by making them **act as a payer, once**, for a transaction whose
payload says who the successor is.

That reframing means rotation doesn't need a new signature-verification
primitive, a new Soroban contract, or a new endpoint shape. It needs **one
more settlement through the exact same `/verify` + `/settle` pipeline that
already runs today**, carrying a payload extension instead of buying a
resource. `ExactStellarScheme` already authenticates both classic (`G…`) and
smart-account (`C…`) payers correctly on the verify side — that machinery is
proven, in production, right now. Rotation just needs to consume it.

## The design

### 1. A marker settlement, not a new mechanism

The old owner (`oldPayTo`) becomes the payer of one **real, small, real-money
settlement** — priced identically to how any resource is priced, sent to a
designated marker `payTo` (the sponsor's own address is the simplest choice;
it never needs a separate account). The payment payload's `extensions` carries:

```json
{
  "rotation": {
    "resourceKey": "<canonicalResourceKey>",
    "oldPayTo": "<current bound payTo>",
    "newPayTo": "<successor payTo>",
    "nonce": "<random, prevents replay>"
  }
}
```

This settles through the **existing** `/verify` → `/settle` path, unmodified.
No new client code is needed for a classic old-owner — any x402 buyer library
already does this. A smart-account old-owner hits the **same** construction
gap our regular smart-account buyers already hit (#3158) and uses the **same**
hand-rolled workaround `examples/buyer.mjs` already demonstrates. This is not
a new problem introduced by rotation — it's the existing, already-worked-
around problem, reused.

### 2. What the facilitator does with it

A new, small durable record — `RotationAuthorization`:

```
resourceKey · oldPayTo · newPayTo · settledAt · expiresAt · consumed:boolean
```

Written when a settlement carrying a `rotation` extension confirms on-chain,
**and only if `oldPayTo` matches the resource's *current* `entry.ownerPayTo`**
at settlement time — a rotation claim from an account that doesn't currently
own the resource is meaningless and is dropped, not stored.

### 3. The one change to `tryDisplace`

`src/catalog.ts:923` currently refuses displacement unconditionally once
`this.everVerified.has(key)` (the one-way latch — `catalog.ts:895` and
`:928`). This proposal adds exactly one bypass, checked **before** that
refusal:

```
if (everVerified.has(key)) {
  const auth = lookupRotationAuthorization(key, entry.ownerPayTo, claimant);
  if (auth && !auth.consumed && auth.expiresAt > now) {
    consume(auth);           // single-use
    // fall through — do NOT return "skipped". Proceed to the normal
    // ownership-verification probe for `claimant`, exactly as an
    // unverified-binding displacement already does.
  } else {
    return outcome("skipped", "binding was PROVEN once and is permanently non-displaceable (one-way latch)");
  }
}
```

**Critically, the marker does not itself grant "verified."** It only opens the
door that the latch otherwise keeps shut. `claimant` still has to pass the
*existing* Layer-2 probe (its own 402 must name it) before the binding moves
and re-latches under the new owner. The marker proves *authorization to
attempt* the handover; the existing mechanism still proves *actual control of
the endpoint*. Two independent proofs, neither sufficient alone — which is the
same shape as every other control in this file (TOFU + Layer 2, never one
alone).

### 4. Bounds, stated explicitly rather than assumed

- **Expiry:** a marker is valid for a short window (proposed: 72 hours) from
  settlement. Long enough to complete a real rotation, short enough that a
  stale, forgotten marker doesn't linger as a dormant capability.
- **Single-use:** consumed the moment it enables a displacement attempt,
  successful or not — a used or expired marker cannot be replayed.
- **Scoped to one resource, one successor:** the nonce plus the
  `(resourceKey, oldPayTo, newPayTo)` triple means one marker cannot be
  reinterpreted to authorize a different successor or a different resource.
- **Cost:** one real settlement, sponsored the same way any settlement is —
  no new fee-sponsorship logic. Cheap in the failure case: if nobody ever
  rotates, this path never fires and costs nothing beyond the schema.

### 5. Why this doesn't reopen 2C (the takeover case)

A domain buyer or a compromised endpoint has current *control of the
endpoint* but never had the *old key*. They cannot produce a valid
`RotationAuthorization` — there is nothing to forge, because the marker
requires a real, verified settlement authorized by the specific account the
latch is bound to. This is exactly the "cryptographic continuity a domain
buyer does not have" property `decision-verified-binding-rotation.md`'s
option D asked for; this is that option, made concrete enough to build.

---

## What this costs, honestly

- **New storage:** one small table/record type, mirroring the existing
  ownership-store shape (`store.ts` already has the pattern for durable,
  restart-surviving state).
- **New surface on `tryDisplace`:** one lookup, one consume, before the
  existing refusal. Small, localized, testable the same way every other guard
  in that function already is (named mutation, red test).
- **New surface for sellers:** none required for classic old-owners — any
  x402 client can build this today. Smart-account old-owners need the same
  hand-rolled signer `buyer.mjs` already provides; nothing new to write.
- **Does not touch F (lost-key case).** That's a separate, procedural piece —
  proposed next, per the earlier agreement to do both, not choose one.

## What I'm not doing without sign-off

No code. This is the design for review.

## Implementation plan, if accepted — grounded against `main` @ `afbbb28`

**1. Schema + store method — S, low risk.** A `rotation_authorization` table
in `store.ts`, alongside the existing `ownership` table (`store.ts:207`), same
`CREATE TABLE IF NOT EXISTS` pattern already used for every durable addition:
`resource_key, old_pay_to, new_pay_to, nonce, settled_at, expires_at,
consumed_at`, primary key on the first four. Three new store methods —
record / lookup / consume — same shape as `markVerified` (`store.ts:400`).

**2. `BazaarCatalog` wiring + the `tryDisplace` bypass — S, low risk.** An
in-memory map mirroring `everVerified`, a private helper mirroring
`latchVerified` (`catalog.ts:887`). The bypass itself inserts directly ahead
of the existing unconditional reject at `catalog.ts:895` and `:928`, exactly
as shown in §3 above.

**3. The settle-time hook — S, but this is the one that carries real weight.**
`bazaar.ts:62-95` already fires two fire-and-forget checks off every
settlement (`tryDisplace`, `reverify`), void-called side by side for the same
documented reason: settlement must never wait on either. This becomes a third
call in the same shape.

THE TRAP, worth stating precisely because it is the one place a shortcut
becomes a vulnerability: `result.payer` (already destructured at
`bazaar.ts:62`, used for `recordSettlement`) is the *cryptographically
authenticated* payer. `extensions.rotation.oldPayTo` is client-echoed
content — exactly as forgeable as `resource`/`extensions` already are
elsewhere in this codebase. The record method MUST require a three-way match
— `result.payer === extensions.rotation.oldPayTo === entry.ownerPayTo` —
before writing anything, or anyone could claim to be a different account's
rotation without ever having paid as them. Own test, own mutation guard.

**4. Tests for the new `tryDisplace` branch — S, mechanical.** Valid marker
→ proceeds; expired → still skipped; already-consumed → skipped; a claimed
`oldPayTo` that never actually authenticated as the payer → never recorded in
the first place (proves the three-way match in step 3).

**5. A demo script — XS.** `examples/rotate-classic.mjs`, near-copy of
`buyer-classic.mjs` with a different destination and a `rotation` extension
instead of `bazaar`. Proves a classic account needs zero new client code.

**6. Docs — XS.** A short addition to `operator-runbook.md` distinguishing
this self-service path from §1, which stays the lost-key/emergency procedure.

**Suggested PR split:** (1)+(2) together — tightly coupled, one reviewable
unit. (3)+(4) alone — small diff, but the security-bearing one, worth
reviewing without anything else in the frame. (5)+(6) last, and optional.
Total new code: a couple hundred lines across three files, roughly matched
by tests — modest next to everything else built this week.

---

*Companion: `decision-verified-binding-rotation.md` (option D, now concrete),
`proposal-operator-rotation-procedure.md` (Case 2, F — not yet written).*
