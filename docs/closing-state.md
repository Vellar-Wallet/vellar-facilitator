# vellar-facilitator — closing state

**As of 2026-08-11, against merged `main` (`d6404e4`).** 323 tests passing, 3
skipped (the opt-in live gate), typecheck clean, CI gating every PR.

**Everything is on `main`, verified by content rather than by status**
(`node scripts/verify-merged.mjs 35 36 21 22` → 4 landed). 327 tests passing.

One thing is still outstanding: a **deploy**. G-14 is a live hijack path, `main`
has the fix, and the running instance does not until the facilitator is
redeployed.

---

## 1. Findings — final status

Statuses mean what they say. **Closed-by-test**: a test fails if the fix is
reverted, and the mutation that would break it has been run. **Closed-by-doc**:
the behaviour is deliberate and recorded; there is nothing to fix. **Relocated**:
the risk still exists in a different place. **Open**: still true.

### Original audit — F1–F12

| ID | Finding | Status |
| --- | --- | --- |
| **F1** | Stored prompt injection via catalog content | closed-by-test |
| **F2** | Unauthenticated sponsor drain | closed-by-test |
| **F3** | Catalog resource exhaustion, non-atomic persistence | closed-by-test — atomicity is now a transaction, not a temp-and-rename |
| **F4** | Trust resolver integrity | closed-by-test |
| **F4-ts** | Verification API never deployed | **external** — blocked on the wallet repo's M5 attestor chain |
| **F5** | Settle/confirm reconciliation | **deferred** — integration-level |
| **F6** | Storage as a blind-cast trust boundary | **RELOCATED, not closed** — from "anyone who can write the file" to "anyone with database credentials". Higher bar, auditable, but reachable from the network if the token leaks |
| **F7** | Baseline hardening gaps | closed-by-test, **live evidence** |
| **F8** | Unvalidated operator-supplied URLs | **deferred** — operator-supplied, not attacker-supplied |
| **F9** | Supply chain and ungated deploy | closed-by-test |
| **F10** | Secrets | informational. **F10-op** (a live key in `.env.recording`) closed — signer removed on-chain and confirmed `null` |
| **F11** | Resource-URL hijack / payment redirection | closed-by-test, **both layers proven live** |
| **F12** | Spend controls throttle honest load, not a funded attacker | closed-by-test, **never demonstrated live** — see §4 |

### Re-audit — RA-1…RA-14

| ID | Finding | Status |
| --- | --- | --- |
| **RA-1** | SSRF guard IPv6 bypass | closed-by-test |
| **RA-2** | DNS-rebinding TOCTOU | closed-by-test |
| **RA-3** | Spend backstop skippable via empty `payTo` | closed-by-test |
| **RA-4** | Rate limit spoofable behind the proxy | closed-by-test |
| **RA-5** | Load path weaker than ingest | closed-by-test |
| **RA-6** | Verification-API download unbounded | closed-by-test |
| **RA-7** | Resource hygiene | closed-by-test |
| **RA-8** | Zero-cost spend-ceiling exhaustion | closed-by-test |
| **RA-9** | `verifiedOwner` forgeable from storage | closed-by-test, **observed live** — after the restart the badge came back `false` exactly as designed |
| **RA-10** | `DiscoveryResource.type` unsanitized | closed-by-test |
| **RA-11** | Ingest and load kept in sync by hand | closed-by-test |
| **RA-12** | Decorative tests | closed-by-test — and see §3, it recurred in new forms |
| **RA-13** | Forged settlement stats are unverifiable | closed-by-doc, **observed live** — `statsSource: persisted`, `observed: 0` after the restart |
| **RA-14** | NAT64 / 6to4 / IPv4-translated prefixes | closed-by-test |
| **RA-14r** | RFC 6052 non-`/96` NAT64 offsets | **deferred** — not reachable in this deployment |

### Gaps found while reviewing — G-1…G-14

