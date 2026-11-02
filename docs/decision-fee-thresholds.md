# Decision memo — the fee ceiling, and what it forces

**Status: RESOLVED 2026-08-14. Test B landed; `MAX_TX_FEE_STROOPS = 500,000`
stands; no value changes. See § Resolution at the end.**

Every number below carries its source. Where a number is *simulated* rather than
settled on-chain it says so, because D-4 was caused by a figure defended as
"measured" that carried no transaction hash.

---

## The numbers, with provenance

| Value | Source |
| --- | --- |
| **28,711** stroops charged, **38,888** max_fee | tx `1da6f9e6a90b78da898c99dfefba8821b5f632b72f584968fb057fd8a298e039`, Horizon testnet. **On-chain, hash-verifiable.** |
| **26,222,858** stroops | **SIMULATED, never submitted — and RETRACTED** (audit D-4): a stale reading from an unhealthy RPC node. The same wallet, same script, re-measured later at **32,655**, four times, from fresh processes. Left in this table because the decision below was framed against it. |
| **140,331** stroops | **SIMULATED, no hash (nothing settled). Test B, 2026-08-14, SDK side:** a freshly provisioned policy-governed wallet simulating a signed payment. Single reported figure; under D-4's protocol it counts as an observation until independently re-measured — but this decision does not rest on it alone (see Resolution). |
| **17,714** stroops | **Derived**, not measured: published rates × observed resources (2,836,645 instructions @7/10k; 5 reads @1,563; 3 writes @2,500; 124B read, 420B written). |
| **1,363,909** / **552,074** | **Simulated** `extendFootprintTtl` to max TTL — asset instance / balance entry. |
| **127,808** | **No hash. Unverifiable.** Cited in five places as measured; see D-4. |
| 500,000 · 50,000,000 · 100,000,000 · 10 | `src/config.ts` — fee ceiling, spend ceiling, hard floor, perUrlMax. |

---

## 1. Three thresholds, not one

`perSettleEstimateStroops` **is** `maxTransactionFeeStroops` (`src/server.ts`), so
the fee ceiling drives the spend policy's per-settle estimate. Raising it alone
does not work:

| | Now | If the ceiling becomes 30,000,000 |
| --- | --- | --- |
| Settles per 5 XLM window | 100 | **1** |
| For the 11-settle F12 evidence | fits | needs `SPEND_CEILING_STROOPS` ≈ **29 XLM** |
| Hard floor (must exceed the ceiling) | 10 XLM | must exceed **29 XLM** |

So "raise the fee ceiling" is really: fee ceiling ×60, spend ceiling ×6, hard
floor ×3. Each is a security value with its own reasoning, and the audit doc's
rationale tests (`src/config.thresholds.test.ts`) assert relationships between
them that would all need re-deriving.

---

## 2. The question underneath: is fee-sponsorship viable at this price?

The product proposition is *"buyers hold only the payment asset, no XLM — the
facilitator sponsors the fee."* That is cheap at 28,711 stroops (0.0029 XLM) per
settlement. At the simulated 26,222,858 (2.62 XLM) it is a different business.

For a 1,000,000-atomic payment, a **2.62 XLM** sponsorship cost almost certainly
exceeds the value of the payment being sponsored. Sponsorship stops being a
convenience the facilitator absorbs and becomes the dominant cost of the
transaction.

That is a **product** question, not a threshold question, and raising numbers
does not answer it. If the cost is real and persistent, the options are
structural — charge the merchant, cap sponsorship per payment, or require the
payer to cover fees above a threshold — and none of them are config changes.

---

## 3. Is this testnet-specific? Partly, and not the way you would expect

**The rent parameters are IDENTICAL on both networks** (queried live from
`configSettingContractLedgerCostV0`):

```
                                    TESTNET      PUBNET
rentFee1KbSorobanStateSizeLow       -17,000      -17,000
rentFee1KbSorobanStateSizeHigh       10,000       10,000
sorobanStateRentFeeGrowthFactor       5,000        5,000
feeWriteLedgerEntry                   2,500        2,500
feeDiskReadLedgerEntry                1,563        1,563
```

