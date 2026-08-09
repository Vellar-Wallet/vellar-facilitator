# Operator runbook — vellar-facilitator

Procedures for problems you cannot fix by redeploying. Written to be followed by
someone who did not write this code, at 2am, while a merchant is complaining.

Each procedure states the **symptom** you will actually see first, how to
**confirm** it is the thing you think it is, the **steps**, and how to **verify**
afterwards. Do not skip the confirm step — two of the problems below look
identical from the outside and have opposite fixes.

---

## 1. "My payments settle, but the catalog still lists my old payment address"

This is **G-2**: a resource URL's `payTo` is bound on first use and there is no
in-band way to rotate it.

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

3. **Back both files up**, together, to the same timestamped directory:
   ```
   cp /var/data/bazaar-catalog.json          /var/data/backup-$(date +%s)/
   cp /var/data/bazaar-catalog.json.ownership /var/data/backup-$(date +%s)/
   ```
   Back up **both**. A catalog file without its companion ownership file makes
   the service come up frozen — see procedure 2.

4. **Edit the ownership file.** It is a JSON array of
   `{ "resource": <canonical-url>, "boundPayTo": [<address>, ...] }`. Find the
   row whose `resource` matches, and **append** the new address:

   ```json
   { "resource": "https://api.merchant.example/quote",
     "boundPayTo": ["GOLD...ADDRESS", "GNEW...ADDRESS"] }
   ```

   **Append, do not replace.** Removing the old address is a separate decision:
   any accepts entry still carrying it will be quarantined on the next load, and
   if it was the *first* entry the whole binding re-derives from it. Adding is
   reversible; removing is not.

   The `resource` value must be the **canonical** URL — `origin + pathname`, with
   no query string or fragment. If the merchant gave you a URL with `?...`, strip
   it. A row whose key has a query string will simply never match.

5. **Check the JSON parses** before restarting. This matters more than it looks:
   an unparseable ownership file does not fail loudly, it makes the catalog come
   up **frozen and empty** (procedure 2).
   ```
   python3 -m json.tool /var/data/bazaar-catalog.json.ownership > /dev/null && echo OK
   ```

6. **Start the service.**

### Verify

1. `/health` must **not** report a frozen catalog:
   ```
   curl -sS <base>/health
   ```
   `catalogFrozen` must be `false`. If it reads `"ownership-unreadable"`, your
   edit did not parse — restore from the backup in step 3 and try again.

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

### Steps — migration case only

1. Set `CATALOG_OWNERSHIP_BOOTSTRAP=1` in the environment (dashboard, not
   `render.yaml` — it is deliberately not declared there).
2. Start the service **once**. It will derive each URL's owner from the first
   `accepts` entry in the catalog file and warn loudly on every boot while set.
3. **Remove the variable** and restart.

Understand what you just granted: bootstrap trusts the catalog file to name each
resource's owner. It grants **no more trust than that file already had** — but if
that file was tampered with, you have now made the tampering durable. Only do
this when you know where the file came from.

> Known gap (**G-7**): the bindings derived during a bootstrap run are seeded in
> memory but are not immediately written to the ownership file. After the
> bootstrap boot, confirm `<CATALOG_FILE>.ownership` actually exists and contains
> a row per entry before removing the variable. If it does not, keep the variable
> set for one more boot rather than restarting without it.

### Verify

`/health` reports `catalogFrozen: false`, and `/discovery/resources` returns the
expected entries.

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

## Related

- `docs/security-audit.md` — findings F1–F12 and G-1…G-9, with what each control
  does and does not do.
- `render.yaml` — deployment posture, including the disk-attachment warning that
  leads to procedure 2.