| ID | Finding | Status |
| --- | --- | --- |
| **G-1** | Ownership verification lost on restart | closed-by-test, **proven live** — and only provable once storage was durable |
| **G-2** | A bound URL has no `payTo` rotation path | **half closed.** Displacement handles the *unverified* case automatically (**proven live**); rotating a *verified* binding stays manual, deliberately |
| **G-3** | Spend policy keyed raw, catalog keyed canonical | closed-by-test **at the policy layer only**. Its live evidence is **downgraded** — see §3. The catalog half was still broken until G-11 |
| **G-4** | Settlement stats writable by anyone | closed-by-test, **proven live** |
| **G-5** | Empty-`accepts` entry loads unclaimable forever | **closed** — the `accepts[0]` derivation that created it no longer exists |
| **G-6** | `MAX_ENTRIES` not enforced on the load path | **closed** — `ORDER BY … LIMIT ?` |
| **G-7** | Bootstrap-derived bindings never persisted | **closed** — the hatch it existed for cannot exist with one database |
| **G-8** | Tombstone cap is a one-way freeze with no reset | **open** — policy. Bounded ~2 orders of magnitude tighter by the sponsor guard than by the cap, but 5.7× thinner than originally documented |
| **G-9** | `verified_only` ignored with no trust resolver | **open** — not reachable; `server.ts` always constructs one |
| **G-10** | Spend ceiling throttles honest throughput **22× earlier than sponsor exposure requires** | **open — pubnet tuning.** Accounting uses the 500,000 estimate against a measured 22,579 charge, so the ceiling refuses the 101st settle having spent ~0.23 of the 5 XLM it names. Fails safe; deliberately unchanged |
| **G-11** | One resource, several canonical keys | closed-by-test — fixed as a family, and it surfaced the class in §3 |
| **G-12** | Bindings proven before displacement load as displaceable | **open, self-closing.** One window per binding; recorded in runbook §1 |
| **G-13** | Error bodies non-conformant with the x402 schemas | closed-by-test |
| **G-14** | **payTo identity split — whitespace hijack** | closed-by-test. **See §2** |

### Deployment findings — D-1…D-4

| ID | Finding | Status |
| --- | --- | --- |
| **D-1** | Seller had a hard boot dependency on the facilitator | closed — warm + bounded backoff. The upstream half (`@x402/core` retries 429 but not 502) is unfixed and not ours |
| **D-2** | A load-shedding control shed the traffic that would have recovered the system | closed-by-doc |
| **D-3** | A hardcoded log line imitating a real defect | closed-by-test — `/whoami` makes advertised state queryable |
| **D-4** | The 26M fee | **RETRACTED.** It never existed; it was a stale RPC reading. Survives as the methodological finding in §3 |

---

## 2. G-14 — payTo whitespace hijack — **Medium** — closed-by-test, **not yet deployed**

Given its own entry because it is exploitable, it is invisible in the output, and
nobody scanning for real vulnerabilities should have to read a methodology
section to find it.

**The defect.** `payTo` had two independent derivations. `policyBucketKey`
(`server.ts`) trimmed it and capped it at 128 characters. The catalog compared
the raw string. So `"G… "` and `"G…"` were **one rate-limit bucket and two
catalog identities**.

**Attack path.** No special position required — any party who can settle:

1. Attacker settles a payment declaring the victim's resource URL, with
   `paymentRequirements.payTo` set to **the victim's own address plus a trailing
   space**. `payTo` is client-supplied metadata; the on-chain destination is a
   separate field, so the attacker pays whoever they like.
2. TOFU binds the URL to `"GVICTIM… "`.
3. `/discovery/resources` now shows what **renders identically** to the victim's
   address. Nothing on screen distinguishes it.
4. The victim settles with their real, unpadded address. It is **not bound** —
   different string — so every settlement is refused: no `accepts` update, no
   stats, no ownership.

**Impact.** Denial of the victim's own URL, plus an entry that misrepresents who
owns it to every discovery consumer. **Not theft**: an agent paying the padded
address would send to a malformed destination, which fails rather than
misdirects. That is what holds this at Medium rather than High.

**Why it went unseen.** Each derivation was tested against its own definition and
both passed. No input with surrounding whitespace was ever tried, so the two
never disagreed in any test or any live run.

**Fix.** One exported derivation (`BazaarCatalog.canonicalPayTo`) called by both
sites; an unusable payTo is refused rather than bound, because a binding nobody
can ever match removes the URL from its owner permanently. Pinned by
`identity.agreement.test.ts`, which runs both sides over one corpus.

**Residual.** Pre-#35 bindings created this way persist until displaced.
Displacement recovers them — the victim's endpoint names their clean address, so
they can prove ownership and take it back — which is only true because
displacement shipped first.

---

## 3. Evidence lessons — the register

The most transferable thing this engagement produced, and it does not belong
scattered across findings. Each entry is a mistake that was made, not a principle
that was admired.