So this is **not** a testnet quirk in the rules. Same pricing model, same
constants.

But the model is **state-size dependent** — the fee scales with the network's
total Soroban state, between the Low and High rates by the growth factor. The two
networks hold different amounts of state, so **the same payment costs different
amounts on each**.

**Consequence: a pubnet number cannot be derived from these parameters. It has to
be measured on pubnet.** And measuring it means a real payment with real XLM. Any
pubnet ceiling set before that measurement is a guess — which is exactly the
posture D-4 criticises. If the pubnet figure is also ~2.6 XLM, §2's product
question becomes urgent rather than theoretical.

---

## 4. What the walkthrough proves if we DON'T raise anything

**Preferred.** Scoping the evidence down is honest; raising three security values
to make a test pass manufactures the result. The controls would then be verified
under a configuration that does not exist in production.

Still fully demonstrable with the ceiling at 500,000 — these need no settlement:

- **F11 Layer 2** — already proven live (D-4 predecessor run: real DNS, real TLS,
  pinned address, `match`, with a wrong-payTo control returning `mismatch`)
- **F7 baseline hardening** — probed on the deployed service
- **D-3 / `/whoami`** — advertised state queryable and agreeing with the 402
- **The fee ceiling itself, working as designed** — it refused a payment whose
  simulated cost exceeded it, loudly and with a specific reason. That is a
  control doing its job, and it is worth recording as such.

**Not demonstrable without settlements, and they stay unproven:** F11 Layer 1
(TOFU binding), F12 budgets, G-3 canonical key, G-4 stats gate, G-1 re-verify,
F3 balance guard.

That is six controls with unit tests and no live evidence — unchanged from the
current position in the audit doc, and honestly recorded there rather than
papered over.

---

## Recommendation (as written while blocked)

**Change nothing until Test B lands.** If a fresh wallet and fresh SAC also
simulate at ~26M, the finding is that smart-account payment costs moved
network-wide, `MAX_TX_FEE_STROOPS = 500,000` is correct against its evidence and
obsolete against current conditions, and §2 is the real decision — not §1.

If either comes in cheap, the provisioning path differs from the spike path in
some way not yet identified, and the walkthrough proceeds unchanged.

Either way, the six settle-path controls stay unproven until a payment settles,
and that should be stated as the limit of the exercise rather than engineered
around.

---

## Resolution — 2026-08-14, Test B landed on the cheap branch

**A freshly provisioned policy-governed wallet simulates a signed payment at
140,331 stroops** (SDK side; simulated, nothing settled, so no hash). The fresh
wallet is newer than `CCXPXAP4…` and does strictly *more* work — it runs a
policy inside `__check_auth` — so if smart-account costs had moved network-wide,
this is exactly the reading that would have shown it. It did not.

That closes the question from the second flank. Audit D-4 had already closed the
first: the 26.2M reading was a stale simulation from an unhealthy RPC node, and
the *same* wallet re-measured at 32,655. Between them, the anomaly is fully
localized — not a property of the network, and not a property of
policy-governed wallets as a class.

**The ceiling therefore stands on three independent, mutually consistent
readings**, which is why the single-figure caveat on 140,331 does not weaken the
conclusion:

| Reading | Provenance |
| --- | --- |
| 28,711 charged | on-chain, hash-verifiable |
| 32,655 simulated | the spike wallet, re-measured 4x from fresh processes (D-4) |
| 140,331 simulated | fresh policy-governed wallet, Test B |

Headroom: **500,000 / 140,331 ≈ 3.6×** against the most expensive verified
reading — a defensible basis for the README's claim, replacing the unverifiable
127,808 (which lands in the same band, but carries no provenance and stays
retired per D-4).

**What this resolution does NOT change:**

- §1's cascade analysis survives as method for any future real fee anomaly.
- §2's product question recedes to theoretical: at ~0.014 XLM per settle,
  sponsorship is a convenience again, not a cost center.
