# Decision needed — rotating a verified binding, and what the latch actually protects

**2026-08-14. Options set out, none chosen. The trigger is the demo-listing
incident (`diagnosis-demo-listing.md`), but the question is general and it will
recur with real merchants.**

---

## The finding that forces the question

The one-way latch (`everVerified`) makes a binding permanently non-displaceable
once its owner has been proven **once**. It was built to close 2C: a domain that
changes hands must not be able to steal a verified binding, because after a
takeover the new controller can present exactly the proof displacement asks for
— current control of the endpoint.

That reasoning still holds. But the latch encodes an assumption that the
incident falsified: **that "verified" means currently-verified, when it can mean
once-verified.** `GBJX3E4G…` proved ownership when it genuinely controlled the
demo endpoint. The seller's `payTo` then legitimately rotated. The proof
persisted; the reality it described did not. Now nothing in-band can move the
binding — not settlements (three refused, correctly), not the timeout retries,
not the sweep we declined to build. The only path is runbook §1.

## The constraint everything below must respect

Write out the three situations the system can face at a verified URL whose 402
now names a different address:

| Situation | What the new claimant can present |
| --- | --- |
| **Hostile takeover (2C)** — domain bought or endpoint compromised | Current endpoint control |
| **Lost-key rotation** — legitimate merchant, old wallet key gone | Current endpoint control |
| **Voluntary rotation** — legitimate merchant, old key still held | Current endpoint control **and the old key** |

The first two rows are **observationally identical**. That is not an
implementation shortfall; it is the information actually available. Any
mechanism that recovers the lost-key case in-band recovers the takeover case
too, because the system cannot tell them apart. Every option below is a
different way of living with that fact.

## The options, and what each concedes

### A — Keep the latch as is; runbook §1 is the rotation path

The status quo, chosen deliberately rather than by default.

- **Keeps:** 2C fully closed. The property "a verified binding never moves
  without a human" is simple to state and audit.
- **Concedes:** no in-band rotation, ever, for any reason. Every legitimate
  rotation — voluntary or lost-key — requires the operator, which makes the
  DB-credential holder the de-facto rotation authority (F6 already names this).
  Stale latched bindings accumulate with no self-heal, each one in the
  contradictory state the demo entry is in now: served unverified, enforced
  verified, both permanently.

### B — Remove the latch; latest proof wins

Included for completeness, not as a live candidate.

- **Keeps:** every legitimate rotation self-heals, including lost-key.
- **Concedes:** 2C reopens wholesale — buy a lapsed domain, present its 402,
  own its verified binding and its settlement history. The audit refused
  exactly this, and the refusal was right.

### C — Time-decay the latch

`everVerified` expires after N days without re-proof; re-verification on the
bound owner's settlements refreshes it.

- **Keeps:** stale bindings eventually become displaceable; abandoned URLs
  self-heal without an operator.
- **Concedes:** the patient attacker wins. Takeover protection is weakest
  exactly when the merchant is absent — which is when takeovers happen. A
  domain squatter's cost changes from "impossible" to "wait N days", and any
  N is arbitrary: long enough to be safe is long enough to not help rotation.
  Also couples protection to settlement frequency, so low-traffic merchants
  (the ones least likely to notice a takeover) decay first.

### D — In-band voluntary rotation, anchored to the old key

Verified→verified displacement allowed **only** with proof of the old key:
the currently-bound `payTo` signs an authorization naming the successor —
delivered as a challenge extension, or as an on-chain action from the old
account (a data entry or a marker payment), which needs no new API surface.

- **Keeps:** 2C closed — endpoint control alone still moves nothing; the
  anchor is cryptographic continuity, which a domain buyer does not have.
  Voluntary rotation becomes self-service.
- **Concedes:** the lost-key case — the demo's actual case — stays
  operator-only, per the constraint above; no honest mechanism can do better.
  Adds protocol surface and signature-verification code to a security-critical
  path, and the rotation flow itself becomes something to audit.

### E — Put the latch on the wire, honestly (orthogonal; combinable with any)

