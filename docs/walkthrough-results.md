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
| deployed vs `main` | `17a6fbd` vs `5bb45aa` — **docs-only delta**, no executable difference |

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

To demonstrate F12 would need several funded source accounts settling in
parallel. **Left unproven rather than approximated.**

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
before the facilitator saw it. The direct-to-`/settle` path was needed to reach
F11 at all — so a squat must bypass the merchant entirely, which is a smaller
attack surface than assumed.

**Three of eleven sequential settles failed** with an empty-body 402 from the
seller (the reason is swallowed by `body ?? {}`). Cause not established.
Per protocol they are recorded as unexplained rather than attributed — most
likely transient RPC, which is the known condition on this network.

**Fee reality.** Every settlement charged **22,579 stroops** — 4.5% of the
500,000 ceiling. This is the on-chain refutation of the retracted D-4, and unlike
a simulation it carries a hash.

## Totals

12 settlements recorded against the entry (11 buyer + 1 from the concurrent
attempt); the squat correctly contributed none.
