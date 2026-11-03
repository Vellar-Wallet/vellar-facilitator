// PREPARE-ONLY. DO NOT RUN THIS SCRIPT.
//
// This is a specification, written as runnable code so every step is
// concrete, for demonstrating F12 (the per-URL settle budget) against the
// LIVE mainnet facilitator. It spends real USDC and real XLM fees. Running
// it is a decision for a human with access to fund the thirteen payer
// accounts below — not something this script, or the agent that wrote it,
// should ever execute on its own.
//
// Why mainnet changes the demonstration (see docs/walkthrough-results.md
// §W-2 for the testnet-only version this supersedes for a pubnet run):
//
//   - On testnet, F12 is log-only (policy.ts:198, `enforced` keys off
//     `network === "stellar:pubnet"`), so the only testnet-native evidence
//     is the structured log `{ payTo, wouldReject }` at server.ts:805-808.
//     The 503 refusal cannot be observed against the real testnet
//     deployment; you need a side instance with STELLAR_NETWORK=pubnet
//     pointed at testnet RPC to see one.
//   - On mainnet, `enforced` is true by construction. The real 503 is
//     observable directly against the live Railway instance. This script
//     demonstrates THE REFUSAL, not just the accounting.
//
// Why the old "one shared SIM_SOURCE_ACCOUNT" trap (docs/walkthrough-results.md
// §W-2 item 1) does NOT apply here:
//
//   examples/buyer-classic.mjs's own header note confirms SIM_SOURCE_ACCOUNT
//   is no longer used by the official x402 SDK scheme — sequence numbers
//   come from each PAYER's own account, not a shared simulation source.
//   Settlement-side concurrency is isolated by the facilitator's channel
//   pool (CHANNEL_POOL_SIZE, src/config.ts:444 — the 11 real settlements in
//   docs/mainnet-evidence.md used 2 of them, GDEZOW5M... and GDAP7ZVV...).
//   The pool is sized for 50 true-concurrent settles (docs/channel-pool-
//   design.md §2), far above the 12 this demonstration needs. So unlike
//   the 2026-08-10 testnet walkthrough, a tx_bad_seq collision is NOT
//   expected here, and must not be read as a stand-in for a refusal if it
//   somehow occurs — same rule as §W-2 item 5, carried over unchanged.
//
// What this script actually needs, concretely:
//
//   ACCOUNTS: 13 funded classic (G...) payer keypairs — 11 to clear
//   perUrlMax (10), one more past it to confirm the refusal isn't the tail
//   of a rate problem (mirrors §W-2 item 2's N >= 12 reasoning; 13 instead
//   of 12 because this script also reserves one request as a pre-flight
//   sanity settle before the concurrent burst — see STEP 2). Each needs:
//     - a USDC trustline to the Circle issuer (GA5ZSEJY..., per
//       docs/mainnet-evidence.md) authorized for this payTo, and
//     - enough XLM for the trustline reserve plus the x402 payer's own
//       minimum balance (no fee cost to the payer: the facilitator's
//       sponsor account pays the network fee via fee-bump, per
//       docs/mainnet-evidence.md's ~23,565-stroop figure).
//   Funding ask: 0.5 XLM and 0.20 USDC per account is generous headroom
//   (13 * 0.5 = 6.5 XLM, 13 * 0.20 = 2.60 USDC total) for one settle each
//   at the smallest real amount already used in production (0.10 USDC,
//   docs/mainnet-evidence.md row 1).
//
//   AMOUNT: 0.10 USDC per settle — matches the smallest amount already
//   proven live (docs/mainnet-evidence.md), so this demonstration adds no
//   new amount to defend and stays well under any sponsor/spend-ceiling
//   concern (G-10's spendCeilingStroops default is 50,000,000 stroops = 5
//   XLM per 60s window; thirteen settles' real fees, ~23,565 stroops each,
//   sum to roughly 306,000 stroops — about 0.6% of the ceiling).
//
//   RESOURCE: one single x402-protected resource URL, used by all 13
//   payers, so they share one perUrlMax bucket. A resource that already
//   exists in the mainnet catalog is strongly preferred over a new one —
//   ask before standing up a throwaway seller for this.
//
//   WINDOW: all 13 settle calls fired concurrently (Promise.all), not
//   sequentially — perUrlMax's window is rateWindowMs (60s, policy.ts:474),
//   and at the ~8s/settle rate observed in the testnet walkthrough,
//   sequential execution tops out at 6-7 per window and can never trip the
//   budget. This mirrors §W-2 item 3 exactly; only the network changed.
//
// What proves the control fired (mainnet-specific signals, in order of
// strength):
//
//   1. HTTP response bodies — the primary evidence, per §W-2 item 5's rule
//      carried over unchanged: a tripped budget is
//      `503 { error: "settlement_refused" }`; anything else (2xx, or a
//      submission error containing `tx_bad_seq`) is NOT evidence of F12
//      and must be reported as whatever it actually is. Expect exactly 10
//      successes and 3 refusals if perUrlMax=10 is unchanged in prod.
//   2. Structured server logs — `request.log.warn({ payTo, wouldReject })`
//      at server.ts:805-808 fires on EVERY request whose policy check
//      would-reject, including the refused ones; the refused requests
//      additionally log `error: "settlement_refused"` at the 503 return
//      sites (server.ts:753, 800, 872 — confirm against the deployed
//      commit before relying on exact line numbers, same caveat as the
//      walkthrough).
//   3. Prometheus metrics —
//      - `vellar_settle_total{outcome="failure"}` increments by 3 (or
//        however many were refused) at /metrics on the mainnet instance.
//      - `vellar_settle_errors_total{reason="rate_limited_url"}` (or
//        whichever Policy.evaluate() reason string the refusal carries —
//        confirm the exact label against policy.ts's evaluate() return
//        values before asserting on it) increments by the refused count.
//      - `vellar_settle_total{outcome="success"}` increments by exactly
//        10, never more.
//      - `vellar_spend_unreconcilable_total` should NOT move during this
//        run — a G-10 regression, not an F12 signal, if it does.
//   4. Horizon confirmation (§W-2 item 6, unchanged) — fetch each of the
//      10 successful tx hashes from Horizon directly and confirm they
//      landed with the expected USDC amount, so the denominator is real
//      settlements, not merely requests that were sent.
//
// ----------------------------------------------------------------------
// The steps below are written as an outline, not a working implementation.
// Each PAYER_N_SECRET must be a REAL funded mainnet secret key, supplied by
// whoever runs this deliberately — never hardcode a real secret in this
// file.
// ----------------------------------------------------------------------