### 3.1 The artifact lies before the system does

`/health` reported healthy while running a build from before the audit. A
seller's boot log printed `localhost` while its 402 carried the public URL. A
`str.replace()` reported success while changing nothing. **In every case the
artifact describing the system was wrong before the system was.** The response is
to check the artifact against something it cannot fabricate: `commit` on
`/health`, `/whoami` for advertised state, an anchor assertion for a replace.

### 3.2 A non-200 is ambiguous, and the failure mode is a fabricated pass

A refusal and an infrastructure failure look identical from outside. So a control
is only proven when **the thing it guards actually happened and was still
refused**: the F11 squat is evidence because the payment settled on-chain and the
catalog rejected it anyway. A refusal alone proves nothing.

### 3.3 A simulation has no arbiter (D-4)

A simulated fee of 26,222,858 stroops was reproduced four times in one window and
was never real. Reproducibility within one process is not confirmation; only a
settled transaction is. **Any figure without a hash is provisional** — and the
corollary, learned later: some quantities *cannot* carry one (an unsubmitted bid
leaves no chain record), so say which kind you have at the point of use.

### 3.4 `String.replace()` no-ops silently — twice

| | When | Cost |
| --- | --- | --- |
| 1 | 2026-08-10 | Doc sections silently dropped from three merges; GitHub's squash was blamed for days |
| 2 | 2026-08-11 | Two mutations reported as **surviving** that had never executed |

Both caught by suspicion rather than process, which is why the check is now
structural: `scripts/mutate.mjs` **aborts** on an absent *or ambiguous* anchor and
exits non-zero, and `mutations/harness-selftest.json` is a deliberately wrong
anchor that must always abort. **A verification step that cannot fail loudly is
not a verification step.**

### 3.4b Content was reported merged and was not there — five times

| | PR | What was lost |
| --- | --- | --- |
| 1–3 | #6, #9, #13 | Doc sections; a silent `replace()` no-op, blamed on GitHub's squash for days |
| 4 | #23 | The D-1…D-3 bodies, which had never landed |
| 5 | #34 | G-13 and G-14 — **merged into a branch that had been squash-merged 17 minutes earlier** |

**Every catch was incidental**: a test count that looked wrong, a PR title in a
list, a grep run for another reason. Five incidental catches is not a process.

`scripts/verify-merged.mjs <pr>...` now asserts a merged PR's **content** is on
main, and is run after every merge. Note what it deliberately does *not* do:
`git merge-base --is-ancestor <head> main` is useless here, because a squash
rewrites the branch and the head SHA is never an ancestor — that check fails
identically for a healthy merge and for #34, so it distinguishes nothing. The
script checks the base branch, provenance on main, and whether the PR's
distinctive added lines are actually present. `--selftest` runs it against #34,
which must always fail; if it ever reports LANDED, the check has regressed.

### 3.4c Documentation describing behaviour a shipped change removed

Same shape as the seller's hardcoded `localhost` boot log and the
`bindLoadedEntry` comment that described a path which did not exist — **but in
the highest-traffic location in the repository**, the README a developer reads
first.

It said: *"an empty catalog after an idle period is expected — not a fault"*,
because spin-down destroyed the container's filesystem. True when written. False
the moment durable storage shipped — the catalog now survives, verified across a
42-second cold start. So the README was **telling a developer that a symptom is
normal when it had become a signal that something is wrong**, which is worse than
saying nothing: it actively stops the investigation that would find the fault.

**The sweep after the change was partial, and one stale claim was the tell.**
Checking the rest found more, all of it in documents read as current instruction
rather than as history:

- **runbook §1** — I rewrote its SQL steps and left the preamble telling the
  operator to get "shell access to the instance and its persistent disk" and stop
  the service before editing "the ownership file". My own partial sweep, three
  days after writing the fix.
- **runbook §2** — an entire migration procedure for `CATALOG_OWNERSHIP_BOOTSTRAP`,
  a flag that no longer exists, describing files that no longer exist. **Deleted
  rather than banner-ed**: under pressure an operator reads the steps, not the
  disclaimer above them.
- **runbook §3, §5** — instructions to delete "the ownership file", and the same
  false "empty catalog is expected" claim.
- **guide.md** — a startup command setting `CATALOG_FILE`, which is now ignored
  with a warning.

