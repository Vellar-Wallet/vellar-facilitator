# Design: channel-account pool for settlement sequence-number contention

**Status: DESIGN ONLY. No implementation code. Not reviewed. Not started.**

Three decisions locked before this draft:
- **Pool exhaustion**: reject-fast, error `pool_exhausted`, `retryable: true`.
- **Sponsor account**: stays OUT of the pool — reserved for funding channel
  accounts and acting as `feeBumpSigner` only, never itself a settlement
  source account.
- **Pool size**: **N = 50**, sized for true simultaneity (not a probabilistic
  smaller pool).

Grounded in: `src/facilitator.ts`, `src/config.ts`, `src/upto.ts`,
`src/rpcstatus.ts`, `src/retry.ts`, `docs/diagnosis-settle-failures.md`,
`docs/closing-state.md`, `technical-doc.md` §7, and
`node_modules/@x402/stellar/dist/cjs/exact/facilitator/index.js` (pinned
version per this repo's `package.json` — re-verify this design's line
references on any upstream bump, since it depends on exact behavior of a
vendored package this repo does not control).

---

## 0. What `closing-state.md` adds to this design

Three things, read directly from that file, that change or sharpen what
follows:

1. **No load-test tooling exists yet.** `closing-state.md:646` states the
   existing harness "manages 6 at ~8s each," and line 760 lists **"F12 live
   demonstration | Half a day, needs N funded source accounts. The last
   control with no live evidence"** as still-open, owned work. There are no
   50 pre-funded buyer keypairs, no prior 50-concurrent run, and no existing
   result to compare against. §7's load test is being built from nothing,
   not extended from something.

2. **This design's load test IS the overdue F12 live demonstration, not a
   separate exercise.** F12 ("per-URL / per-payTo budgets") was already
   blocked on exactly this gap — `closing-state.md:646`: *"Requires one
   funded classic source account per concurrent settler — sharing one gives
   `tx_bad_seq`, and the resulting 1-success/10-failure result looks like a
   budget refusing when F12 is log-only on testnet and cannot refuse."* That
   is the identical failure mode this design fixes, described independently
   before this design existed. `closing-state.md:794` further lists **"F12
   demonstrated, or explicitly accepted as unproven in writing"** as a
   **pubnet go/no-go blocker** — so this design's load test (§7) now serves
   two purposes at once: the grant's Tranche 1 success criterion, and the
   long-standing pubnet blocker. That raises the cost of getting §7 wrong.

3. **`closing-state.md` is silent on the `upto`-scheme sponsor-sharing gap.**
   It discusses sequence contention only in the context of F12 / the `exact`
   scheme's concurrent settlers. It does not mention, and has evidently not
   yet identified, that `UptoStellarScheme` (`src/upto.ts:219`) independently
   calls `getAccount()` on the SAME `sponsorSecretKey` used elsewhere. This
   gap is not tracked anywhere else in the repo's own documentation as far as
   this design's sources show — it is carried forward here as a newly
   surfaced, explicitly unaddressed item (§6), not something already
   decided or scheduled by the team.

Nothing in `closing-state.md` contradicts the three locked decisions above;
F12's own historical target (11 concurrent in 60s) is lower than this
design's target (50, true simultaneity) — the grant sets a stricter bar than
the original control ever required, which is a reason to build the pool
properly rather than to the older, smaller number.

---

## 1. The mechanism

### Where the sequence number comes from today

`ExactStellarScheme.settle()`
(`node_modules/@x402/stellar/dist/cjs/exact/facilitator/index.js:250-384`):

```
Line 280: const signer = this.signerMap.get(this.selectSigner([...this.signingAddresses]));
Line 290: const facilitatorAccount = await server.getAccount(signer.address);
Line 291: const rebuiltTx = new TransactionBuilder(facilitatorAccount, {...}).build();
```

`TransactionBuilder`, given an `Account`, sets the new transaction's source
account and sequence number (`account.sequenceNumber() + 1`) from that
account — standard `@stellar/stellar-sdk` behavior, not something
`@x402/stellar` reimplements. The buyer never plays this role: their
authorization lives entirely inside the Soroban `auth` entry
(`sorobanCredentialsAddress`, verified at `_verify` lines 665-712), and the
code structurally forbids the buyer or the facilitator's own address from
being the transaction/operation source (lines 427-431, 454-458). **The
account whose sequence number gets consumed, on every settle, is always
whichever facilitator-configured signer `selectSigner` returns.**

