# Operator runbook — vellar-facilitator

Procedures for problems you cannot fix by redeploying. Written to be followed by
someone who did not write this code, at 2am, while a merchant is complaining.

Each procedure states the **symptom** you will actually see first, how to
**confirm** it is the thing you think it is, the **steps**, and how to **verify**
afterwards. Do not skip the confirm step — two of the problems below look
identical from the outside and have opposite fixes.

---

## 1. "My payments settle, but the catalog still lists my old payment address"

This is **G-2**: a resource URL's `payTo` is bound on first use.

> ### FIRST: check whether you need to do anything at all
>
> Since displacement shipped, **this procedure covers only half the cases it used
> to.** The other half now resolves itself, and running the manual procedure on
> it would be wasted work at best.
>
> ```
> curl -sS '<base>/discovery/resources' | python3 -m json.tool | grep -i ownerVerified
> ```
>
> | What you see | What it means | What to do |
> | --- | --- | --- |
> | `ownerVerified: false` on the entry | The binding was **never proven**. The rightful owner takes it back **automatically** by settling once, provided their endpoint's own 402 challenge names their address. | **Nothing.** Tell them to settle once and re-check. See below for why it may not have happened yet. |
> | `ownerVerified: true` | The binding **was proven** by the address currently bound. Displacement will not touch it — deliberately, because proof does not displace proof. | **This procedure.** |
>
> **The distinction is proof, not identity.** An unverified binding is arrival
> order — whoever settled first — which is evidence of nothing, so a claimant who
> can prove ownership outranks it. A verified binding is evidence, and a domain
> genuinely changing hands is indistinguishable from a hijack, so that case stays
> with you.
>
> **If it is unverified and displacement has not happened**, the usual reasons, in
> order of likelihood:
> - **The merchant has not settled since.** The check fires on their settlement;
>   nothing runs on a timer.
> - **Their endpoint does not name the new address in its own 402.** That is the
>   proof, and without it there is nothing to act on — this is the same condition
>   that makes the check safe.
> - **They are inside the cooldown** from a recent failed attempt. Keyed per
>   claimant, so ask them to wait it out and settle again.
> - **The URL is not fetchable** — http, a private address, or a route template.
>   `/health` reports `unverifiableEntries` when this is the case, and procedure 6
>   covers it.
>
> One thing that is NOT a reason: a squatter holding the URL. Displacement exists
> exactly for that, and the squatter's binding is unverified by construction —
> they cannot serve a 402 naming themselves from a domain they do not control.

### Symptom

A merchant reports one or more of:

- They changed their payment address, and `/discovery/resources` still shows the
  old one in `accepts[].payTo`.
- Their new settlements are not increasing `trust.settlements` for their entry.
- Their payments **do go through** — they are being paid at the new address.

That last point is the giveaway. **This is not a payment failure.** Settlement
happens before the catalog is consulted, so the money is fine; what is broken is
what the catalog advertises to agents.

In the service logs you will see, once per attempt:

```
[catalog] rejected upsert for <url>: payTo <NEW> is not bound (bound: <OLD>) — possible resource-URL hijack (F11)
[catalog] refused settlement stat for <url>: payTo <NEW> is not bound (bound: <OLD>) — stats may only be moved by the resource's bound owner (G-4)
```

### Confirm it is a rotation and not a hijack

**These two cases produce the identical log line.** F11 exists precisely because
an attacker pointing their own `payTo` at someone else's URL looks like this. Do
not proceed on the merchant's say-so.

Confirm **all** of the following before changing anything:

1. **The request came from the party that controls the URL**, verified out of
   band — not by email alone, and not from the address in the complaint.
2. **The resource's live 402 challenge already names the new `payTo`.** Fetch the
   URL and read the challenge:
   ```
   curl -sS -i '<resource-url>' | sed -n '1,40p'
   ```
   If the challenge still advertises the OLD address, stop. The merchant has not
   actually rotated, and you would be binding an address their own endpoint does
   not claim.
