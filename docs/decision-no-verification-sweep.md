# Decision — no verification sweep, and what would change that

**2026-08-14. Considered, designed, refused. The design is kept because the
reasoning survives the refusal: if free-tier hosting stops being the constraint,
this is the starting point rather than something to re-derive.**

Ownership verification is triggered by settlement and nothing else. That
coupling has now caused two failures — the demo listing that could never be
verified ([O-15](./closing-state.md)), and the displacement that recovered
nothing ([`diagnosis-demo-listing.md`](./diagnosis-demo-listing.md)). The
obvious fix is to re-verify on a timer. This documents why we are not.

---

## What was already refused, and why

`security-audit.md` records the original decision:

> **Settle-triggered only — no background prober.** A timer that re-probes would
> grant `verified` on *current domain control* with no contemporaneous payment,
> which is the same inference refused for automated rotation (runbook §1). Every
> fetch stays anchored to a real settlement. **The price, accepted explicitly:** a
> zero-traffic resource stays unverified.

The objection is **semantic**, not about traffic volume. `verified` is supposed
to mean *someone paid this resource, and the resource names its bound owner*. A
timer would make it mean *this domain currently names this address*, which is a
weaker claim wearing the same badge.

## Why a timeout-only sweep clears that objection

This is the part worth keeping. A narrowly-scoped sweep is **not** the refused
prober, and the difference is structural rather than a matter of degree.

The refused prober asks a **new question** on a schedule: "does this domain still
name this address?" — with no payment behind the answer.

A timeout-only sweep asks **nothing new**. It finishes an attempt a settlement
already earned: the payment happened, and we simply failed to read the answer
within 3 seconds because the host was asleep. The entitlement comes from the
settlement; the timer governs only *when we retry a failed read*.

That holds only if enforced structurally, which makes the eligibility rule the
whole design:

- Eligible **only** if the entry's last verdict is `timeout`. Never
  `unverifiable`, never `mismatch`, never "not yet probed".
- Eligibility **expires** — a pending timeout is good for ~10 minutes from its
  triggering settlement, then the entry drops out and waits for the next payment.
- Nothing can enter the sweep without a settlement having placed it there.

That is a bounded verification *window opened by a payment*, not a standing
timer. It is materially different from what was refused, and the difference is
defensible.

## How it would interact with the cooldowns

They do not conflict, because the cooldowns were already shaped to fit. The
sweep respects all of them, and it works precisely because `timeout` cools down
in **60s** while `mismatch` keeps **24h** and `unverifiable` keeps **15m**.

A 60–120s cadence therefore fires for exactly the case the sweep exists to fix,
and can never re-probe a mismatched resource — that entry is both ineligible
*and* cooling down for a day. The two mechanisms are complementary by
construction rather than by care.

## What would bound it

| | |
| --- | --- |
| Interval | 60s |
| Entries per cycle | ≤10, oldest pending first |
| Concurrency | 3 |
| Attempts per window | ≤3, then the entry ages out |
| Window | 10 minutes from the triggering settlement |
| Cost per cycle | ≤10 outbound requests, each capped at 3s → ≤10s wall time |
| Worst case outbound | 600 probes/hour globally |
| **Amplification per attacker settlement** | **2 → 5 probes** |

That last row is the real price. Under TOFU the bound owner is whoever settled
*first*, not whoever controls the endpoint — so an attacker who settles once
against a victim's URL can already cause probes at it. Today one settlement buys
2; with the sweep it buys 5. Bounded and payment-gated, but a 2.5× increase in
the exact vector the audit already had to correct itself about once.

## Why it is refused anyway

Not the amplification. Three reasons, in order of weight:

**1. It does not fix the problem it exists for.** [O-16](./closing-state.md):
`vellar-seller-demo` returned nothing to a 200-second request, then nothing to a
further 60-second one, then answered in 2.9s. A 10-minute window with 3 attempts
would have failed on that run too. The sweep buys partial coverage of a symptom
whose cause is hosting.

**2. The case it rescues is mostly ours.** A merchant with enough traffic to care
about a badge is warm, and the settle-triggered path already works for them. The
resources this rescues are sleeping free-tier demo sellers.

**3. It contradicts a stated posture for a partial win.** `operator-runbook.md`
tells operators plainly that *"nothing runs on a timer"*. Adding a scheduler,
pending state, shutdown handling and an outbound-probe budget — to partially fix
a problem it cannot fully fix — is a bad trade.

## What was done instead

The cold-start retry in `ownership.ts` went from one attempt to three (45s, then
120s). No scheduler, no pending state, no eligibility rules: the retries belong
to the settlement that spawned them, so **the payment anchor is preserved by
construction rather than by a rule someone can later relax.** Amplification goes
2 → 4, slightly *below* the sweep's 5, and it covers the measured 31–45s common
case entirely.

Its limits are stated at the code, not only here: the task dies with the
process, and it never helps a resource whose payer does not settle again.

## What would change this decision

Any one of these, and the design above is the starting point:

- **The hosting constraint goes away.** On a tier that does not spin down, the
  cold-start case largely disappears — and with it reason 1, which is the
  deciding one.
- **Real third-party merchants depend on the badge.** Reason 2 assumes the
  affected resources are our own demos. That stops being true the moment someone
  else's revenue depends on `ownerVerified`.
- **`verified_only` becomes load-bearing.** It is inert today (the verdict
  service is deployed nowhere), so an incomplete verification set costs little.
  If agents start filtering on it, completeness becomes a product requirement
  rather than a nicety.