**The rule:** a change that removes a behaviour is not finished when the code
lands. Grep the docs for the vocabulary of the thing you removed — the *file*,
the *flag*, the *disk* — and treat every hit in an instructional document as a
defect. Hits in dated records (briefs, walkthroughs, decision logs) are correct
and should stay; they describe what was true when written.

### 3.4d A status that reads as a pass because nothing ran

Retargeting PR #40 from a squashed-away base to `main` left it showing
**`MERGEABLE / CLEAN` with no checks at all**. `ci.yml` triggers on
`pull_request` against `main`, and *changing a PR's base does not re-emit that
event* — so the PR looked green at a glance while having never been tested
against the branch it was about to merge into.

Same family as the rest of this section: **an artifact that reads as a pass
because the check did not run.** It is the mutation harness's absent anchor and
the "merged" PR that never landed, arriving a third way.

**The fix is a nudge, not a tool:** close and reopen the PR, which emits a fresh
`pull_request` event and runs CI. Worth doing on any retargeted PR before merging
it — otherwise a stacked PR can reach `main` having only ever been tested against
its parent branch.

### 3.4e A limit that was never measured, treated as binding for a day and a half

Render grants **750 free instance-hours per workspace per month**, and exhausting
it suspends every free service in the workspace. That is real, and the
consequence is severe, so it was treated as the binding constraint on whether the
facilitator could be kept warm.

**Actual usage: 19.37 hours, eleven days into the cycle. Projected ~53 h/month —
2.6% of the limit.** Nine services, ~1.8 hours a day between them, because they
are all asleep almost all of the time.

What that cost:

- The keep-alive was **disabled entirely** rather than reduced, on the strength
  of the unmeasured figure.
- A day and a half of decisions were framed as *"which services can we afford to
  keep warm"* when the answer was *"all of them, easily"*.
- Real work was proposed on it: counting services to establish a divisor, and
  deleting two dormant services to improve that divisor — **for headroom that was
  never scarce**, from services that were drawing approximately zero.

**The tell was available the whole time and nobody read it.** Billing shows
consumed hours for the current cycle. One page. The divisor arithmetic
(`750 ÷ N`) was an *estimate of a quantity that is directly displayed*, and it
was wrong because its core assumption — that services run continuously — is
false for anything idle.

Same family as the rest of this register, arriving from the direction of a
*constraint* rather than a test: **a number that looked like a limit, was
plausible, was never measured, and shaped decisions for as long as it went
unchecked.** The corrective is identical to the one for fees — a figure that
drives a decision carries its source, and "the documented maximum" is not a
measurement of what you are using.

**What survived the measurement:** the failure mode is still severe, and one
always-on free service still does not fit (731 h is 97% of the pool by itself).
So the answer moved from *"no keep-alive"* to *"16 h/day with 210 h of margin"* —
not to *"leave it on"*.

### 3.4f The verifier passed a PR that was two-thirds missing — sixth instance

`verify-merged.mjs` reported **LANDED** for #45 while `src/rpcstatus.ts`, its
tests and the upstream draft were absent from `main`.

**The tool was not wrong.** `gh pr diff` returns what was *merged*, so it answered
*"is what was merged on main?"* — truthfully. The question actually being asked
was *"is everything I wrote on main?"*, and those diverged because **I pushed two
commits to the branch seven minutes after the PR was squash-merged and closed.**
GitHub does not reopen or re-diff a merged PR, so those commits belonged to no PR
and landed nowhere.

Two errors, both mine: pushing to a merged PR's branch without checking it was
still open (my own commit message said *"pushed onto #45"* — assumed, not
verified), and then trusting a LANDED result for a question the tool does not
answer.

**Sixth instance of content not landing**, and the second caused by branch
hygiene rather than a squash quirk.

**Fixed structurally.** The verifier now fails when the head branch has commits
newer than the merge. Two things went wrong while adding it, both worth keeping:

- **The new check silently did nothing at first**, because `headRefName` was not
  in the fields requested from `gh` — so the branch lookup threw, the `catch`
  swallowed it, and the check passed everything. *A check written to catch silent
  passes, silently passing.* It now distinguishes "branch deleted" (healthy) from
  "could not determine the branch" (reported as unverified).
- **It then produced a false positive on #43**, whose one distinctive line in
  `docs/using-it.md` had been legitimately rewritten by #45. "None present" is
  only evidence when there were enough candidate lines to mean something; below
  three it is now a note, not a failure. **A verifier that cries wolf gets
  ignored, which returns it to useless.**