`src/facilitator.ts:10` configures exactly one signer today:
```ts
const scheme = new ExactStellarScheme([sponsorSigner], {...});
```
One signer ⇒ `signerMap` has one entry ⇒ every concurrent settlement across
the whole process reads and races on the same account's sequence number.
Two settlements both reading "current sequence" before either has submitted
will compute the same "current + 1"; Stellar accepts, per source account,
exactly one transaction per sequence number — the second is rejected
on-chain as `txBadSeq`. `docs/diagnosis-settle-failures.md` measured this at
low, non-concurrent volume (1 of 10 observed failures) and correctly ruled
out shared-source contention as the *dominant* cause of everyday failures
(9 of 10 were the unrelated `TRY_AGAIN_LATER` RPC refusal). It did not, and
could not, rule out sequence contention as the failure mode that would
dominate specifically **under the concurrency this grant targets** — a
regime the existing diagnosis never tested. `closing-state.md:646`
independently confirms the same mechanism from the F12 side.

### The fix: more signers, not new @x402/stellar behavior

`ExactStellarScheme`'s constructor already accepts an array of signers and
already round-robins across them by default
(`roundRobinSelectSigner`, lines 161-164; `selectSigner` option, line 190).
**Channel accounts means passing N additional signers into that array** —
no fork, no patch, no change to the vendored package. Each channel account
is an ordinary funded Stellar classic (`G...`) keypair whose only role is
being a settlement source-account/sequence lane. With N independent
accounts, two settlements landing on different accounts read and increment
fully independent sequence counters — Stellar's sequence field is scoped
per-account, so there is no shared state to race on across accounts, only
within one.

This divides contention by N; it does not eliminate it in the abstract (two
settlements landing on the *same* channel account can still collide) — which
is exactly why sizing (§2) is a real calculation, not a round number.

---

## 2. Pool sizing: N = 50, true simultaneity

**Decision, restated: N = 50, one channel account per fully-concurrent
settlement, sized for true simultaneity — not a smaller, probabilistically-sized
pool.**

### Why 1:1 rather than fewer-with-round-robin

A Stellar account's sequence number only advances once a transaction from
that account **closes in a ledger** — roughly 5s on testnet (the same
constant `@x402/stellar` itself estimates via
`getEstimatedLedgerCloseTimeSeconds`,
`.../facilitator/index.js:141-154`, and independently cited in this repo's
own `src/retry.ts` comment: *"State changes at ledger close (~5s)"*). Within
that window, an account can have at most one settlement transaction land.
If 50 requests arrive at the same instant (true simultaneity — the harder
and more literal reading of "50 concurrent," and the one now locked), any
account shared by two or more of them is a guaranteed collision, not a
probabilistic one: both read the same "current sequence," both build a
transaction claiming "current + 1," and at most one can win.

With **N = 50**, pigeonhole guarantees zero sharing: 50 simultaneous
requests, 50 distinct accounts, one request per account, by construction —
regardless of exactly how the selector distributes them, exactly how long
each settlement's in-flight window lasts, or exactly how close together the
50 requests actually arrive. This is what makes "zero `txBadSeq` failures"
a **structural guarantee** rather than a claim that depends on load-test luck
lining up with a smaller pool's math.

