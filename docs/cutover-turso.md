# Turso cutover — what was observed, 2026-08-11

Where: facilitator `https://vellar-facilitator.onrender.com` (Render, Oregon),
database in Turso `ap-northeast-1` (Tokyo). All times UTC. Every settlement
figure below is confirmed on Horizon, not read off the `/settle` response.

---

## 1. The cutover landed

`GET /health` at 00:35Z:

```json
{"status":"ok","uptimeSeconds":114,"catalogSize":0,"commit":"6538141"}
```

- **`commit` 6538141 == `main` HEAD** — the deployed build is the merged one,
  checked rather than assumed. The `/health` commit field exists because a
  pre-audit build once ran unnoticed for days.
- **No `catalogFrozen` field**, which is the load succeeding. The field is
  emitted only when truthy, so its absence distinguishes *"connected to Turso and
  read an empty ownership table"* from *"could not read it"* — the two states
  that both show `catalogSize: 0`.
- `catalogSize: 0` is expected: the cutover starts empty by design.

## 2. Latency — the honest version

**The store write is not resolvable in this measurement, and the reason is the
measurement, not the store.**

Nine `POST /settle` attempts, timed client-side (round trip to the facilitator,
excluding the seller):

| Outcome | n | Range |
| --- | --- | --- |
| Settled | 6 | **5,652 – 9,339 ms** |
| Failed before submission | 3 | **1,548 – 1,848 ms** |

The first attempt (8,832 ms) is the one that binds, and is therefore the only one
that **awaits** the transpacific write; every later attempt for the same URL does
not. That difference is expected to be **~250 ms**, and it is invisible inside a
**3.7-second spread** between successes. The settle path is dominated by on-chain
confirmation, not by the catalog.

**So the operationally relevant answer is: no detectable change.** The
post-cutover success range (5.7–9.3 s) sits inside the pre-cutover range measured
today with the same probe (4.1 s, 5.5 s) and in the walkthrough (~8 s typical).

**What this does NOT establish.** It does not measure the Turso round trip. The
~250 ms figure remains **derived from protocol shape, not observed on the wire**,
and this run did not change that. Isolating it needs server-side timing around
the store call — a small instrumentation change, not made here because nobody
asked for it and it would ship a metric nobody agreed to.

What *is* now pinned in code: the number of round trips. `bindAndUpsertEntry`
makes exactly **one** request, asserted by a test that proxies the client and
counts calls, mutation-verified against a revert to the interactive-transaction
form. That test exists because four round trips cost microseconds in-process, so
the regression is invisible to a suite running in one datacenter.

## 3. The 1-in-3 failures RECURRED, and now have a name

Flagged after the walkthrough as a hypothesis to test if it recurred. **It
recurred, at the same rate, and this run identifies it.**

| | Walkthrough (2026-08-10) | This run |
| --- | --- | --- |
| Rate | 3 of 11 | **3 of 9** |
| Visible as | empty-body 402 from the seller | named error, direct from `/settle` |

```json
{"success":false,"transaction":"",
 "errorReason":"settle_exact_stellar_transaction_submission_failed"}
```

Three things follow, and only the first is a conclusion:

1. **It is not the cutover.** The failure is at *submission*, before the chain
   sees anything — `transaction` is empty, so nothing reached Horizon and the
   catalog is not involved at any point in the path. The rate is unchanged from
   before Turso existed.
2. **It costs nothing.** An empty `transaction` means zero sponsor XLM was spent,
   and `server.ts` releases the spend reservation on exactly that condition.
3. **The earlier hypothesis is now testable, not confirmed.** "The same RPC
   pathology that produced the retracted 26 M" fits — a submission that fails
   before reaching the network is consistent with an RPC having a bad moment —
   but *fits* is not *shown*. What would settle it: capture the RPC's own error
   beneath `settle_exact_stellar_transaction_submission_failed`, which
   `@x402/stellar` currently collapses into one reason string, and re-run against
   a second provider. **Still a lead.**

**Why this was nearly missed twice.** The failures are FAST — 1.5–1.8 s against
5.7–9.3 s for a success — because they skip confirmation polling. My first pass
grepped only the elapsed time and read them as fast successes; the settlement
counter (`settlements: 5` after 7 attempts) is what exposed it. A latency
measurement that silently includes failures reports the failures as good news.

## 4. Restart — OBSERVED. The catalog survived a container replacement.

**First time in this project's history.** Every previous restart emptied it.

## 5. Restart result

Method: no requests to the facilitator for >15 minutes, so Render spins the
service down. Spin-down **replaces the container** rather than pausing it —
measured at a 35.7 s cold start on 2026-08-11 pre-cutover, which is what makes it
a stronger test than a redeploy: nothing of the previous process survives.

