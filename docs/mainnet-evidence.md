# Mainnet evidence

Every x402 settlement the facilitator has made on Stellar pubnet, and the
accounts behind them, so a reviewer can verify the traction claim without
trusting this document. All of it is USDC (Circle issuer `GA5ZSEJY…`) moving
to a single `payTo` (`GD6TC7QY…`), submitted by one of two channel accounts,
fee-bumped by the sponsor account (`GBB7PVDR…`, ~23,565 stroops per tx).

These are end-to-end tests, not third-party usage: both payers were funded by
a team-controlled account. Do not describe them as users or customers.

## Settlements (11 total, 3.10 USDC, Sept 17–21, 2026 UTC)

| # | Date (UTC) | USDC | Payer | Channel | Tx hash (first 12) |
|---|---|---|---|---|---|
| 1 | Sep 17 13:19 | 0.10 | GCNTW6FN… | GDEZOW5M… | 7288cd138c5e… |
| 2 | Sep 17 15:33 | 0.10 | GCNTW6FN… | GDEZOW5M… | b6898a10abeb… |
| 3 | Sep 17 21:21 | 0.10 | GCNTW6FN… | GDAP7ZVV… | 6ec03c83e5d7… |
| 4 | Sep 19 03:39 | 0.50 | GDTAQ7MT… | GDEZOW5M… | 3b40e5b23d52… |
| 5 | Sep 19 13:41 | 0.50 | GDTAQ7MT… | GDAP7ZVV… | 237c91c3044d… |
| 6 | Sep 19 20:24 | 0.50 | GDTAQ7MT… | GDEZOW5M… | 09b24dc9fb78… |
| 7 | Sep 20 02:43 | 0.50 | GDTAQ7MT… | GDEZOW5M… | a2d6ee5eab78… |
| 8 | Sep 20 12:06 | 0.10 | GCNTW6FN… | GDEZOW5M… | babb0a72bcb9… |
| 9 | Sep 20 12:40 | 0.50 | GCNTW6FN… | GDEZOW5M… | 3401e3416188… |
| 10 | Sep 20 13:00 | 0.10 | GCNTW6FN… | GDAP7ZVV… | f5137a9cf90c… |
| 11 | Sep 21 12:17 | 0.10 | GDTAQ7MT… | GDEZOW5M… | 4abe6af7e71a… |

No x402 transfer has reached the `payTo` account after Sep 21, 2026. If this
document is read after a later settlement, that settlement is not yet listed
here — update the table, don't extrapolate from it.

## Account map

| Account | What it is | Evidence |
|---|---|---|
| `GBB7PVDR…` | Facilitator sponsor / fee account | Fee account on all 11 settlements above; created five channel accounts on Sep 15 (tx `148f1604…`) |
| `GDEZOW5M…`, `GDAP7ZVV…` | Channel accounts used (8 and 3 settlements respectively) | Match the signers in the facilitator's captured `/supported` response |
| `GAJFQEVB…`, `GAQDNEHY…`, `GCHPKEKC…` | Channel accounts created, never used | One transaction each (their creation) |
| `GD6TC7QY…` | `payTo` of the wallet's lifecycle endpoint | `vellar-dapp` `lifecycle-service/src/server.ts:177`; team wallet active since Feb 2026 |
| `GBBA3HN2…` | `payTo` of the wallet's verification endpoint; creator/funder of both payers | `verification-service/src/server.ts:399`; `create_account` ops Sep 17–18 |
| `GCNTW6FN…`, `GDTAQ7MT…` | The two payers | Funded by `GBBA3HN2` → team-controlled, not external users |

## What this does and does not show

**Shows:** the facilitator's settle pipeline works end-to-end on pubnet — fee
sponsorship via channel accounts, `exact` scheme settlement, correct routing
to the seller's `payTo`.

**Does not show:** external adoption. Both payers trace back to a
team-controlled funding account, and no external seller has been catalogued
in the mainnet Bazaar as of this writing. The onchain growth metric (target:
≥ 200 settlements, ≥ 10 external payers, ≥ 5 external sellers in a 30-day
window) tracks that gap explicitly rather than papering over it.

Re-verify any of the above by querying [stellar.expert](https://stellar.expert/explorer/public)
for the accounts listed, or via a Horizon `payments` query scoped to the
sponsor and channel accounts above.