3. **The old address and the new one belong to the same operator.** If the domain
   recently changed hands, this is a takeover, not a rotation — see the box
   below.

If any check fails: **do nothing and escalate.** The failure mode of refusing a
real rotation is an annoyed merchant. The failure mode of accepting a fake one is
that agents are directed to pay an attacker.

### Steps

You need shell access to the instance and its persistent disk. The catalog is a
single-instance file store, so there is no coordination to do — but the service
**must be stopped**, because `saveOwnership()` rewrites the whole file from
memory and will overwrite a live hand-edit.

1. **Stop the service.** Not a restart — it must not be running during the edit.

2. **Locate the ownership file.** It is always the catalog path plus
   `.ownership`. With the shipped `CATALOG_FILE`:
   ```
   /var/data/bazaar-catalog.json.ownership
   ```

3. **Back the ownership rows up.** There are no files any more — the catalog
   lives in libSQL/Turso.
   ```
   turso db shell <db> "SELECT resource_key, pay_to, bound_at FROM ownership \
     WHERE resource_key = 'https://api.merchant.example/quote'"
   ```
   Keep that output. It is what you restore if step 4 goes wrong.

4. **INSERT the new address. Never UPDATE.**

   > ### Why UPDATE is the wrong statement, and what it actually does
   >
   > Read this before you type anything. The two statements look
   > interchangeable and are not.
   >
   > Ownership is **one row per bound payTo**. Rows load ordered by `bound_at`,
   > and **`boundPayTo[0]` is treated as the owner everywhere downstream** — it
   > is the address the entry's `accepts` is filtered against, and the address
   > ownership verification is run for.
   >
   > - `INSERT` **adds** a second acceptable address. The original stays first,
   >   so it stays the owner. The merchant can be paid at the new address, and
   >   nothing about who owns the URL has changed. **This is a rotation.**
   > - `UPDATE` **overwrites** the original row. The new address becomes
   >   `boundPayTo[0]` — the owner — and the old one ceases to exist. **This is
   >   a transfer of ownership**, executed by you, on the strength of whatever
   >   evidence you accepted in step 1.
   >
   > If the request turns out to have been a hijack, `INSERT` is undone by
   > deleting the row you added. `UPDATE` has destroyed the record of who owned
   > the URL, and nothing in the system can tell you what it was. Adding is
   > reversible; overwriting is not.
   >
   > Under pressure the instinct is "the address changed, so change the
   > address." Resist it. You are adding an address, not editing one.

   A rotation is therefore an insert alongside the existing row:

   ```sql
   INSERT INTO ownership (resource_key, pay_to, bound_at)
   VALUES ('https://api.merchant.example/quote', 'GNEW...ADDRESS', unixepoch()*1000);
   ```

   **The schema exists for this procedure.** A one-row-per-URL table cannot
   represent `[OLD, NEW]`, and an early draft of the migration had exactly that —
   it would have silently removed the only recovery route a squatted URL has,
   discovered by whoever was reading this page at the moment they needed it.
   Caught by `catalog.reverify.test.ts`, and pinned by a test that fails if the
   composite key is reverted.

   The `resource` value must be the **canonical** URL — `origin + pathname`, with
   no query string or fragment. If the merchant gave you a URL with `?...`, strip
   it. A row whose key has a query string will simply never match.

5. **Read the rows back** before restarting, and confirm BOTH addresses are
   present with the original first:
   ```
   turso db shell <db> "SELECT pay_to FROM ownership \
     WHERE resource_key = 'https://api.merchant.example/quote' ORDER BY bound_at, rowid"
   ```
   A row whose `pay_to` is not text (a blob, say) makes the catalog come up
   **frozen as `ownership-invalid`** rather than failing loudly at insert time.

6. **Start the service.**

### Verify

