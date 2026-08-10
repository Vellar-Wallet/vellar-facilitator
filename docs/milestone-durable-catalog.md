# Milestone — durable catalog (Turso)

**Status: design only. No code.** This scopes the work; it does not authorise it.

Supersedes the "attach a persistent disk" plan, which was rejected: a disk costs
money *and* activates three dormant findings (G-5, G-6, G-7) that a real store
closes instead. Paying to acquire bugs is the wrong trade.

---

## Why a store at all

Two separate causes make the hosted catalog look empty, and they need different
fixes:

| Cause | Effect | Fixed by |
| --- | --- | --- |
| Ephemeral filesystem | Nothing survives a container replacement | **This milestone** |
| Idle spin-down every 15 min | Container replacement happens constantly | Keep-alive (shipped) |

The keep-alive is not merely a latency fix: spin-down *destroys the container*,
so keeping the instance awake is what preserves the catalog between deploys. But
it cannot survive a deploy, a crash, or an exhausted instance-hour budget. Only a
store outside the container does that.

## Why Turso specifically

- **Non-expiring free tier.** Render's free Postgres is deleted at 30 days, which
  would silently destroy every ownership binding on a timer. Disqualifying for
  anything a developer is told to build on.
- **Real transactions.** SQLite/libSQL semantics are closest to what the code
  already assumes, so the least new reasoning.
- **Cloudflare KV is rejected outright:** it is eventually consistent, and a
  stale read lets a second claimant bind an already-bound URL. That breaks F11.
- Upstash Redis is workable but lacks cross-key transactions, so the ownership
  store's atomicity would have to be hand-rolled.

## How much of the code this touches

The class comment at `src/catalog.ts` claims the store sits behind `BazaarCatalog`
"so a database can replace the file without touching routes/ingestion." **Tested
against the tree: half true.**

**True.** Filesystem access is confined to five call sites — `writeFileAtomic`
from `saveOwnership` and `flush`, and three `readFileSync` in `load` /
`loadOwnership`. Reads (`list`, `search`, `isBound`, `isVerifiedOwner`) never
touch storage; they read the in-memory maps. Routes and ingestion are genuinely
unaffected.

**False.** The public API is **synchronous** — `upsertFromPayment`,
`recordSettlement`, `setVerifiedOwner`, `flush`. Two consequences the comment does
not admit, and the first is a security problem.

### The sync-to-async problem — do not re-create G-7

`saveOwnership()` is synchronous **deliberately**. `bindOwnership` writes the
binding to disk *before* returning `true`, so a binding is durable before anything
relies on it. G-7 was precisely the bug where a binding lived in memory and never
reached disk, and the migration silently persisted nothing.

An async write reintroduces exactly that window: bound in memory, not yet durable,
crash, binding gone — and the URL is claimable again by whoever settles next.

**The design must preserve durable-before-relied-upon.** Concretely:

1. **`bindOwnership` becomes `async` and the caller awaits it.** The only caller is
   `upsertFromPayment`, which runs inside `onAfterSettle` — already async, already
   after on-chain settlement. Awaiting there delays the settle *response* by one
   round-trip; it cannot delay or fail the payment.
2. **A binding that has not been persisted must not be treated as established.**
   On write failure, `bindOwnership` returns `false` and the upsert is refused —
   the same fail-closed path already used at the tombstone cap. It must not
   optimistically populate the in-memory map and hope the write lands.
3. **Entry writes stay debounced and fire-and-forget.** Catalog entries are
   reconstructible from settlement traffic; ownership is not. That asymmetry is
   the existing design and it survives the move — only the ownership path needs
   the strict guarantee.
4. **A test must pin it:** simulate a write failure, assert the binding is *not*
   established and the upsert is refused. Mutation-verify by making the write
   fire-and-forget and confirming the test fails. Without that, this is G-7 with
   a network in the middle.

### Async construction

`load()` runs in the constructor. It becomes `await BazaarCatalog.create(...)`.
Contained: `buildServer` is already async and there is one production call site.

## The availability coupling — and whether fail-closed is still right

Today an unreadable ownership store means the catalog **fails closed**: empty,
frozen, `catalogFrozen: "ownership-unreadable"` on `/health`. That default was
chosen when the store was a local file, where unreadable means *tampered or
deleted* — a security event.

With a network store, unreadable also means *the vendor is having a bad ten
minutes*, which is not a security event. Same signal, two very different causes —
the same ambiguity that runbook §1 exists to handle for rotations.

**Recommendation: keep fail-closed, and it is not a close call.** Serving a
catalog whose ownership bindings could not be loaded means serving entries with
no enforceable ownership — every URL open to first-writer claim, which is F11
with extra steps. A transient outage would silently reopen every binding in the
catalog at once. Discovery going quiet is recoverable; discovery serving
attacker-claimable entries is not.

What should change is the **blast radius and the diagnosis**, not the default:

- **Distinguish the causes in the signal.** `catalogFrozen` should say whether the
  store was unreachable (retryable) or returned something invalid (investigate).
  Today both read `"ownership-unreadable"`.
- **Retry with backoff before freezing.** A file read fails once and stays failed;
  a network read deserves a few attempts. Freeze only after they are exhausted.
- **Settlement must remain unaffected.** It already is — the catalog is downstream
  of settlement, and a frozen catalog refuses cataloging, not payments. That
  property must survive the change and is worth an explicit test.

## Findings: what closes, what changes shape, what does not move

**Closed outright:**