A smaller N (e.g., sized via a birthday-problem-style collision estimate
against some assumed arrival spacing) was considered and rejected for this
lock: it trades a guarantee for a probability, and the grant's own wording
says "zero," not "low." The cost of provisioning 50 accounts (funding +
minimum reserve on each, all paid from the sponsor's own balance — see §5)
is small; the cost of a load test producing even one `txBadSeq` against a
smaller pool is a failed success criterion on both the grant AND the F12
pubnet blocker (§0.2) at once.

### What N = 50 does not cover

It guarantees zero collisions among 50 truly-simultaneous settlements. It
says nothing about a 51st request arriving while all 50 are still in flight
— that is pool exhaustion, handled by policy (§4), not by sizing.

---

## 3. Acquire/release protocol

`ExactStellarScheme`'s `selectSigner` option
(`.../facilitator/index.js:190`) is a real, documented extension point:
`(addrs: string[]) => string`, called once per `settle()` call, synchronous,
with **no corresponding completion/release callback anywhere in the read
source**. Plain round-robin (`roundRobinSelectSigner`, the default) cycles
by call count alone — it does not know whether an address it returned a
moment ago is still mid-settlement. Left as the default, it does **not**
give the pigeonhole guarantee §2 relies on: under real concurrency, a
naive round robin can still return an address that a still-in-flight
settlement is using, if enough other calls have interleaved to wrap the
counter back around.

**Design: a custom, stateful `selectSigner` replacing the default**, backed
by an explicit pool with three states per channel account — `available`,
`in_use`, `disabled` (the last for low-balance accounts, §5):

- **Acquire** (inside the custom `selectSigner`, called synchronously by
  `settle()`): pop one address from the `available` set, mark it `in_use`,
  return it. If `available` is empty, this is pool exhaustion (§4) — handled
  as a synchronous, immediate condition, not a wait.
- **Release**: because `selectSigner` itself has no "I'm done" hook, release
  **cannot** happen inside `@x402/stellar` — it must happen in
  `vellar-facilitator`'s own code, at the call site that invokes
  `scheme.settle(...)` (§6, `src/server.ts`). The wrapper does:
  ```
  try {
    result = await scheme.settle(payload, requirements)
  } finally {
    pool.release(acquiredAddress)
  }
  ```
  `finally`, not `try` alone — a channel account must return to `available`
  whether settlement succeeded, failed after submission, or failed before
  ever reaching the network (e.g. a verify-stage rejection that never got as
  far as `getAccount()` at all — that account's sequence was never touched
  and it must not sit falsely marked `in_use`).
- **Which address was acquired must be threaded from the custom
  `selectSigner` call through to the `finally` block.** `selectSigner`
  returns only the address string to `@x402/stellar`, not to our own
  wrapper — so the pool implementation itself must record "the last address
  this call handed out" in a way the wrapper can read back out immediately
  after calling `settle()`, scoped so concurrent settlements never read each
  other's acquired address. (This is a correctness detail for
  implementation to get right, not resolved further here — flagged so it
  is not missed: a naive "last acquired" single variable would race exactly
  like the contention this design is fixing.)

---

## 4. Pool exhaustion — reject-fast

**Locked**: when `available` is empty at acquire time, fail immediately with
a distinct error — `pool_exhausted`, `retryable: true` — rather than
queueing or blocking.

Rationale (matches the earlier design's stated lean, now confirmed):
exhaustion becomes an **observable, countable event** — a metric
(cross-references the telemetry deliverable, 1.2) an operator can alert on,
rather than a silent latency regression hidden inside a queueing delay that
would eat into the same `maxTimeoutSeconds` budget the settlement itself
needs. `retryable: true` follows this codebase's own established pattern:
`src/retry.ts` already distinguishes retryable conditions (ledger skew,
`TRY_AGAIN_LATER`) from terminal ones (`txBadSeq`, treated as non-retryable
in `src/rpcstatus.ts`) — `pool_exhausted` belongs with the retryable class,
since nothing was spent and nothing about the request itself was invalid;
the pool was simply, transiently, fully checked out. The naming follows the
existing `settle_exact_stellar_*` convention used throughout
`.../facilitator/index.js` and should read consistently alongside it in
error bodies.

At N = 50 sized for true simultaneity (§2), exhaustion under the grant's own
50-concurrent test should not occur — it is the correct behavior for the
case beyond that (a 51st genuinely simultaneous arrival, or any burst above
the provisioned pool size), not an expected outcome of the success-criterion
load test itself.

---

## 5. Sponsor account role — separate, not in the pool

**Locked**: the existing sponsor account (`config.sponsorSecretKey`,
currently the sole signer at `src/facilitator.ts:8-10`) is removed from the
settlement-source rotation entirely. Its role narrows to exactly two things:

1. **Funding channel accounts.** Each of the 50 channel accounts is funded
   from the sponsor's own balance at pool-provisioning time (a one-time
   operational step, mirroring how the sponsor account itself is funded
   today — friendbot on testnet; a funded, safeguarded balance per
   `technical-doc.md` §9 on mainnet). Ongoing balance monitoring (a
   scheduled check against a low threshold, disabling and later re-funding
   any channel account that drops below it) is new operational surface with
   no existing equivalent in this repo today — it is the natural extension
   of the telemetry deliverable (1.2), not a separate system.