0. **Sanity: you should only be here for a VERIFIED binding.** If
   `ownerVerified` was `false`, stop and re-read the box at the top of this
   procedure — you have done by hand what the service would have done on the
   merchant's next settlement, and you have done it on the weaker evidence of an
   out-of-band conversation rather than a 402 challenge.

1. `/health` must **not** report a frozen catalog:
   ```
   curl -sS <base>/health
   ```
   `catalogFrozen` must be `false`. The two values you might see instead now say
   different things:
   - `"ownership-invalid"` — the store ANSWERED and a row is unusable. Your edit
     is the likely cause; restore from step 3. **Do not restart in a loop.**
   - `"ownership-unreachable"` — the database could not be reached after retries.
     Nothing to do with your edit; wait and restart once it answers.

2. Have the merchant settle once at the new address, then confirm the entry
   picked it up:
   ```
   curl -sS '<base>/discovery/resources' | python3 -m json.tool | grep -A2 payTo
   ```
   The new address should now appear in that entry's `accepts`, and
   `trust.settlements` should increment on subsequent settlements.

3. Confirm the refusal log lines from the Symptom section have stopped.

### What agents see while this is unresolved

Once the facilitator re-checks the resource (it does so on the bound owner's next
settlement — G-1), the entry's live 402 challenge will no longer name its bound
address, and the entry is marked **unverified**: `trust.ownerVerified: false`,
every verdict clamped to at most `"unknown"`, and the entry **disappears from
`verified_only=true`** on `/discovery/*` and over MCP.

**That is the same thing agents see for a domain that was taken over.** The wire
carries a plain `false` — deliberately, because a three-state signal would be one
an attacker could force onto a victim's entry. So:

> **A merchant who rotated and a domain that changed hands are indistinguishable
> to agents, and indistinguishable from the log line.** Only an operator, doing
> the out-of-band confirmation in *Confirm it is a rotation and not a hijack*
> above, can tell them apart. That confirmation is not a formality — it is the
> only place in the system where the two cases are ever separated.

The facilitator will not re-check a mismatching resource more than once every 24
hours, so after you complete the rotation below the badge returns on the
merchant's next settlement *after* that window — not instantly. Settlement,
payment, and the merchant's money are unaffected throughout.

### Do NOT automate this

> There is an obvious-looking improvement here: when an unbound `payTo` shows up
> for a bound URL, re-run the 402 challenge and accept the new address if the
> resource's current challenge names it. It reuses the proof already used at
> first bind, and it would make this whole procedure unnecessary.
>
> **Do not build it.** That proof answers "does whoever controls this URL right
> now claim this address?" — and a domain that has **changed hands** answers yes.
> Automating it converts the binding from trust-on-first-use into
> trust-on-current-control, which is exactly the property F11 exists to deny: it
> would make a domain takeover sufficient to redirect every future payment for
> that resource.
>
> The manual step is not an oversight or a missing feature. It is the control:
> a human confirming, out of band, that the rotation is a rotation. If this
> becomes frequent enough to hurt, the right fix is to carry an operator-signed
> rotation authorization on the payload — not to trust the challenge again.

---

## 2. "The service is healthy but `/discovery/resources` is empty"

### Symptom

The service starts, `/health` returns 200, settlements work — and the catalog
serves nothing. On boot the logs contain:

```
[catalog] ownership store at <path>.ownership is missing or unreadable — ...
```

and `/health` reports `catalogFrozen: "ownership-unreadable"`.

### Confirm

This is the deliberate fail-closed behaviour. A catalog file **without** its
companion ownership file is ambiguous: it is what a first upgrade to a persistent
disk looks like, and it is also what an attacker deleting the ownership file
looks like. The service refuses to guess.

Determine which one you are in:

- **Did someone just attach a disk, or restore only the catalog file from a
  backup?** Then it is a migration.
- **Did the ownership file exist and then stop existing, with no deploy?** Treat
  it as tampering and investigate before continuing.

### Steps — first boot on a NEW disk (nothing to migrate)