| Finding | Why |
| --- | --- |
| **G-5** — empty-`accepts` entry loads with no tombstone and becomes permanently unclaimable | Bindings load from their own table instead of being derived from `accepts[0]`. The derivation that creates G-5 stops existing. |
| **G-6** — `MAX_ENTRIES` not enforced on the load path | `ORDER BY last_updated DESC LIMIT n` in the load query. |
| **G-7** — bootstrap-derived bindings not persisted | The bootstrap hatch exists only because an ownership *file* can be absent while a catalog *file* is present. One store, one schema — the ambiguity, the hatch, and `CATALOG_OWNERSHIP_BOOTSTRAP` all disappear. |

**Also deleted:** `writeFileAtomic` (temp + fsync + rename) and the debounce
bookkeeping around it, replaced by transactions.

**Gained, which the file store cannot do:** catalog and ownership update in **one
transaction**, making the split-brain state that F3, G-7 and the whole fail-closed
dance exist to manage **unrepresentable** rather than merely handled.

**Changes shape:**

| Finding | Before | After |
| --- | --- | --- |
| Crafted-`CATALOG_FILE` tombstone clearing (accepted risk under F6/RA-13) | Anyone with filesystem access deletes a file | Anyone with **database credentials** runs a `DELETE`. Higher bar and auditable, but credentials now live in the environment and are a new secret to manage. Not eliminated — relocated. |
| RA-13 — persisted settlement stats are unverifiable | Unverifiable rows in a file | Unverifiable rows in a table. `observedSettlements` / `statsSource` remain the honest signal. **No improvement.** |

**Untouched — these are policy, not storage:**

- **G-2** — no in-band `payTo` rotation. Still operator-mediated (runbook §1), and
  the procedure changes from editing a file to updating a row.
- **G-8** — the tombstone cap is a one-way freeze with no reset path. Durable
  storage does make the cap *accumulate* rather than reset, so this was raised as
  a possible prerequisite. **The arithmetic says no.** See below.

### G-8 under durable storage — worked out, not assumed

A tombstone is created per distinct canonical URL that binds. A brand-new URL is
by definition unbound at settle time, so it is gated by the **unbound pool**
(`SETTLE_UNBOUND_POOL_MAX`, 10 per 60 s shared across all unbound URLs):

| Quantity | Value |
| --- | --- |
| New-URL settlements per day at the cap | **14,400** |
| Days of *sustained maximum* to reach `MAX_TOMBSTONES` (100,000) | **6.9** |
| Sponsor XLM burned to get there (at the 127,808-stroop measured fee) | **~1,278 XLM** |
| …per day at that rate | **~184 XLM/day** |

Seven days looks alarming until you price it. **The binding constraint is the
sponsor balance, not the tombstone cap.** `/settle` refuses below the 10 XLM hard
floor, so at maximum rate the attack self-terminates in **~78 minutes** from a
10 XLM surplus. Reaching the cap needs someone to keep refunding ~184 XLM/day for
a week — which only the operator can do, and would notice.

Organically, 100,000 distinct URLs is roughly 10,000 merchants at 10 endpoints
each: a very large service, not a near-term state.

**Verdict: G-8 stays a policy item and is NOT a prerequisite of this milestone.**
The finding is real — a one-way freeze with no reset path is disproportionate to
its trigger — but it is not on a schedule, and the sponsor balance guard bounds it
roughly two orders of magnitude tighter than the cap does.

One caveat to revisit if the numbers move: raising `SETTLE_UNBOUND_POOL_MAX`, or
running with a much larger sponsor balance and no hard floor, removes the very
constraint doing the work here. If either changes, redo this arithmetic.

**New trust boundary:** a network dependency on the write path, credentials in the
environment, and vendor availability coupled to catalog availability. That is a
real cost, stated plainly — it is the price of durability without a disk.

## Migration from the current file store

**Almost certainly nothing to migrate, and that is the cheapest path.**

The hosted instance has no persistent disk, so there is no durable catalog to
carry over — it is empty after every spin-down. A local development instance may
have a `CATALOG_FILE`, but its contents are test data.

**Recommended: start empty.** The catalog is self-repopulating — every resource
returns on its next settled payment, and ownership re-binds at that point. A
one-time importer would exist solely to preserve data that regenerates itself,
while carrying the exact risk the bootstrap hatch warns about: trusting a file to
name each resource's owner.

If a genuine catalog ever does need importing, it is the bootstrap problem again
and needs the same explicit opt-in, the same "verify the owners before they become
durable" step, and the same removal step. Do not build it speculatively.

## Prerequisite: the displacement variant

The displacement variant — letting a *verified* claim displace an *unverified*
binding — was scoped as a prerequisite of attaching a disk. **Its urgency drops
under this plan and then returns.**

- **Now, with no durable store:** a squat clears on the next spin-down, so the
  exposure is small and self-healing.
- **After this milestone:** bindings become durable, so a squat becomes permanent
  until an operator intervenes — exactly the condition that made it a prerequisite
  of the disk.

**It is therefore a prerequisite of this milestone for the same reason, and should
land before the cutover, not after.**

## Effort

Several days, not one. The persistence rewrite itself is contained (five call
sites), but the sync-to-async conversion, the durable-before-relied-upon
guarantee and its failure-injection test, the retry-then-freeze logic, and the
schema all carry real design. Treat it as the "DB-backed catalog" milestone
already named in `technical-doc.md`, not as a stopgap.