Before the quiet window, at 00:38:59Z:

```
catalogSize   1
resource      https://vellar-seller-demo.onrender.com/quote
accepts       ['GBJX3E4GDO6IT5ZHWM5LVCXYCHN5L3HWZNKFHJMCR6JZJNBL3VVQL2RH']
settlements   6   uniquePayers 1   observed 6   ownerVerified True
```

The number that matters after the restart is **`accepts`**, not `catalogSize`: an
entry can be rebuilt by the next settlement, but a *binding* cannot. If the
binding survives, a squat on this URL is no longer possible and — the same fact
seen from the other side — no longer self-heals.

### The wake-up, 00:57:49Z

```
$ time curl -s .../health          # first request after 17 minutes of silence
{"status":"ok","uptimeSeconds":24,"catalogSize":1,"commit":"6538141"}
                                    real  42.166s
```

**42.2 seconds** is the proof that this is a replacement and not a resume — an
idle-but-alive instance answers in ~200 ms — and `uptimeSeconds: 24` is a process
that did not exist a minute earlier. **`catalogSize: 1`.**

### What came back, field by field

```
resource      https://vellar-seller-demo.onrender.com/quote
accepts       ['GBJX3E4GDO6IT5ZHWM5LVCXYCHN5L3HWZNKFHJMCR6JZJNBL3VVQL2RH']
settlements   7   uniquePayers 1   observed 0   statsSource persisted   ownerVerified False
```

Four of those are controls behaving correctly, and three of them had never been
observed in production because the state they describe could not previously
exist:

| Field | Reading |
| --- | --- |
| `accepts` unchanged | **The binding survived.** This is the milestone. An entry rebuilds from the next settlement; a binding does not. |
| `observed: 0` | Correct. This process has witnessed nothing. |
| `statsSource: persisted` | **RA-13 working live.** `settlements: 6` is disclosed as inherited rather than presented as witnessed — the honest signal, on real restored data, for the first time. |
| `ownerVerified: false` | **RA-9 working live.** A verified flag is never trusted from storage, however it got there. |

### The binding is ENFORCED, not merely displayed — 00:59:51Z

A restored `accepts` array proves a string survived. It does not prove the
facilitator will *act* on it. So B attempted the same squat against the restored
binding:

```
[squat] HTTP 200  71537b2dbc5e551f…      Horizon: successful=True, fee 22,579, sponsor-paid
accepts     ['GBJX3E4G…']  ->  ['GBJX3E4G…']   UNCHANGED
settlements 6 -> 6      observed 0 -> 0
```

**The payment went through and the catalog refused it** — which is what makes
this evidence rather than an indistinguishable failure. F11 Layer 1 now enforces
a binding it loaded from Turso, a state that has never existed before.

### G-1 — PROVEN, and it could not have been before

The walkthrough recorded G-1 as **NOT DISTINGUISHABLE**: without persistence every
post-restart settle is a *first* catalog, which verifies anyway, so the
re-verify-a-RESTORED-entry path could not be separated from first-catalog
verification. The brief said durable storage would make it testable.

At 01:00:21Z the bound owner settled against an entry that already existed
(`catalogSize` was 1 before the call, so this was **not** a first catalog):

```
before   ownerVerified False   settlements 6   observed 0
after    ownerVerified TRUE    settlements 7   observed 1
```

`7cab7329a3d5a1c3…`, Horizon `successful=True`. **The re-verify fired on a
restored entry and restored the badge** — the exact path G-1 was written for,
observed end to end for the first time. `statsSource` remains `persisted`, which
is right: 6 of the 7 are still inherited.

## 6. Status of the six controls the walkthrough could not close

| Control | Walkthrough (2026-08-10) | Now |
| --- | --- | --- |
| **G-1** re-verify on a restored entry | NOT DISTINGUISHABLE | **PROVEN** — `7cab7329…` |
| **Durable catalog** | did not exist | **PROVEN** — survived a 42.2 s cold start |
| **F11 Layer 1 on a restored binding** | impossible to reach | **PROVEN** — `71537b2d…` settled, catalog refused |
| **RA-13** stats disclosure on real restored data | unit tests only | **OBSERVED** — `statsSource: persisted`, `observed: 0` |
| **RA-9** verified flag not trusted from storage | unit tests only | **OBSERVED** — `ownerVerified: false` after load |
| **F12** per-URL budget | NOT REACHABLE (needs 11 settles/60 s) | unchanged — still needs several funded source accounts |

## 7. The cost is now real

A squat on a bound URL no longer clears itself. The binding above survived a
container replacement, which is precisely what makes the recovery manual:
[`operator-runbook.md` §1](./operator-runbook.md), by hand, until the
displacement variant ships. That is the trade that was accepted, and it is now in
force rather than pending.