### 3.5 Tests that passed for the wrong reason — three times

1. **RA-12** — eight tests green against deliberately broken code; the control
   was never armed.
2. **The displacement gate** — thirteen tests green with the gate reading the
   wrong flag, because a later check caught it. The binding was safe, but the
   facilitator had already fetched a claimant-chosen URL for an attempt that
   could never succeed. **A test asserting only the outcome cannot see a control
   whose purpose is preventing the work.**
3. **G-3's live evidence** — two query-string settles produced one entry, and
   would have done so whether or not the catalog canonicalised anything, because
   the query never reached the catalog. It demonstrated a stable seller URL.
   Downgraded rather than left standing; being ours is not an exemption.

### 3.6 A measurement that includes failures reports them as good news

Nine settles were timed to answer "what does the store cost now". Three had
failed — and failures are **fast** (1.5–1.8s vs 5.7–9.3s) because they skip
confirmation polling. A first pass that grepped elapsed time read them as quick
successes. **The settlement counter, not the timing, is what exposed it.** Any
latency figure must state what it excluded.

### 3.7 One identity, several derivations, no test that they agree

The class behind G-3, G-11 and G-14. A value that decides *who owns what* gets
derived independently at several call sites; each is tested against its own
definition; they agree only while the inputs happen to coincide.

**Standing check, now enforced:** an identity has ONE exported derivation and
every consumer calls it. Where two consumers genuinely cannot share code, a test
runs both over one corpus and asserts agreement
(`src/identity.agreement.test.ts`). Audited and clean: `asset` and `network` are
compared verbatim and never keyed on; `payer` only enters a Set.

### 3.8 Rationale in comments rots because nothing tests it

A config comment reasoned about "1 XLM, ~20 settles/minute" long after the value
was 5 XLM. Numbers that carry an argument are asserted in tests now, so the
argument fails with the code.

---

## 4. Live evidence versus unit tests, per control

"Live" means a settled transaction on Horizon, not a `/settle` response.

### Proven live

| Control | Evidence |
| --- | --- |
| **F11 Layer 1** (TOFU binding) | Squat settled on-chain (`9726d45e…`), catalog refused it, `accepts` unchanged |
| **F11 Layer 2** (402 challenge) | `ownerVerified: true` through a real settlement (`8c0d9682…`) — first time in production |
| **G-4** (stats gate) | `3→3`, `1→1`, `3→3` across a rejected upsert |
| **G-1** (re-verify restored entry) | `false → TRUE` on a restored entry (`7cab7329…`) — impossible to prove before durable storage |
| **G-2 displacement** | B squats (`a4c0bfc5…`), A settles (`66e095d5…`), `accepts` flips to A, stats reset `1→0` |
| **Durable catalog** | Survived a **42.2s cold start** (container replacement) with the binding intact |
| **F11 on a restored binding** | Squat settled (`71537b2d…`) against a Turso-loaded binding and was refused |
| **RA-9 / RA-13** | Badge `false` and `statsSource: persisted` after restart — both by design |
| **F3 balance guard** | `503 sponsor_balance_low` with the sponsor at 9,999.89 XLM against a raised floor |
| **F7 hardening** | helmet headers, `x-ratelimit-limit: 60`, clean `400` on junk XDR |

### Unit tests only

| Control | Why, and what a demonstration needs |
| --- | --- |
| **F12** per-URL / per-payTo budgets | **The one gap.** Needs 11 settles inside 60s; the harness manages 6 at ~8s each. Requires **one funded classic source account per concurrent settler** — sharing one gives `tx_bad_seq`, and the resulting 1-success/10-failure result *looks* like a budget refusing when F12 is log-only on testnet and cannot refuse. Also needs `STELLAR_NETWORK=pubnet` against testnet RPC to see a real 503, or assertion on the `{payTo, wouldReject}` log. Full procedure in runbook §7 |
| **G-5, G-6, G-7** | Closed structurally by the migration; the states they describe are no longer representable, so there is nothing to demonstrate |
| **RA-1…RA-8, RA-10…RA-14** | Input-validation and guard logic; a live run adds nothing a mutation-verified test does not |
| **G-13, G-14** | On `main` and mutation-verified. **Not yet on the running instance** — a deploy is the last step, and G-14 is a live hijack path until then |