- §3 stands in full: **a pubnet ceiling still cannot be derived — it must be
  measured on pubnet**, and remains part of the pubnet gate (thresholds
  blocker).
- The six settle-path controls without live evidence are unchanged by any of
  this; settlement, not simulation, is what proves them.

---

## §3's pubnet measurement — 2026-11-02, 11 real settlements

The pubnet figure §3 said could only come from a real payment now exists:
11 confirmed mainnet settlements, Sep 17–21 2026 (`docs/mainnet-evidence.md`),
`fee_charged` read directly from Horizon
(`GBB7PVDR642MJSALMD3PN4SAPZHUJP555XQMFJJNUH3AN33UQY7FVL3H`'s transaction
history) and matched against every documented tx-hash prefix.

| # | Date (UTC) | Tx hash | `fee_charged` (stroops) |
| --- | --- | --- | --- |
| 1 | Sep 17 13:19 | `7288cd138c5e2770784738b2903b3728f049f659d3d6da42e19976783edefef3` | 23,565 |
| 2 | Sep 17 15:33 | `b6898a10abebce5de92b9610fadfac470c48379bffdefb9ce81b581f4e0d3c07` | 23,565 |
| 3 | Sep 17 21:21 | `6ec03c83e5d7a45ed87603fae5dea18f4c205f65ff73e5fcef6614b606001275` | 23,645 |
| 4 | Sep 19 03:39 | `3b40e5b23d52388c7905b3a46b31c5e0b709e0b8a4a95125ac674937cbe37925` | 23,565 |
| 5 | Sep 19 13:41 | `237c91c3044dfc66e7498096637c10ce65041e7a744d9cd65a0cbc3f9d29c1f7` | 23,565 |
| 6 | Sep 19 20:24 | `09b24dc9fb78c5596cb780fee26c57bb17d5eee0e9cc7035ebae938e54752a14` | 23,678 |
| 7 | Sep 20 02:43 | `a2d6ee5eab785d6b5a5401028fa7ba414d8b2a6cac0a3568b3f8a8cf98f87f57` | 23,984 |
| 8 | Sep 20 12:06 | `babb0a72bcb94e80be61dff1fa56ec9a5ebd45c62caa139e03076ced5f55962f` | 23,565 |
| 9 | Sep 20 12:40 | `3401e34161883219abd3543752f19731fba39b31c108119add8138903ad0d742` | 23,565 |
| 10 | Sep 20 13:00 | `f5137a9cf90c39bd6680eb5dae3548a0ee2e2b0dffec059072e72882709cefe0` | 23,565 |
| 11 | Sep 21 12:17 | `4abe6af7e71acb3ceea0fa30a9649768e05d2efb67e04f573112e214a40db458` | 23,565 |

**min 23,565 · median 23,565 · max 23,984** (mean ≈ 23,621).

Next to the testnet figures above: mainnet's real charged fee (23,565–23,984)
is *lower* than testnet's one real settled figure (28,711), and far lower
than either testnet simulation (32,655; 140,331).

**This sample does NOT size a threshold, deliberately.** All 11 are plain
`exact`-scheme transfers from a team-funded wallet (`docs/mainnet-evidence.md`)
— the policy-governed (smart-account) case that simulates at ~140,331 on
testnet is not represented at all, and it is exactly the case most likely to
cost more. Eleven samples of the cheapest case say nothing about the
expensive one. `MAX_TX_FEE_STROOPS` stays at 500,000 for this reason, not
despite it: the ceiling has to admit a policy-governed payment, which this
sample cannot bound.

**The fix is in the accounting, not the ceiling.** G-10's actual finding —
the spend policy reserves the flat 500,000-stroop estimate per settlement
against a real charge around 20,000–24,000 on both networks — doesn't need a
bigger or better sample to fix, because the problem isn't that 500,000 is
the wrong ESTIMATE; it's that an estimate is being reserved at all when the
real, transaction-specific simulated fee is already known before submission.
See `docs/closing-state.md`'s G-10 row for the accounting change.
