# Brief — durable catalog on Turso

**Status: BUILT. All four numbers approved 2026-08-11 and in `PROPOSED_TIMINGS`.**

---

## THE COST, STATED FIRST

**Today a squatted URL self-heals. After this milestone it does not.**

This is not a projection. On 2026-08-11 the catalog was empty after a restart, and
a squat was run against the live deployment:

| | |
| --- | --- |
| B settles first, declaring the victim's URL | `f5e16012…`, `successful: true`, sponsor-paid |
| Catalog binds the URL to **B** | `accepts: ['GB74DDOZ…']`, `ownerVerified: false` |
| **A — the real owner — then settles through its own seller** | `e4def312…`, `successful: true` |
| Catalog after A's settlement | `accepts: ['GB74DDOZ…']` — **unchanged**. `settlements 1→1`, `uniquePayers 1→1` |

**The real owner was locked out of its own URL, and its own payment did not
correct it.** Today that resolves itself: nothing is durable, so the next
spin-down clears the binding and the next settlement re-binds the rightful owner.

**After this milestone, it does not resolve itself.** The binding survives
restarts — that is the entire point — so a squat persists until an operator runs
[`operator-runbook.md` §1](./operator-runbook.md) by hand. There is no in-band
recovery, because the displacement variant is deliberately deferred (§1 below).

**Anyone onboarding a real merchant before displacement ships is accepting that
a squat on their URL requires manual operator recovery, and that the merchant's
own payments will not fix it.** That is the trade, in one sentence, and it should
be quoted to anyone who asks whether the facilitator is ready for a real
merchant.

---

Builds on [`milestone-durable-catalog.md`](./milestone-durable-catalog.md), which
established *why* Turso and *what it touches*. This brief covers what that
document could not: the sequencing decision the operator has now made, the schema,
the cutover, and the tests that have to exist before the cutover counts.

---

## 1. The sequencing decision — displacement comes AFTER, and this is deliberate

The milestone document concluded the opposite:

> "It is therefore a prerequisite of this milestone for the same reason, and
> should land before the cutover, not after."

**That is overridden.** Persistence lands first; the displacement variant — letting
a *verified* claim displace an *unverified* binding — comes after. A squat
requiring manual operator recovery is accepted in the interim.

### The reasoning, recorded so it is not re-litigated by inference

The milestone document was right about the mechanism and wrong about the
priority. The mechanism is exactly as described: today a squat evaporates on the
next spin-down, so the exposure is small and self-healing; after this milestone a
squat is **durable**, and clearing it needs an operator running runbook §1.

What makes accepting that correct *right now*:

- **No real merchants.** This is a testnet demo. A squatted binding costs nobody
  money — the payments it would misdirect do not exist yet.
- **A recovery path already exists and is written down.** Runbook §1 is the
  procedure. Manual is not the same as impossible, and an operator-mediated
  rotation was already the accepted answer to G-2 (2A, chosen explicitly over
  automated re-challenge 2C).
- **The exposure needs an attacker to arrive first.** TOFU binds the first
  settler. For a squat to matter, someone has to claim a URL *before* its real
  owner ever settles — a race an attacker can only win on a resource nobody has
  yet used.
- **The walkthrough narrowed who can even try.** A squat cannot be mounted through
  a well-behaved merchant; the seller refuses the payTo mismatch before the
  facilitator sees it. It requires a client addressing `/settle` directly.
- **And the empty catalog is the live problem.** Nothing is durable today, so
  every restart erases the discovery surface. That is the defect a developer
  actually hits.

### What must be true for this to stop being acceptable

Displacement stops being deferrable — regardless of what else is in flight — on
**any** of:

1. **A real merchant depends on the catalog.** Not "someone tried the demo": a
   third party's payments route by what discovery returns.
2. **Pubnet.** Real value makes a durable squat a theft-enablement primitive, and
   manual recovery a business dependency on operator response time.
3. **A squat is observed in the wild.** One real attempt establishes the
   population is non-empty, which is the assumption doing the work above.
4. **The operator is no longer reliably available** to run runbook §1 within a
   day. Manual recovery is only a recovery path if someone runs it.

None of these are true today. The moment one is, this decision is stale — and it
should be re-read, not inferred from the fact that persistence shipped without
displacement.