If the disk is brand new and there was never a catalog file, there is nothing to
do: with **neither** file present the loader treats it as a genuinely fresh start
and the catalog comes up empty and unfrozen. You will not see the symptom above.

### Steps — migration case (a catalog file exists, no ownership file)

This is the state the **first boot after attaching a disk** produces if a catalog
file was restored alongside it.

1. **Confirm where the catalog file came from.** Bootstrap trusts it to name each
   resource's owner. It grants **no more trust than that file already had** — but
   if it was tampered with, this makes the tampering durable. If you cannot
   account for the file, delete it and start empty instead; the catalog rebuilds
   from settlements.

2. Set `CATALOG_OWNERSHIP_BOOTSTRAP=1` **in the Render dashboard**, not in
   `render.yaml` — it is deliberately not declared there so it cannot be left on
   by a merge.

3. **Start the service once.** It warns on every boot while the flag is set, and
   now also logs how many bindings it wrote:

   ```
   [catalog] wrote N ownership binding(s) derived during load to <path>.ownership
   ```

4. **Verify the file exists and is complete before going further:**

   ```sh
   cat /var/data/bazaar-catalog.json.ownership | python3 -m json.tool | head
   ```

   It must contain one `{resource, boundPayTo}` row per catalog entry. Spot-check
   that a `boundPayTo` matches the address that resource actually bills to — this
   is your only chance to catch a wrong owner before it becomes durable.

5. **Remove `CATALOG_OWNERSHIP_BOOTSTRAP` and restart.** Do not skip this. While
   it is set, the fail-closed protection against a missing or deleted ownership
   store is DISABLED, so a later deletion would silently re-derive bindings from
   whatever the catalog file says at that moment.

6. **Confirm the removal took**: `/health` must report no `catalogFrozen`, and
   the boot logs must no longer contain `CATALOG_OWNERSHIP_BOOTSTRAP`.

> **G-7 (fixed).** Bindings derived during load used to be seeded in memory and
> never written, so the migration silently persisted nothing and the *next* boot
> failed closed again. They are now flushed once after load, and step 3's log
> line is the confirmation. If you are running a build from before that fix, keep
> the flag set for one more boot rather than restarting without it.

### Verify

`/health` reports `catalogFrozen: false`, and `/discovery/resources` returns the
expected entries.

---

### Sibling trap: `SPONSOR_HARD_FLOOR_STROOPS`, set by hand and never reverted

Filed here deliberately, beside `CATALOG_OWNERSHIP_BOOTSTRAP`, because it is the
**same shape of hazard** and will be encountered by someone who has forgotten
both.

Testing the balance guard (F3) means raising `SPONSOR_HARD_FLOOR_STROOPS` above
the sponsor's actual balance so `/settle` refuses, then reverting. The trap:

> **A variable set in the Render dashboard is NOT removed by a later blueprint
> sync.** `render.yaml` does not declare `SPONSOR_HARD_FLOOR_STROOPS`, so nothing
> reconciles it, nothing warns about it, and no deploy clears it. Left in place,
> the facilitator refuses **every settlement, permanently**, with a perfectly
> healthy `/health`.

`CATALOG_OWNERSHIP_BOOTSTRAP` at least warns loudly on every boot while set. This
one does not warn at all — it is strictly worse, and the only defence is the
revert step.

**Procedure:**

1. Note the sponsor's balance first, in stroops:
   ```sh
   curl -sS "https://horizon-testnet.stellar.org/accounts/<SPONSOR_G...>" \
     | python3 -c 'import json,sys; print(int(round(float([b["balance"] for b in json.load(sys.stdin)["balances"] if b["asset_type"]=="native"][0])*10_000_000)))'
   ```
2. Set `SPONSOR_HARD_FLOOR_STROOPS` to **balance + 10000000** (1 XLM of margin).
3. **Wait up to 60 s after the redeploy** — the guard polls on
   `SPONSOR_BALANCE_INTERVAL_MS` (60 000 ms), so a settle immediately after boot
   can pass before the first poll and read as a failed test.
