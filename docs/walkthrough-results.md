# Walkthrough results — 2026-08-10

Run against the deployed facilitator and seller. Reported against §6 of
[`walkthrough-wallet-spec.md`](./walkthrough-wallet-spec.md), **including the
controls that came back unproven** — a result listing only what passed is the
failure mode this exercise exists to avoid.

Every settlement below is confirmed on **Horizon**, not on the `/settle`
response. Simulation figures are marked provisional where they appear.

## Preconditions

| | |
| --- | --- |
| facilitator `/health` | `commit 17a6fbd`, `catalogSize 0`, not frozen |
| seller `/whoami` | `commit 17a6fbd`, `verifiable: true` |
| 402 vs `/whoami` | agree on resourceUrl, payTo, asset |
| deployed vs `main` | `17a6fbd` vs `5bb45aa` — **docs-only delta**, verified below |

### The build question, settled

The deployed instance ran `17a6fbd` for the whole walkthrough and only moved to
`5bb45aa` when the F3 flip restarted it. So every control below was observed
against a build that was *not* the tip of `main`, which is worth resolving rather
than asserting.

```
$ git diff --stat 17a6fbd 5bb45aa
 docs/security-audit.md | 179 +++++++++++++++++++++++++++++++++++++++++-
 1 file changed, 178 insertions(+), 1 deletion(-)

$ git diff --stat 17a6fbd 5bb45aa -- src examples package.json \
      package-lock.json render.yaml tsconfig.json .github
 (empty)

$ git merge-base --is-ancestor 17a6fbd 5bb45aa   # exit 0 — direct parent
```

**One commit, one file, docs only** — PR #23, the D-4 retraction. `src/`,
`examples/`, dependencies, `render.yaml` and CI are byte-identical, and `17a6fbd`
is a direct ancestor rather than a divergent build, so there is no possibility of
a fix present in one and absent in the other.

**No control was observed against the wrong code. Every result below stands.**
The `commit` field on `/health` — added precisely because a pre-audit build had
once been deployed unnoticed — is what made this answerable in one command
instead of a guess.

## PROVEN LIVE

### F11 Layer 2 — ownership verification through the settle path

**First time this has ever succeeded in production.** Settlement
`8c0d9682aa33444731e5b25b51f7f58faccd93f038aa8f9cea9594cc185399f7`
(Horizon: `successful: true`, `fee_charged` **22,579**, `fee_account` `GBUCR6H2…`)
produced a catalog entry with:

```
resource        https://vellar-seller-demo.onrender.com/quote
ownerVerified   true
statsSource     observed
```

Until the D-3 fix the seller advertised `localhost`, which the SSRF guard rejects
before opening a socket — so this path had never completed end to end.

### F11 Layer 1 — TOFU binding refuses a squat

The attacker client differs from `buyer.mjs` in **exactly one line** (`req.payTo`
redirected); signature shape, credential type and expiration window are
identical. It declared the victim's URL with its own payTo, posted directly to
`/settle` — the real threat model, bypassing the seller.

```
/settle          200  success: true
Horizon          9726d45ea4055d7bc68dc1c081b5f6d7f9108f6d00a94ea18ad67e52623e497a
                 successful: true   fee_charged 22,579   sponsor-paid
accepts before   [GBJX3E4G…]
accepts after    [GBJX3E4G…]        ← unchanged
```

**The payment went through and the catalog refused it anyway.** That contrast is
the evidence; a refusal alone would be indistinguishable from a failed payment.

### G-4 — settlement stats may only be moved by the bound owner

Measured either side of the squat above:

```
settlements   3 -> 3      uniquePayers 1 -> 1      observed 3 -> 3
```

A rejected upsert credited the victim with nothing.

### G-3 — canonical resource key

Two settles with different query strings
(`867632de…`, `0fb01358…`, both `successful: true`, 22,579 each):

```
total entries   1
key             https://vellar-seller-demo.onrender.com/quote     (no query string)
```

## NOT PROVEN, with reasons

### F12 — per-URL budget: NOT REACHABLE with this harness

`perUrlMax` is 10 per rolling 60s, so the trigger needs **11 settles inside 60
seconds**. Measured settle rate is **~8s** end to end (402 → build → sign →
simulate → submit), giving a **maximum of 6 settles in any 60s window**.

A first attempt at 12 concurrent settles produced 1 success and 10 failures —
**not** F12 refusing (the policy is log-only on testnet and cannot refuse), but
all twelve sharing one `SIM_SOURCE_ACCOUNT` and therefore one sequence number.
That is a harness artefact, recorded so it is not mistaken for a control.

**Left unproven rather than approximated.**

#### W-1 — the harness limit is a finding, not just a gap

The trap here is worth stating plainly, because the first result *looked like a
pass*:

> 12 concurrent settles → **1 success, 10 failures.** Read casually, that is
> exactly the shape of a per-URL budget admitting a few and refusing the rest.

It is not. **F12 is log-only on testnet — it cannot refuse anything.** Every
failure was `tx_bad_seq`: twelve processes shared one `SIM_SOURCE_ACCOUNT`, so
they shared one sequence number, and eleven of the twelve built on a sequence
that was consumed before they submitted.

Had that gone into the record as "F12 refused 10 of 12", it would have been a
**fabricated pass** — a control credited for an effect produced entirely by the
test rig, on a network where the control is inert. This is the precise failure
mode the evidence protocol exists to catch, and it is the second one caught in
this engagement (the first being the retracted D-4 fee figure).

The tell, for next time: **the control's own configuration refutes the reading
before any transaction is examined.** `settlementPolicy` is constructed with
`enforce: false` on testnet — a refusal it cannot issue cannot be the
explanation for a refusal you observe.