**Do not "improve" this into shipping displacement alongside the cutover.** That
was considered and deferred on purpose. It is the same shape as the G-2 2A/2C
decision, and the same warning applies.

---

## 2. Schema

Two tables, because ownership and entries have genuinely different durability
requirements (§3). One database, so they update in one transaction.

```sql
-- Ownership. The security-critical table: a row is the claim that `pay_to` owns
-- `resource_key`. Durable-before-relied-upon (§3).
--
-- ONE ROW PER BOUND payTo — see "why the composite key" below.
CREATE TABLE ownership (
  resource_key TEXT NOT NULL,          -- canonical: origin + pathname, no query
  pay_to       TEXT NOT NULL,
  bound_at     INTEGER NOT NULL,       -- epoch ms; also the load order
  PRIMARY KEY (resource_key, pay_to)
);

-- Catalog entries. Reconstructible from settlement traffic, so these get the
-- weaker guarantee (debounced, fire-and-forget) — see §3.
CREATE TABLE entry (
  resource_key TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,             -- the StoredEntry JSON, as today
  last_updated INTEGER NOT NULL
);
CREATE INDEX entry_last_updated ON entry (last_updated DESC);
```

### Why the composite key — a defect this migration nearly shipped

The first draft used `resource_key TEXT PRIMARY KEY` with a single `pay_to`.
That is wrong, and it took a migrated test to say so: `boundPayTo` is an **array**
because the rotation procedure (runbook §1) adds the merchant's new address
**alongside** the old one, `[OLD, NEW]`. A one-row-per-URL table cannot hold it.

The consequence would not have been a crash. It would have been the **silent
removal of the only recovery route a squatted URL has** before displacement
ships — found by an operator at the moment they needed it, which is the worst
possible time to find it. A test now fails if the composite key is reverted.

Row order is load-bearing too: rows load `ORDER BY bound_at, rowid` and
`boundPayTo[0]` is treated as the owner downstream, so a load that reordered them
would hand ownership to the operator-added address. Also asserted.

### Why there is NO separate tombstone table

The milestone document specified a second `ownership_tombstone` table. **It was
deliberately not built, and this section exists so nobody re-adds it believing it
was an oversight.**

A tombstone answers one question: *has this URL ever been bound?* Here a binding
row is **never deleted**, so that question is exactly *is there a row in
`ownership`?* Two tables would carry identical information under different names,
and the second could only ever drift from the first.

The obvious objection is displacement — which is why the milestone proposed it —
and it does not apply: displacement replaces a binding's `pay_to`, it does not
delete the URL's rows. The record that the URL was once bound survives either way.

**The condition that would change this:** if some future feature needs to DELETE
a URL's last ownership row — a genuine unbind, an operator purge, an erasure
request — then "has ever been bound" stops being derivable and the tombstone
table becomes necessary. Nothing planned needs that. If you find yourself writing
that DELETE, add the table in the same change.

Three things this shape buys, none of which the file store can:

- **G-5 closes by construction.** Bindings load from `ownership`, never derived
  from `accepts[0]`. The derivation that creates G-5 stops existing.
- **G-6 closes with `ORDER BY last_updated DESC LIMIT ?`.** `MAX_ENTRIES` becomes
  enforceable on the load path instead of only on the write path.
- **G-7 and `CATALOG_OWNERSHIP_BOOTSTRAP` both disappear.** The hatch exists only
  because an ownership *file* can be absent while a catalog *file* is present. One
  database cannot be half-present, so the ambiguity has nowhere to live. **Delete
  the env var; do not port it.**

---

## 3. The two durability classes — the part most likely to be got wrong

This is G-7's lesson, and re-creating it over a network would be worse than the
original, because the window is longer.

**Ownership: durable before relied upon.**
`bindOwnership` becomes `async`; the caller awaits it. A binding that has not been
committed **is not established** — on write failure it returns `false`, the upsert
is refused, and the in-memory map is *not* optimistically populated. The only
caller is `upsertFromPayment` inside `onAfterSettle`, which is already async and
already runs after on-chain settlement, so awaiting there delays the settle
*response* by one round trip and **cannot delay or fail the payment**.

**Entries: debounced, fire-and-forget.** Unchanged. Entries regenerate from the
next settlement; ownership does not. That asymmetry is the existing design and it
survives the move intact.