4. Confirm the refusal:
   ```
   HTTP 503  {"error":"settlement_refused","reason":"sponsor_balance_low"}
   [balance] settle refused: sponsor below hard floor
   [balance] sponsor below HARD floor (<bal> < <floor> stroops) — /settle refused
   ```
5. **REVERT to `100000000` immediately** and confirm a settle succeeds again.
   Do not defer this to the end of a session.

**If you find settlements being refused and nobody knows why:** check this
variable before anything else. `/health` looks entirely normal in this state —
`status: ok`, no `catalogFrozen` — because the catalog is fine. It is settlement
that is refused, and only the 503 body names the reason.

---

### Sibling trap 2: `MAX_TX_FEE_STROOPS`, raised for an investigation

**Exactly the same hazard as the two above**, and it will be met by someone who
has forgotten all three. A dashboard variable is **not** reconciled by a
blueprint sync, `render.yaml` declares `MAX_TX_FEE_STROOPS` with the safe value
so a sync will not remove a dashboard override, and nothing warns.

**Which number to compare it against.** The error names it for you:
`simulation-derived fee N stroops exceeds ceiling M`. That `N` is the **bid**
(`minResourceFee + BASE_FEE`, computed before submission) — *not* the fee the
network charged. The charged fee runs roughly a third lower, so sizing this
ceiling from a Horizon `fee_charged` figure tightens it by that much against a
number the ceiling never sees. Full note in `src/config.ts` above the definition.

Raising it is occasionally necessary — a smart account whose `__check_auth` is
expensive can legitimately exceed the ceiling, and refusing it is the exact bug
this project exists to fix. But left raised it silently widens the worst-case
sponsor drain per settlement, and **it cascades**:

> `perSettleEstimateStroops` **is** `maxTransactionFeeStroops`
> (`src/server.ts`), so the fee ceiling also drives the spend policy's estimate.
> Raising the fee ceiling shrinks how many settlements fit under
> `SPEND_CEILING_STROOPS` in a window. At 30,000,000 stroops per settle, a 5 XLM
> ceiling admits **one settlement per minute** for the entire service.

So a raise that looks local is three thresholds: the fee ceiling, the spend
ceiling that must accommodate it, and the hard floor that must exceed the spend
ceiling.

**Procedure:**

1. Record the current value first — the shipped default is `500000`.
2. Set the new value in the dashboard. Note the deploy restarts the service.
3. Do the investigation. Keep it short; every settlement in this window can drain
   up to the raised ceiling.
4. **REVERT to `500000`** and confirm with a settle that a normal payment still
   succeeds. Do not defer to the end of a session.

**Symptom if left raised:** nothing obvious. Settlements succeed, `/health` is
clean, and the only signal is a sponsor balance falling faster than it should —
plus `spend_ceiling` refusals appearing at a fraction of the expected rate,
because each settlement now reserves far more of the window's budget than it
used to. `/health` looks entirely normal in this state —
`status: ok`, no `catalogFrozen` — because the catalog is fine. It is settlement
that is refused, and only the 503 body names the reason.

---

## 3. "New resources stop being cataloged and the logs mention a tombstone cap"

### Symptom

```
[catalog] tombstone cap (100000) reached — REFUSING new binding for <url>. ...
```

Existing entries keep working; settlement is unaffected; no *new* URL can ever be
cataloged.

### Confirm

`/health` reports `catalogFrozen: "tombstone-cap"`.

### Steps

There is currently **no reset path** (**G-8**). Ownership tombstones are never
removed, and deleting the ownership file to clear them trips procedure 2 —
turning a partial outage into a full catalog freeze, and discarding every
ownership binding you have.

Do not delete the ownership file to "fix" this.

Escalate. Reaching 100,000 tombstones requires 100,000 distinct settled URLs, so
if you see this without that volume of legitimate traffic, treat it as an attack
on catalog availability and preserve the ownership file for analysis.

---