---

## 4b. The keep-alive — ENABLED 2026-08-11, against measured headroom

**Billing settled it: 19.37 h consumed 11 days into the cycle across nine
services, projecting to ~53 h/month — 7% of the 750-hour pool.** The divisor
arithmetic that preceded this was chasing a constraint that does not exist; see
§3.4e, which is the more useful half of this story.

### What it costs

| Window (daily) | This service | + others (~53 h) | Share of pool | Margin |
| --- | --- | --- | --- | --- |
| 8 h/day | 244 h | 297 h | 40% | 453 h |
| 12 h/day | 365 h | 418 h | 56% | 332 h |
| **16 h/day** | **487 h** | **540 h** | **72%** | **210 h** |
| 20 h/day | 609 h | 662 h | 88% | 88 h |
| 24/7 | 731 h | 784 h | **105%** | **over budget** |

**Note the last row.** Even with ~700 hours spare, a single always-on free
service does not fit — 24/7 is 731 h by itself, 97% of the pool before anything
else runs. *"We have plenty spare"* and *"we can leave it on"* are different
claims, and only the first is true.

### The schedule

```yaml
schedule:
  - cron: "*/5 0-7,12-19 * * *"   # 16 h/day, split: 00:00-07:59 + 12:00-19:59 UTC
```

**16 h rather than 20 h is a margin decision, not a cost one.** The projection is
eleven days of one cycle. 210 h absorbs being wrong about it; 88 h does not. The
failure mode is not a slow demo — it suspends every free service in the
workspace, including unrelated production ones. Having just been wrong about this
number by a factor of forty, leaving room to be wrong again is cheap.

**`*/5` rather than `*/10`** because the ping is free: this repo is public, so
Actions minutes are unmetered, and instance-hours accrue from the service being
awake rather than from how often it is pinged. Scheduled workflows can be delayed
under load, and a 15-minute idle timeout leaves no room for a 10-minute interval
to slip.

**The window is a knob, not a decision.** All three options below cost the same
16 h/day; shifting it is free, and what changes is which region gets a warm
service. The workflow carries the full local-time table.

| | UTC | Europe | US East | US West | Japan / Singapore |
| --- | --- | --- | --- | --- | --- |
| **A** *(current)* | 08:00–23:59 | ✅ + dead evening | ✅ | ✅ | ❌ misses entirely |
| **B** | 00:00–15:59 | ✅ | morning only | ❌ | ✅ |
| **C** *(split)* | 00–07:59, 12–19:59 | ✅ | ✅ | morning only | ✅ |

**C is the best overall coverage** — the only option where Asia-Pacific, Europe
and US East all get their working day, at the same cost, trading US West
afternoons and a two-hour European lunch.

**A is in force only because it was chosen before anyone asked where the traffic
comes from.** If the first real evaluators are in Asia-Pacific, B or C is
strictly better and the change is one line.

### What a developer experiences

| | Inside the window | Outside it |
| --- | --- | --- |
| First request | **Normal, ~200-300 ms** | **~50 s** (42 s measured) |
| Subsequent | Normal | Normal, and stays warm 15 min after each request |
| Catalog | Present | **Present** — it is in Turso and survives regardless |

Two details worth knowing:

- **The keep-alive does not make the window's first request fast.** The ping
  itself pays the cold start at 08:00; developers benefit from then on.
- **Outside the window you pay it once**, not per request. After waking, the
  service stays up for 15 minutes past your last call, so an active session runs
  at normal speed after the first hit.

### Orphan to delete

**`vellar-db`** — a free Postgres, 24 days old, used by nothing: the facilitator
is on Turso and the wallet repo uses a different database. Render deletes free
Postgres at 30 days, so it goes on its own in about six days. **It draws no
instance-hours**, so it never had any bearing on this decision — deleting it
early just removes something that reads as load-bearing and is not.

**The two dormant web services (`backend`, failed deploy, 8 months; `capcut-bot`,
7 months) do not need deleting for headroom either.** They were drawing
approximately nothing, which the measurement confirms.

## 5. What is open, and who owns it

### Mine to finish