**The binding and its tombstone commit together, or neither does.** A binding
without its tombstone is a URL that can be silently reopened; a tombstone without
its binding is a URL permanently unclaimable (G-5's shape). Both are
unrepresentable inside one transaction — which is the single largest correctness
gain of the whole migration, and worth more than the durability itself.

---

## 4. Fail-closed, kept — with a better signal

Unreadable ownership still freezes the catalog. Not a close call: serving entries
whose bindings could not be loaded means serving entries with **no enforceable
ownership** — every URL open to first-writer claim, i.e. F11 disabled at exactly
the moment nobody is watching. Discovery going quiet is recoverable; discovery
serving attacker-claimable entries is not.

What changes is diagnosis and blast radius, not the default:

- **Distinguish the two causes.** A file that is unreadable has been tampered with
  or deleted — a security event. A network store that is unreachable is a vendor
  having a bad ten minutes — not one. Today both render as
  `catalogFrozen: "ownership-unreadable"`. They must be separable on `/health`:
  unreachable (retryable) vs. returned-something-invalid (investigate).
- **Retry with backoff before freezing.** A file read fails once and stays failed;
  a network read deserves attempts. Freeze only after they are exhausted. Counts
  and delays are in §7 — not chosen here.
- **Settlement stays unaffected, and this gets a test.** The catalog is downstream
  of settlement; a frozen catalog refuses *cataloging*, not *payments*. That is
  true today by structure, and structure changes in this migration.

---

## 5. Cutover

**Start empty. Import nothing.** The hosted instance has no durable catalog to
carry over, and a local `CATALOG_FILE` contains test data. The catalog
self-repopulates: every resource returns on its next settled payment and re-binds
its owner at that point.

An importer would exist only to preserve data that regenerates itself, while
carrying precisely the risk the bootstrap hatch warns about — trusting a file to
name each resource's owner. That is the trade that produced G-7. If a genuine
catalog ever needs importing, it is the bootstrap problem again and needs the same
explicit opt-in, the same verify-before-durable step, and the same removal step.
**Do not build it speculatively.**

Order of operations:

1. Schema applied to an empty Turso database; credentials in the environment.
2. Deploy with the store wired but the instance still on the file path, and
   confirm `/health` reports the store reachable. *(Optional, and only worth it if
   the credentials are the risky part.)*
3. Cut over. Catalog is empty; first settle repopulates.
4. **Then** run the two tests that were impossible before (§6).

---

## 6. Tests — including the two this unblocks

Non-negotiable, and each must be mutation-verified — a test that passes against
the broken version is not evidence:

| Test | Mutation that must make it fail |
| --- | --- |
| Write failure ⇒ binding NOT established, upsert refused | Make the write fire-and-forget |
| Binding + tombstone commit atomically | Split them into two transactions |
| Unreachable store ⇒ retries, then freezes | Freeze on first error |
| Invalid contents ⇒ freezes immediately, distinct signal | Collapse both causes to one string |
| Frozen catalog still settles payments | Move the freeze check upstream of settle |
| `MAX_ENTRIES` enforced on load | Drop the `LIMIT` |

**And the two the walkthrough could not reach:**

- **G-1 becomes testable for the first time.** Today every post-restart settle is
  a *first* catalog, which would verify anyway, so G-1's actual path — a
  **restored** entry re-verifying on the bound owner's next settlement — is not
  separable from first-catalog verification. With entries surviving a restart it
  is directly observable: restart, settle, assert the re-verify fired on an entry
  that was *loaded* rather than created.
- **The restart test stops being a formality.** "Entries gone, repopulated on next
  settle" becomes "entries **present**, bindings **present**, `verifiedOwner`
  preserved" — which is the actual claim the milestone is making.

---

## 6b. Latency — Tokyo database, Oregon service

The database was created in **ap-northeast-1 (Tokyo)** and the service runs in
**Oregon**: ~100–150ms each way, ~250ms round trip. Checked against that rather
than assumed, because the numbers were already merged.

**What the settle path actually costs.** `bindOwnership` is awaited **only on
first catalog** — so the transpacific cost is paid **once per URL, not once per
payment**:

| | Added to the settle response |
| --- | --- |
| **First** settlement for a URL | **one round trip, ~250ms** |
| Every later settlement | **zero** — the entry write is debounced and fire-and-forget |

Against a measured ~8s end-to-end settle that is ~3% on one settlement per URL,
and it lands *after* the payment is final on-chain. Boot costs two round trips
(~500ms) against a ~35s cold start.

**The timeout holds — but only after a change.** `bindAndUpsertEntry` was an
*interactive* transaction: open, execute, execute, commit — up to four round
trips, ~1s of a 2s budget spent on protocol before the query runs. It is now a
single `batch(..., "write")`, which libSQL wraps in an implicit transaction, so
the atomicity guarantee is unchanged and the cost is one request. **2,000ms then
carries ~8× headroom.**

Two problems that fix independently of distance:

- an interactive transaction holds a **write lock** until it commits (libSQL
  times it out at 5s), so concurrent first-settles for *different* URLs
  serialised on it — each holding it for ~1s across the Pacific;
- our timeout raced the whole block, so a timeout abandoned an **open**
  transaction and the rollback never ran. A batch has nothing to leave open.

**The backoff's first step moved 200ms → 500ms.** At a ~250ms baseline, 200ms
retried before a merely-slow network could have answered — a second attempt at
the same instant rather than a wait for the condition to pass. These fire only at
**boot**; nothing on the settle path retries, so no payment can be lengthened by
them. Worst case to freeze: ~11.5s.

**The bigger lever, if you want it:** the catalog is empty, so recreating the
database in a region near Oregon costs nothing to migrate and takes the round
trip from ~250ms to ~10–20ms. The batch change is right either way — it is a
correctness fix as much as a latency one — but region choice is the difference
between "fine" and "not a consideration".

## 7. The four numbers — APPROVED 2026-08-11, one revised

All four as proposed, with **one revised after the region was known**: the retry
backoff is now **500/1000/2000**, not 200/600/1800 (§6b). They live in
`PROPOSED_TIMINGS` (`src/store.ts`) so a review is one diff, and so none of them
can acquire a second, quietly-different value the way `SETTLE_RATE_MAX` once
shadowed `SETTLE_PER_PAYTO_MAX`. The backoff is pinned by a test, which is what
caught the change rather than letting it pass silently.

1. **Connection/query timeout to Turso on the settle path.** Recommend **2000 ms**
   — it sits after on-chain settlement, so it delays a response but cannot fail a
   payment; long enough to ride out a slow hop, short enough not to hold the
   response open.
2. **Retry attempts and backoff before freezing.** Recommend **3 attempts,
   200/600/1800 ms**. Total worst case ~2.6 s plus timeouts. Fewer risks freezing
   on a blip; more delays the freeze past the point of usefulness.
3. **Whether an ownership write failure should also fail the `/settle` *response*,
   or only refuse the catalog upsert.** Recommend **only refuse the upsert** — the
   payment already settled on-chain, and reporting failure for a completed payment
   is a worse lie than an uncatalogued resource. But it means a settled payment can
   leave no catalog trace, and you should agree to that explicitly.
4. **`MAX_ENTRIES` on the load path** — the file store never enforced it, so no
   value has ever been exercised. Recommend keeping whatever the current constant
   is rather than picking a new number under cover of the migration.

Nothing here is urgent enough to guess at. Say the four values and the schema is
ready to write.

## 8. What this does not fix

- **RA-13** — persisted settlement stats stay unverifiable; unverifiable rows in a
  table instead of a file. `observedSettlements` / `statsSource` remain the honest
  signal. **No improvement, and no pretence of one.**
- **The tombstone-clearing risk relocates rather than disappears.** Filesystem
  access becomes database credentials — a higher bar and auditable, but the
  credentials are a new secret in the environment.
- **G-2** — still no in-band payTo rotation; still runbook §1, now editing a row
  instead of a file.
- **G-8** — the one-way tombstone freeze is unchanged, and durable storage does
  make tombstones *accumulate* rather than reset. The arithmetic
  ([`milestone-durable-catalog.md`](./milestone-durable-catalog.md), corrected
  2026-08-10 onto the hash-verified 22,579-stroop fee) says it is still bounded
  ~2 orders of magnitude tighter by the sponsor balance guard than by the cap —
  but the margin is **5.7× thinner** than that document originally claimed. Still
  not a prerequisite. Worth re-reading rather than remembering.
- **The new trust boundary is real:** a network dependency on the write path,
  credentials in the environment, and vendor availability coupled to catalog
  availability. That is the price of durability without a disk, and it is stated
  rather than discounted.