/*
STEP 0 — preconditions (verify, don't skip):
  - Confirm `perUrlMax` on the deployed mainnet instance. Read it from the
    live config, not this comment: hit an endpoint that echoes config, or
    coordinate with whoever can read the Railway environment, since
    PER_URL_MAX / the matching env var could have been overridden in
    deployment away from policy.ts's in-repo default of 10.
  - Confirm the sponsor account's XLM balance is comfortably above
    SPONSOR_HARD_FLOOR_STROOPS (100,000,000 stroops = 10 XLM default) by
    more than 13 settles' worth of fees, so F3 (the balance guard) cannot
    fire and be confused for F12.
  - Confirm all 13 payer accounts show the expected starting USDC/XLM
    balances on Horizon before firing anything.

STEP 1 — one sanity settle, alone, from payer #13 (the 13th account,
  held in reserve for this purpose):
  - POST to /settle through the normal x402 buyer flow (buyer-classic.mjs),
    exactly once, and confirm it succeeds (2xx, lands on Horizon). This
    confirms the resource, the network, and all plumbing work before the
    concurrent burst — isolates "the control fired" from "something else
    was broken."

STEP 2 — the concurrent burst, payers #1-12:
  - Build 12 independent x402Client + ExactStellarScheme instances, one
    per payer secret, each targeting the SAME resource URL.
  - Fire all 12 settle requests via Promise.allSettled (never Promise.all
    — a single rejection must not abort visibility into the others).
  - Capture, per request: HTTP status, response body, wall-clock time of
    the request.

STEP 3 — classify results:
  - Partition into: 2xx (settled), 503 settlement_refused (F12 fired),
    anything else (investigate before claiming anything).
  - Expect roughly 10 settled, 2 refused among these 12 (perUrlMax=10, and
    payer #13's sanity settle in STEP 1 does not share this window unless
    it ran within 60s of STEP 2 — space them out deliberately, or count
    it toward the 10).

STEP 4 — pull evidence:
  - Scrape /metrics on the mainnet instance immediately after STEP 2
    completes; diff against a /metrics scrape taken immediately before
    STEP 1.
  - Pull the facilitator's structured logs for the exact time window (via
    whatever log aggregation Railway is wired to) and grep for
    "wouldReject" and "settlement_refused".
  - Fetch each successful tx hash from Horizon and confirm amount, asset,
    and destination match.

STEP 5 — write up:
  - One row per payer: account, request outcome, tx hash (if settled),
    timestamp.
  - The /metrics diff, pasted verbatim.
  - The matching log lines, pasted verbatim.
  - Explicit confirmation of the denominator (Horizon-confirmed count vs.
    requests sent), per §W-2 item 6.
*/
