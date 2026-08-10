# Decision memo — the fee ceiling, and what it forces

**Status: analysis only. No value changed. Blocked on Test B.**

Every number below carries its source. Where a number is *simulated* rather than
settled on-chain it says so, because D-4 was caused by a figure defended as
"measured" that carried no transaction hash.

---

## The numbers, with provenance

| Value | Source |
| --- | --- |
| **28,711** stroops charged, **38,888** max_fee | tx `1da6f9e6a90b78da898c99dfefba8821b5f632b72f584968fb057fd8a298e039`, Horizon testnet. **On-chain, hash-verifiable.** |
| **26,222,858** stroops | **SIMULATED, never submitted.** `simulateTransaction` on the signed payment from `CCXPXAP4…` to `CDYCX4PE…`. Reproduced at 26,314,797 and 26,315,012. No hash exists because nothing settled. |
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

## Recommendation

**Change nothing until Test B lands.** If a fresh wallet and fresh SAC also
simulate at ~26M, the finding is that smart-account payment costs moved
network-wide, `MAX_TX_FEE_STROOPS = 500,000` is correct against its evidence and
obsolete against current conditions, and §2 is the real decision — not §1.

If either comes in cheap, the provisioning path differs from the spike path in
some way not yet identified, and the walkthrough proceeds unchanged.

Either way, the six settle-path controls stay unproven until a payment settles,
and that should be stated as the limit of the exercise rather than engineered
around.