## 4. Verifying F11 Layer 2 against a live seller (manual gate)

**CI does not cover this, and cannot.** The check needs a live public endpoint,
real DNS and a valid certificate. In CI that means a network dependency on every
push, a free-tier seller that sleeps (so the first run pays a ~60s cold start),
an external hostname that can change, and a red build whenever someone else's
service is down. A recorded fixture would defeat the point entirely: the thing
under test is that the bytes traverse real DNS and real TLS, which no fixture
reproduces.

So this is a **manual gate before any release that touches `src/ownership.ts`**.

### Steps

1. Wake the seller (free instances sleep after 15 min; the first request takes
   ~1 min):

   ```sh
   curl -sS -o /dev/null -w '%{http_code}\n' --max-time 150 \
     https://vellar-seller-demo.onrender.com/quote     # expect 402
   ```

2. Confirm it advertises its PUBLIC address, not localhost — **one request**:

   ```sh
   curl -sS https://vellar-seller-demo.onrender.com/whoami | python3 -m json.tool
   ```

   `verifiable: true` is the precondition. `resourceUrl` must be public https;
   `commit` tells you which build is serving. Do NOT read the boot log for this —
   it was hardcoded and lied (D-3).

   The longer form, if you want to see the challenge itself:

   ```sh
   curl -sS -D- -o /dev/null https://vellar-seller-demo.onrender.com/quote \
     | grep -i '^payment-required:' | sed 's/^payment-required: //' | tr -d '\r' \
     | base64 -d | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["resource"]["url"], d["accepts"][0]["payTo"])'
   ```

   The URL must be `https://…onrender.com/quote`. If it reads
   `http://localhost:…`, `PUBLIC_BASE_URL` is unset on the seller service —
   fix that before going further, or the test verifies nothing real.

3. Run the gate with the payTo from step 2:

   ```sh
   LIVE_SELLER_URL=https://vellar-seller-demo.onrender.com/quote \
   LIVE_SELLER_PAYTO=<payTo from step 2> \
   npx vitest run src/ownership.live.test.ts
   ```

### What a pass looks like

Every stage is printed, and all of them must be real:

```
DNS      vellar-seller-demo.onrender.com -> 216.24.57.7 (family 4)
PIN      lookup() -> 216.24.57.7
TLS      authorized=true CN=onrender.com issuer=Google Trust Services
VERDICT  match (fetch impl: undici, not global)
CONTROL  wrong payTo -> mismatch
```

**The CONTROL line is the one that matters.** Without it, `match` could mean
"returns match unconditionally". A pass requires both a match for the real payTo
and a mismatch for an unrelated one.

**With the env vars unset the tests SKIP, they do not pass.** That is deliberate:
a skip reads as "not run", a vacuous pass reads as "covered", and confusing those
two is exactly the RA-12 failure this repo has already made once.

### If it fails

The output names the stage. Read it literally:

| Stage | Meaning |
| --- | --- |
| scheme | The URL is not https. Check `PUBLIC_BASE_URL` on the seller. |
| DNS | The hostname does not resolve. The service may be deleted or renamed. |
| private-range | The host resolved into a blocked range — investigate, this is the SSRF guard doing its job. |
| PIN | The pin is not the vetted address; the RA-2 rebinding defence is broken. Treat as critical. |
| TLS | Certificate does not validate against the hostname. |
| VERDICT `unverifiable` | Reached the endpoint but got no usable 402 — check the seller is awake and returning `PAYMENT-REQUIRED`. |
| VERDICT `mismatch` | The challenge does not name that payTo. Usually a stale `LIVE_SELLER_PAYTO`. |

---

## 5. "The catalog is empty after the service was idle"

**This is designed behaviour on the free tier.** Render spins a free web service
down after 15 minutes without traffic, and spin-down destroys the container's
filesystem — which is where `CATALOG_FILE` and its ownership store live. Entries
and bindings go with it.

**Do not treat it as a fault, and do not fix it with a keep-alive.**