#### W-2 — what a working F12 demonstration actually requires

Whoever revisits this should not have to rediscover the collision:

1. **N distinct funded classic source accounts**, one per concurrent settler —
   *not* one shared account. This is the whole finding. `SIM_SOURCE_ACCOUNT` is
   used to simulate and to supply the sequence number; sharing it serialises the
   harness and then breaks it. Friendbot funds testnet accounts, so N accounts
   costs nothing but a loop.
2. **N ≥ 12** for a `perUrlMax` of 10 — 11 to trip it, one more to confirm the
   refusal is not the tail of a rate problem.
3. **All N inside one 60s window.** At the measured ~8s per settle, sequential
   execution tops out at 6 per window and *cannot* reach the threshold no matter
   how long it runs. Concurrency is mandatory, which is why (1) is mandatory.
4. **Decide up front which of the two things you are demonstrating — there is no
   enforce flag.** Enforcement is keyed off the network alone
   (`policy.ts:112`, `network === "stellar:pubnet"`); `STELLAR_NETWORK=pubnet` is
   the only switch, and there is deliberately no testnet override. So either:
   - **the accounting** (what testnet can show): assert on the structured log
     `{ payTo, wouldReject }` emitted at `server.ts:216-219` — the settle still
     proceeds, but the facilitator states which limit production would have
     tripped. This is the honest testnet demonstration; or
   - **the refusal** (the 503): run a local instance with
     `STELLAR_NETWORK=pubnet` pointed at testnet RPC, which makes the policy
     enforce while the money stays fake.

   Asserting on refusals against the deployed testnet instance will always fail,
   because it has no refusal to give.
5. **Distinguish the refusal from a failure.** A tripped F12 returns HTTP 503
   with `error: "settlement_refused"`. A sequence collision returns a submission
   error with `tx_bad_seq`. Assert on the *body*, never on the success count.
6. **Confirm the non-refused settles on Horizon**, so the denominator is
   settlements that really happened rather than requests that were sent.

A demonstration that skips (1) will reproduce the 1-success/10-failure result
and, unless it reads the failure bodies, will read it as a pass.

### G-1 — re-verify on restart: NOT DISTINGUISHABLE

Entries do not survive a restart (no persistent disk), so after any restart the
next settle is a *first* catalog, which would verify regardless. G-1's specific
path — a **restored** entry recovering `verifiedOwner` — cannot be separated from
first-catalog verification on this deployment. It becomes testable with durable
storage.

### F3 — balance guard: PENDING

Requires raising `SPONSOR_HARD_FLOOR_STROOPS` above the sponsor's balance. Not
run; awaiting the dashboard change and an immediate revert.

## Observations worth keeping

**Defence in depth, unplanned.** The first squat attempt went *through the
seller*, and the seller's own x402 resource server refused the mismatched payTo
before the facilitator saw it — it compares the payTo in the presented payload
against the one it advertised in its own 402. Nobody designed that as a security
control; it falls out of the seller checking that it is being paid what it asked
for.

**This narrows the F11 threat model.** A squat cannot be mounted *through* a
well-behaved merchant — the merchant rejects the mismatch before a settlement
request is ever made. It can only be mounted by a client that talks **directly
to `/settle`**, constructing `paymentRequirements` itself. So the attacker is not
"anyone who can pay for the resource"; it is specifically someone willing to
bypass the merchant and address the facilitator directly.

Two consequences, and they pull in opposite directions:

- **Smaller population.** The casual case — a client that pays normally but names
  a different payTo — does not reach the facilitator at all.
- **No weaker requirement on F11.** `/settle` is a public endpoint and the bypass
  is a few lines (the attacker client here differs from `buyer.mjs` by exactly
  one line, plus posting to a different URL). The merchant check is defence in
  depth, **not** a layer F11 may lean on: it lives in *the seller's* code, which
  the facilitator neither ships nor controls, and a merchant that omits it is
  still protected only by F11.

Recorded so the narrowing is not later mistaken for redundancy that would justify
relaxing F11.

**Three of eleven sequential settles failed** with an empty-body 402 from the
seller (the reason is swallowed by `body ?? {}`). **Cause not established, and it
stays that way** — the protocol says unexplained beats attributed.

*Hypothesis, to be tested only if it recurs:* the same RPC pathology that
produced the retracted 26M fee figure. What makes it worth writing down is the
timing — both were seen inside the same session against the same testnet RPC, and
the 26M reading was itself an RPC returning a value that the chain then refuted.
A simulate call that comes back wrong (rather than failing outright) would
produce exactly this: a settle that is refused before submission, with no
on-chain trace to interrogate afterwards.

**This is a lead, not a finding.** Nothing here excludes an ordinary transient,
and one correlated observation across two symptoms is not evidence. What would
turn it into a finding, if it recurs:

- log the swallowed 402 body (`body ?? {}` is hiding the reason — that is a real
  and separate defect, and the cheapest thing to fix first);
- capture the simulation's `minResourceFee` on the failing attempts and compare
  it against the 22,579 that every settled transaction actually charged;
- re-run against a second RPC provider — if the failures do not follow, the
  provider is implicated; if they do, our own path is.

Filed as a hypothesis so a future recurrence has somewhere to land, and flagged
as unproven so it cannot be cited as a cause.

**Fee reality.** Every settlement charged **22,579 stroops** — 4.5% of the
500,000 ceiling. This is the on-chain refutation of the retracted D-4, and unlike
a simulation it carries a hash.

## Totals

12 settlements recorded against the entry (11 buyer + 1 from the concurrent
attempt); the squat correctly contributed none.