| Item | Note |
| --- | --- |
| **Deploy `main`** | G-13 + G-14 are merged and *not running*. `scripts/verify-merged.mjs` confirms they are on `main`; only a redeploy puts them in front of traffic |
| **F12 live demonstration** | Half a day, needs N funded source accounts. The last control with no live evidence |
| **The 1-in-3 submission failures** | **DIAGNOSED 2026-08-11**, see [`diagnosis-settle-failures.md`](./diagnosis-settle-failures.md). 9 of 10 failures are the RPC returning **`TRY_AGAIN_LATER`** to `sendTransaction`; 1 is `txBadSeq`. Ruled out: the facilitator, the scheme library's logic, sponsor contention, and — by testing five never-used accounts, one of which still failed — shared-source contention, which had been the leading hypothesis. **The finding underneath: a status named "try again later" is converted into a terminal failure.** Not fixed; options and a recommendation are in the doc |

### Yours

| Item | Note |
| --- | --- |
| **The two V6 dashboard facts** | As you have them |
| **B1 / B2** | Pubnet items, yours |
| **G-10** | Spend-ceiling tuning — a decision about honest throughput versus sponsor exposure, not a defect |
| **G-8** | Whether the tombstone cap needs a reset path. Arithmetic redone on the verified fee; still not on a schedule |

### External

| Item | Note |
| --- | --- |
| **F4-ts** | **Deferred deliberately, not pending.** Chain: trust badge ← a verdict source ← worker-service deployed (needs a Docker host) ← `ATTESTOR_SECRET_KEY` (needs an attestor) ← M5 multisig design (unresolved). Each link is blocked by the one below, and the bottom is a wallet-repo design decision. **It will not be switched on to produce testnet badges** — that would mean minting an attestor key ahead of the multisig design meant to govern it. Two prerequisites proceed regardless because they are design defects rather than deployment ones: per-record timestamps, and endpoint authentication |

### Deferred, with reasons

**F5** (integration-level), **F8** (operator-supplied input), **RA-14r** (not
reachable here), **G-9** (not reachable in production), **G-12** (self-closing).

---

## 6. Pubnet go / no-go

**Not yet. Three blockers, all tractable.**

### Blockers — must be true before `STELLAR_NETWORK=pubnet`

1. **G-14 actually deployed.** It is merged and verified on `main`; the running
   instance does not have it. A live hijack path closed in the repo is not
   closed. Non-negotiable.
2. **F12 demonstrated, or explicitly accepted as unproven in writing.** It is the
   only control with no live evidence, and pubnet is where it stops being
   log-only and starts refusing real money. Shipping a control whose first real
   execution is against production traffic is the RA-12 failure with money
   attached.
3. **Thresholds reviewed against real traffic.** Every number was set from a
   testnet sample of one wallet. G-10 says the spend ceiling is 22× more
   conservative than its name implies; nobody knows yet whether that is
   comfortable or crippling at real volume.

### Conditions — true at cutover, watched afterwards

- **The sponsor guard is the whole defence against a funded attacker**, not one
  of two. G-8's arithmetic depends on it; if the hard floor is disabled,
  mis-sized, or fails open on a stale read, nothing else is holding.
- **`CATALOG_DB_AUTH_TOKEN` is in the same category as `SPONSOR_SECRET_KEY`.**
  F6 relocated rather than closed: whoever holds it can forge or clear any
  binding. Database-scoped, read-write, non-expiring — and rotated deliberately,
  never on a timer, because we fail closed and an expiring token is a scheduled
  outage.
- **A squat no longer self-heals.** Displacement recovers the unverified case
  automatically; a verified binding needs runbook §1 and an operator who is
  actually available.
- **`VERIFICATION_API_URL` stays unset** until F4-ts lands. Configuring it makes
  that service a trust root, and it is unauthenticated with no per-record
  timestamp.
- **Watch `catalogFrozen` and `unverifiableEntries` on `/health`.** Both are
  designed to be visible rather than silent; nothing polls them now that the
  keep-alive is off.

### Explicitly NOT blockers

- **G-8, G-9, G-12** — bounded, unreachable, and self-closing respectively.
- **F5, F8, RA-14r** — deferred with reasons that still hold.
- **The 1-in-3 failures** — they cost nothing and predate every change made here.
  Worth understanding, not worth blocking on.

---

## 7. One sentence on where this ended

Every control that had only unit tests at the start of this engagement now has a
settled transaction behind it **except F12** — and the three things most worth
keeping are not fixes at all: that the artifact lies before the system does, that
a control's value can live in the work it prevents rather than the outcome it
produces, and that an identity with two derivations is a vulnerability waiting
for the inputs to stop coinciding.