2. **`feeBumpSigner`.** See §6 below — the sponsor pays every settlement's
   network fee regardless of which channel account's sequence was
   consumed, so channel accounts themselves only need the Stellar minimum
   reserve, never a fee budget.

Excluding the sponsor from the pool (rather than treating it as a 51st,
"free" lane) keeps its sequence number free for other uses that already
exist and are NOT part of this design's scope — most importantly,
`UptoStellarScheme` (§6's flagged gap), which independently uses the same
key today.

---

## 6. `feeBumpSigner` interaction

Traced precisely at `.../facilitator/index.js:316-345`: after the inner
transaction is built (from the SELECTED channel account, carrying that
account's sequence number, lines 291-303) and signed by that channel
account (line 304), **if** `feeBumpSigner` is configured, the already-signed
inner transaction is wrapped in a `TransactionBuilder.buildFeeBumpTransaction(...)`
whose fee source is `feeBumpSigner.address`, signed separately by
`feeBumpSigner` (lines 322-329), then submitted as the outer envelope
(line 346).

A Stellar fee-bump transaction carries **no sequence number of its own** —
it is purely a fee-source wrapper. **`feeBumpSigner` never touches which
account's sequence is consumed; it only changes who pays the inclusion
fee.** This is confirmed by the constructor's own doc-comment
(`.../facilitator/index.js:181-183`): *"decoupling fee payment from
sequence number management"* — precisely fee, not sequence.

**Design: configure `feeBumpSigner` = the existing sponsor signer**,
alongside the 50 channel-account signers. Consequence: channel accounts
never pay their own transaction fees, so each only needs the Stellar
minimum reserve to exist — no ongoing fee-balance tracking per account,
only the simpler reserve-floor check (§5). The sponsor's role stays
coherent: it is "the one account that pays," while the pool is "the 50
accounts whose sequence numbers get consumed" — a clean separation the
constructor was evidently built to support.

---

## 7. File-level changes

No implementation here — scope only, per instruction.

- **`src/config.ts`**: `sponsorSecretKey: string` (line 6) gets a sibling —
  a new required field for the channel-account pool, e.g.
  `channelAccountSecretKeys: string[]` (length exactly 50, per the locked
  sizing), sourced from a new env var (e.g. `CHANNEL_ACCOUNT_SECRET_KEYS`,
  encoding TBD — comma-separated or JSON array). Validation mirrors the
  existing `sponsorSecretKey`-missing pattern (lines 81-85): missing or
  wrong-length input should fail loudly at boot, not silently degrade to a
  smaller or absent pool, since a silently-smaller pool would quietly
  invalidate the §2 guarantee.

- **`src/facilitator.ts`**: `buildFacilitator()` (lines 7-35) changes at:
  1. Line 8: construct 50 additional signers from
     `config.channelAccountSecretKeys`, alongside the existing
     `sponsorSigner`.
  2. Line 10: `new ExactStellarScheme([sponsorSigner], {...})` becomes
     `new ExactStellarScheme(channelSigners, { ..., feeBumpSigner:
     sponsorSigner, selectSigner: pool.acquire })` — note `sponsorSigner`
     is passed ONLY as `feeBumpSigner`, never included in the array handed
     to the constructor as a settlement signer (§5's lock).
  3. `UptoStellarScheme` construction (lines 21-31) is explicitly **not**
     changed by this design (§0.3, §8) — flagged, not silently left as an
     oversight.

- **New module `src/channelPool.ts`**: the pool's `available`/`in_use`/
  `disabled` state, the acquire function (handed to `ExactStellarScheme` as
  `selectSigner`), the release function (called from `src/server.ts`'s
  `finally`, §3), the per-acquisition address hand-off mechanism (§3's
  flagged correctness detail), the `pool_exhausted` error path (§4), and
  the balance-monitoring/disable/re-enable logic (§5). Kept separate from
  `src/facilitator.ts` (a thin composition root today, and should stay one)
  and separate from `src/rpcstatus.ts` (a different concern — recovering
  RPC status information the vendored package discards, not managing
  account assignment).

- **`src/server.ts`**: the call site that invokes `scheme.settle(...)`
  (not yet located precisely — `withSkewRetry` call sites were confirmed
  at lines 179 and 284 via grep, but the exact `settle()` invocation itself
  was not read in full for this design) must be wrapped in the
  acquire-address-then-`try/finally`-release pattern from §3. Locating this
  precisely is implementation work, not part of this design.

- **New test file `src/channelPool.test.ts`**: unit tests for acquire,
  release, exhaustion (`pool_exhausted`/`retryable: true`), and
  disable-on-low-balance / re-enable, in isolation with mocked balances —
  following this codebase's established pattern of testing each hardening
  mechanism independently (`src/hardening.test.ts`, `src/rpcstatus.test.ts`,
  `src/retry.ts`'s `__setSkewRetryDelayForTest` seam) rather than only
  through a full end-to-end settle.

---

## 8. The `upto`-scheme gap — explicitly not closed by this design

`src/upto.ts:219` — `UptoStellarScheme` independently calls
`this.server.getAccount(this.sponsor.publicKey())`, using the **same**
`sponsorSecretKey` this design removes from `ExactStellarScheme`'s pool
(§5). Consequence: a concurrent `exact`-scheme settlement (now safely using
one of 50 channel accounts) and an `upto`-scheme settlement (still using the
sponsor account directly) do not collide with EACH OTHER any worse than
today — but multiple concurrent `upto` settlements still race on the single
sponsor sequence, exactly as `exact` settlements did before this design.

**This design's scope, matching how the task and `technical-doc.md` §7
frame "the load-hardening deliverable," is `ExactStellarScheme` only.**
`closing-state.md` does not mention this gap at all (§0.3) — it is being
surfaced here for the first time as an explicitly open item, not resolved.

Two honest paths forward, neither decided here:
- **Extend the pool to `UptoStellarScheme` in a follow-up**, giving it its
  own reserved subset of channel accounts (or sharing the same 50, with a
  combined-scheme acquire/release), sized against `upto`'s own expected
  concurrency — likely lower than `exact`'s, since `upto` is the newer,
  not-yet-widely-adopted metered-billing scheme (per
  `scf-form-response.md`'s own Tranche 2 framing), but this is an
  assumption, not a measurement.
- **Accept it as a known, documented limitation** for Tranche 1's scope,
  explicitly noting that mixed concurrent `exact` + `upto` load, or
  multiple concurrent `upto` settlements alone, can still produce
  `txBadSeq` until a follow-up closes this gap.

Recommendation: document explicitly in whatever ships (a code comment at
`src/upto.ts:219` and a line in this repo's own tracking doc, e.g.
`BUILD-PLAN.md`) rather than let it be silently rediscovered later the way
the original sequence-contention question itself was rediscovered during
this design's own research. This should be a conscious choice, made by
whoever reviews this design, not an oversight.

---

## 9. Load test plan

Two runs, in this order — **negative control first, positive control
second.** Per `docs/diagnosis-settle-failures.md`'s own established
discipline (that document's decisive test was exactly this shape: prove the
failure is real and reproducible before, and separately from, claiming a
fix), and because `closing-state.md` confirms no prior evidence exists at
this concurrency (§0.1) — there is nothing to compare a "the pool worked"
result against unless the un-pooled failure is demonstrated first, under
the same conditions, in the same test run series.

### Common setup (both runs)

- Real testnet facilitator, real testnet RPC — not a mock, per the original
  task's own instruction.
- **50 independently funded buyer keypairs**, each holding the priced
  asset, each producing its own real, separately-simulated, separately-signed
  x402 payment payload. `closing-state.md:646` confirms this exact
  requirement was already identified for F12 and never built — this is new
  setup work, not reuse of existing tooling (§0.1).
- `installRpcStatusCapture` (`src/rpcstatus.ts`) active throughout, so every
  failure's real `errorCode` (`txBadSeq` vs `TRY_AGAIN_LATER` vs anything
  else) is captured, not just a generic failure count. This distinction
  matters because `TRY_AGAIN_LATER` is a separate, already-diagnosed,
  NOT-fixed-by-this-design failure mode (§0, §1) that could appear in either
  run and must not be misattributed to sequence contention either way.
- Per-request recording: wall-clock duration (submit → confirmed/failed),
  success/failure, captured `errorCode` on failure.

### Run 1 — negative control: prove today's single-signer setup fails

Configuration: **current** `src/facilitator.ts`, one signer, no pool.
Fire all 50 buyer payloads via `Promise.all` (true simultaneity, matching
§2's sizing assumption). Expected, and required for this design to be
considered validated at all: **a nonzero count of `txBadSeq` failures.**
This is the same shape as `closing-state.md:646`'s own already-observed
"1-success/10-failure" pattern, now run at the grant's actual target
concurrency (50) rather than the smaller scale that pattern was first seen
at. If Run 1 produces zero `txBadSeq` failures, that is a signal this
design's core premise needs re-examination before Run 2 is treated as
meaningful — a clean Run 2 result would prove nothing if Run 1 never showed
the problem existed at this scale to begin with.

*(Run only in a disposable test configuration — never against the
production single-signer facilitator with real settlement side effects
beyond what the test payloads themselves already commit to.)*

### Run 2 — positive control: prove the channel pool fixes it

Configuration: `src/facilitator.ts` with the 50-account channel pool,
`feeBumpSigner` = sponsor, as designed above. Fire the same 50-buyer
`Promise.all` pattern. Required outcome:

- **Zero results with `errorCode === "txBadSeq"`.**
- **p95 latency ≤ 15s**, measured across the 50 recorded durations.

A `TRY_AGAIN_LATER` failure appearing in Run 2 is not a design failure
(that failure mode is untouched by this design, §0/§1) but must still be
reported honestly and separately, not folded into or hidden by the
`txBadSeq` count.

### Repetition

Repeat both runs at least twice, on separate testnet sessions — matching
`docs/diagnosis-settle-failures.md`'s explicit warning against quoting a
single afternoon's rate as a stable network property, and because testnet's
already-documented variability (§O-16 in `closing-state.md`: multi-minute
unreachability tails on this hosting class) means a single clean run is
weak evidence either way.

### Success criteria (restated, matching the grant's own wording exactly)

1. Negative control (Run 1) reproduces a nonzero `txBadSeq` rate under the
   current single-signer configuration, at 50 true-simultaneous
   settlements — establishing the problem is real at this scale, not
   assumed.
2. Positive control (Run 2), same 50 true-simultaneous settlements, same
   test payload construction, with the channel pool configured:
   - **Zero** `txBadSeq` failures.
   - **p95 ≤ 15s** across all 50 settlement durations.
3. Both results reproducible across at least two independent runs, with
   `TRY_AGAIN_LATER` failures (if any) reported and classified separately
   from `txBadSeq`, never merged into one failure count.

Satisfying this also satisfies `closing-state.md:794`'s pubnet blocker
("F12 demonstrated, or explicitly accepted as unproven in writing") for the
first time with live evidence, at a stricter concurrency than F12's own
original 11-in-60s target — one load test discharging two separate,
previously-open obligations.

---

## Open items carried forward (not resolved by this document)

- Exact mechanism for threading "which address was just acquired" from the
  synchronous `selectSigner` call to the `finally`-block release in
  `src/server.ts` (§3) — a correctness-critical implementation detail,
  deliberately left for implementation rather than pseudocoded here.
- Exact location of the `scheme.settle(...)` call site in `src/server.ts`
  (§7) — confirmed not-yet-located precisely.
- Whether `UptoStellarScheme` gets its own follow-up pool or an accepted,
  documented limitation for Tranche 1 (§8) — recommend a decision before
  implementation, not left implicit.
- Env-var encoding for `CHANNEL_ACCOUNT_SECRET_KEYS` (§7) — format not
  specified here.