`.github/workflows/keepalive.yml` exists and is deliberately left with no
`schedule:` trigger. Free instance hours are pooled per **workspace** (750/month,
shared by every free service), and exhausting the pool **suspends every free
service in the workspace** — including services unrelated to this one. Keeping
this facilitator warm 20 h/day would consume 83% of that pool; even 4 h/day is
124 h/month of exposure. The thing being bought is a warm demo catalog; the thing
being risked is unrelated production.

Re-enable it only with a known divisor. Count the **free web services** in the
workspace — static sites and databases do not draw instance hours, so the divisor
is usually smaller than the service count — then pick a window and record the
arithmetic beside the cron.

### Verify rather than assume

```sh
curl -sS <base>/health
```

`catalogSize: 0` with a low `uptimeSeconds` means the container was recently
replaced: expected. Each resource returns on its next settled payment.

The permanent fix is durable storage, scoped in
[`docs/milestone-durable-catalog.md`](./milestone-durable-catalog.md).

---

## 6. "`/health` reports `unverifiableEntries`"

A non-zero `unverifiableEntries` means one or more sellers advertise a
`resource.url` the facilitator **can never fetch** — so those entries are
permanently unverified, no matter how long you wait.

This is distinct from "not verified yet". While `VERIFICATION_API_URL` is unset
every entry reads unverified, so that flag carries no information; this count
does.

### Cause, in order of likelihood

1. **The seller advertises `http://localhost:…`.** This was the default in
   `examples/seller.mjs` and it made ownership verification vacuous in production
   for the whole of its life. Fix: set `PUBLIC_BASE_URL` on the seller to the
   address it is actually reachable at.
2. **The seller advertises a private or loopback literal** over https.
3. **The resource declared a `routeTemplate`**, so the catalog key is
   `origin + /quote/:symbol` — not a fetchable URL. Structural; nothing to fix.

### Confirm which

```sh
curl -sS '<base>/discovery/resources' | python3 -m json.tool | grep '"resource"'
```

Any entry whose URL is not public https is one of the above. The log also names
each one once, when it is first cataloged:

```
[catalog] <url> can never be ownership-verified: ...
```

---

## 7. Demonstrating F12 (the per-URL settle budget) — read this first

**Do not write the test before reading this.** The obvious harness produces a
result that looks like a pass and is not one.

Twelve concurrent settles through one `SIM_SOURCE_ACCOUNT` gave **1 success and
10 failures** during the 2026-08-10 walkthrough. That is the shape of a budget
admitting a few and refusing the rest — and it was nothing of the kind. F12 is
**log-only on testnet and cannot refuse anything**; all twelve shared one
sequence number and eleven lost the race. Crediting the control for that would
have been a fabricated pass.

Requirements, in full, are in
[`walkthrough-results.md` §W-2](./walkthrough-results.md). The short version:

- **one funded classic source account per concurrent settler** — sharing one is
  the entire trap;
- **≥ 12 of them**, concurrent, inside 60s (sequential tops out at 6 per window
  at the measured ~8s per settle, and can never reach the threshold);
- **there is no enforce flag** — `policy.ts:112` keys enforcement off
  `network === "stellar:pubnet"`. On testnet, assert on the structured log
  `{ payTo, wouldReject }` (`server.ts:216`); for the actual 503, run a local
  instance with `STELLAR_NETWORK=pubnet` against testnet RPC;
- **assert on the response body, never on a success count.** A tripped budget is
  `503 {error: "settlement_refused"}`. A sequence collision is a submission error
  containing `tx_bad_seq`. They are indistinguishable by count alone.

## Related

- `docs/walkthrough-results.md` — what was proven live on 2026-08-10, what was
  not, and why; includes the F12 reproduction requirements above.
- `docs/security-audit.md` — findings F1–F12 and G-1…G-9, with what each control
  does and does not do.
- `render.yaml` — deployment posture, including the disk-attachment warning that
  leads to procedure 2.