Expose the durable state distinctly — e.g. `trust.ownershipProvenAt`
(timestamp) alongside the ephemeral badge — so the state that governs
displacement is readable rather than inferable only from a DB column or a log
line.

- **Keeps:** the next diagnosis costs one API call instead of three
  settlements. Consumers can distinguish "proven, currently confirmed" from
  "proven once, badge pending" — today both read `ownerVerified: false` after
  a restart. The recorded reason for keeping verification state off the wire
  was that *attacker-forceable* signals must not be served; the latch is not
  forceable (it sets only on real proof), so exposing it read-only does not
  breach that rationale — but this argument must be made against the recorded
  decision, not slid past it.
- **Concedes:** nothing structural, but a timestamp invites misreading as
  freshness ("proven 2026-08-11" still reads as an endorsement). Naming and
  docs carry real weight here, and this option fixes diagnosability, not
  rotation — on its own it leaves the demo entry exactly where it is.

### F — Keep A, but make runbook §1 cheap and safe enough to be routine

Scripted, logged, two-person rotation with the evidence requirements written
down (what the operator must verify before editing a binding).

- **Keeps:** the latch untouched; the operator path stops being an emergency
  procedure and becomes an administrative one.
- **Concedes:** centralization stays and is now load-bearing by design. The
  operator's judgment substitutes for the missing in-band evidence — which is
  honest, since the missing evidence genuinely does not exist, but it must be
  resourced: an "actually available operator" is currently an assumption, not
  a rota.

## What the incident adds to each option's weighing

- The demo entry shows the **cost of A compounding**: the G-11 dedup preferred
  the verified entry when `/quote/` and `/quote` collapsed to one key — each
  rule individually correct, jointly guaranteeing the immovable entry is the
  one that survives.
- The misdiagnosis shows **E's value is not hypothetical**: three settlements
  were spent because the discriminating state was invisible everywhere except
  a DB column and a not-yet-deployed log line, behind a wire field whose name
  promised the latch and reported the badge.
- The lost-key row shows **D is not a full answer**: it would not have saved
  the demo. Anything sold as "the rotation fix" must say which rows of the
  table it actually covers.

## If we do nothing — the interim position, stated as one

**Adopted 2026-08-14, deliberately.** The decision above waits for a real
merchant to make it concrete rather than being settled on a demo entry. Doing
nothing is itself a position, so here is exactly what it means:

- **The demo entry stays stale indefinitely.** Bound to `GBJX3E4G…`,
  advertising a dead asset, no badge — and there is no passive expiry: the
  latch and the F3 tombstone both survive eviction by design, so even
  `MAX_ENTRIES` pressure does not clear it. It changes only when an operator
  runs runbook §1, and doing that *before* the decision would spend the one
  concrete instance this question currently has.
- **A real merchant hitting this gets runbook §1.** Their payments still
  settle — nothing on the payment path is affected. Their catalog entry shows
  the old `payTo` and no badge until an operator intervenes.
- **Detection exists on the operator side only.** The #57 log line —
  `binding was PROVEN once and is permanently non-displaceable` — is the
  alarm; it fires on every settlement that would have displaced. Grep for it.
  **Nothing tells the merchant.** They discover the state by reading their own
  catalog entry, and their remedy is contacting the operator. That asymmetry
  is the real cost of the interim position, and it is accepted, not overlooked.
- **What forces the decision:** a real merchant case (the intended trigger),
  or `ownerVerified` becoming load-bearing — pubnet blocker 4 already conditions
  go-live on the badge's dependability, and a badge that can be silently stuck
  false for a rotated merchant fails that bar.
- **What this does not pre-decide:** any option above. In particular, O-18's
  honesty fix (making the once-proven state visible on the wire) is
  independent of rotation and stays available without touching the latch.

## Not decided here

No option is selected. A and F differ only in investment; D and E are additive
to either; C trades the latch's core guarantee for self-healing; B is recorded
as refused. What is decided: the question is real, recurs with real merchants,
and must not be resolved implicitly by whichever PR touches the latch next.
