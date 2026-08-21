#![no_std]
//! Provider bond escrow contract for the Vellar Bazaar.
//!
//! ## Scope of this slice
//!
//! This is the THIRD of several passes building out `docs/proposal-provider-bond.md`. The first
//! pass built the core data model (`Listing`, `SettlementRecord`), `register_settlement`, and
//! `deposit`. The second pass added `withdraw` and `file_dispute` (payer-gated, rate-limited
//! dispute filing). This pass adds dispute *resolution*:
//!
//!   6. `set_delivery_key` — registers (or rotates) a listing's delivery-signing public key (Gap
//!      1 below).
//!   7. `post_receipt` — verifies a signed delivery receipt and, if valid, defeats an open
//!      dispute without touching the bond (Section 3: "the seller can defeat the dispute by
//!      producing the same receipt on-chain").
//!   8. `finalize` — permissionless slash execution once a dispute's response window has expired
//!      with no valid receipt posted (Section 3: "if the window closes with nothing produced, the
//!      slash executes automatically via a permissionless finalize call").
//!
//! Resolving `file_dispute`'s previously-open question directly: both `post_receipt` and
//! `finalize` delete the `Dispute` record on resolution (option (a) that doc-comment left open),
//! so `file_dispute`'s existing `DisputeAlreadyOpen` check ("does a `Dispute` record exist")
//! continues to work completely unmodified for the resolved case — a `payment_id` whose dispute
//! was defeated by a receipt, or whose bond was slashed, can be disputed again in the future (a
//! new settlement standing would be required anyway, since `Dispute` is keyed by `payment_id` and
//! `payment_id`s are single-use per `register_settlement`'s own doc-comment).
//!
//! ## Gap 1 — where the seller's delivery-signing public key gets registered
//!
//! The design doc (Section 3) locks that sellers sign delivery receipts with "a dedicated
//! delivery-signing keypair, distinct from the payTo funds-custody key," and that `post_receipt`
//! verifies a signature against it — but it never says how the contract learns this public key.
//! Two shapes were available:
//!
//!   * **A required parameter on `deposit`, stored on `Listing` at listing-creation time.**
//!     Simple, and ties the key to the same call that brings a `Listing` into existence. Rejected
//!     as the *sole* mechanism: Section 3's own stated reason the delivery key is split from the
//!     funds key is that it "lives hot on a seller's internet-facing server answering every
//!     request" and can be compromised — the same threat model the design doc discusses for why
//!     it's separate from `payTo` in the first place. A key that can only be set once, at
//!     deposit time, would force a seller who suspects compromise to fully withdraw and
//!     re-deposit their bond just to rotate a signing key, which conflates two totally unrelated
//!     operations (bond custody vs. delivery-signing identity) and makes recovery from a
//!     suspected compromise unnecessarily expensive and slow.
//!   * **A dedicated `set_delivery_key(seller, resource_key, pubkey)` entry point, gated by
//!     `seller.require_auth()`, callable any time — including to rotate the key — independent of
//!     `deposit`/`withdraw` (CHOSEN).** Lets a seller register a delivery key before or after
//!     bonding, and rotate it immediately on suspected compromise without touching bond custody
//!     at all. This is the more defensible default given the task's own framing: recovery from a
//!     delivery-key compromise should not require re-depositing the bond. The cost is one more
//!     entry point and one more `Option<BytesN<32>>` field on `Listing` (a listing may exist with
//!     no delivery key registered yet, if a seller bonds before wiring up receipt-signing) — a
//!     small, justified complexity increase for a real recoverability property.
//!
//! Stored as `Listing.delivery_pubkey: Option<BytesN<32>>` — `None` until the seller first calls
//! `set_delivery_key`. `post_receipt` against a listing with no delivery key registered fails
//! with `NoDeliveryKeyRegistered` (see that function's doc-comment) rather than treating a
//! missing key as an automatic-fail-open or automatic-fail-closed case implicitly.
//!
//! **What "current" key means when a key is rotated after a dispute was filed:** `post_receipt`
//! always verifies against whatever `Listing.delivery_pubkey` holds AT THE MOMENT `post_receipt`
//! is called — not a key snapshotted at `file_dispute` time, and not the key that was live when
//! the receipt was originally signed. This is the only choice available without adding new state:
//! a `Dispute` record does not (and, per Section 3, has no reason to) carry a copy of the
//! delivery key that was active when it was filed, since disputes are about whether a valid
//! receipt exists NOW, at resolution time, not about pinning cryptographic material to a point in
//! the dispute's history. The practical consequence, stated plainly: if a seller rotates their
//! delivery key AFTER signing a receipt but BEFORE that receipt is posted on-chain to defeat a
//! dispute, the old receipt — genuinely valid when it was produced — will no longer verify
//! against the new key, and `post_receipt` will reject it. This is a real, accepted seller-side
//! risk of rotating a key while a dispute is in flight, not a defect: a seller who suspects their
//! delivery key is compromised and rotates it should re-sign and re-post receipts for any
//! disputes still open under the OLD key before the response window closes, exactly the way
//! rotating any signing key mid-flight requires re-issuing anything signed under the old one. The
//! alternative (freezing the key used for a dispute at filing time) would mean a compromised key
//! remains fully trusted for every dispute already filed against it even after the seller
//! rotates away from it specifically because they no longer trust it — the worse failure mode of
//! the two, since it defeats the entire point of being able to rotate on compromise.
//!
//! ## Gap 2 — what exactly gets slashed, and who receives it
//!
//! The design doc establishes THAT a slash executes on `finalize` (Section 3) but never states
//! the amount or destination. The bond is a pooled, per-listing stake (Section 2), not earmarked
//! per-settlement, so two shapes were available for the amount:
//!
//!   * **The whole remaining bond.** Simple, but disproportionate: a single disputed
//!     five-dollar settlement would confiscate a bond sized to protect the listing's entire
//!     transaction history, over one claim. It also means a listing with several genuinely
//!     independent disputes filed close together (Section 5's own griefing-volume scenario) would
//!     have its FIRST resolved slash wipe out the bond entirely, leaving nothing for any
//!     legitimately-harmed payer whose dispute resolves second — a first-to-finalize race with no
//!     principled reason to reward whichever dispute happens to finalize first.
//!   * **The disputed settlement's own recorded `amount` (from `SettlementRecord`), capped at
//!     whatever `bond_amount` is currently available — `min(settlement.amount,
//!     listing.bond_amount)` (CHOSEN).** Ties the penalty to the actual harm claimed rather than
//!     an unrelated confiscation of the whole bond over one dispute — exactly the design doc's
//!     own logic in Section 3 for why bonds are posted "in the same asset the listing charges
//!     in": "a slash pays the claimant back in exactly the denomination they lost," which only
//!     makes sense read together with "in exactly the amount they lost." The cap answers "what
//!     happens if the bond balance is insufficient" directly: slash whatever is available (a
//!     partial slash), rather than refusing to slash at all when something is recoverable — an
//!     all-or-nothing rule would let a seller who has already partially drained their own bond
//!     (through an earlier resolved dispute) escape ANY penalty on a later, entirely legitimate
//!     claim purely because the remaining balance doesn't cover the full settlement amount, which
//!     rewards being already-depleted rather than penalizing it further.
//!
//! For destination: the settlement's recorded `payer` (`SettlementRecord.payer`) is the only
//! sensible choice. They are the only party Section 3 grants dispute-filing standing to in the
//! first place ("only the verified payer of a settlement may file a dispute"), and they are the
//! party who bore the loss the slash amount is sized against (Gap 2's chosen amount). No other
//! address has any claim on the funds: the admin/facilitator never took custody of the payment
//! and has no stake in it; the seller is the party being penalized, so paying the seller would be
//! nonsensical; and sending funds to some new protocol-level treasury address would need its own
//! justification this design doc never provides and would dilute the entire deterrent (the
//! harmed party, specifically, is made whole — that IS the deterrent, not a generic penalty).
//!
//! Implemented as: `slash_amount = min(settlement.amount, listing.bond_amount)`, transferred to
//! `settlement.payer`, with `listing.bond_amount` reduced by exactly `slash_amount` (never
//! negative — see `finalize`'s doc-comment for the exact arithmetic and the atomicity argument).
//!
//! ## Why an authorized-caller pattern is needed here, unlike `upto-stellar`
//!
//! `contracts/upto-stellar` is deliberately admin-free: every state-changing call requires a
//! client's own on-chain signature (`require_auth_for_args`), so there is no third party a
//! caller must trust. `register_settlement` cannot work that way. Its whole purpose is to give a
//! payer standing to dispute a payment (Section 3), which means it must be trustworthy about
//! *who paid whom, for what, against which listing* — and that fact is asserted by the
//! facilitator's off-chain settlement flow, not signed by the payer as part of a single
//! contract call the way `upto`'s ceiling is. If registration were permissionless, anyone could
//! call `register_settlement` with a fabricated `(payer, seller, resource_key, amount)` tuple
//! naming a real seller and a real payer who never transacted, manufacturing dispute standing
//! against a listing that never actually took that payment. That is a direct path to fabricated
//! slashes, so something has to gate the call. See `initialize` below for the chosen shape.
//!
//! ## Resource-key encoding
//!
//! The TS facilitator's canonical resource key (`origin + normalizePath(pathname)`,
//! `src/catalog.ts`) is an arbitrary-length string. Soroban storage keys must be bounded-size, so
//! this contract never stores the raw string. Every entry point that takes a resource key accepts
//! it as `Bytes` (the UTF-8 encoding of the canonical string, produced by the caller) and the
//! contract hashes it on-ledger with `env.crypto().sha256(..)` into a `BytesN<32>` before using it
//! as a storage key. Hashing happens inside the contract, not off-chain by the facilitator, on
//! purpose: it makes the hash algorithm a single fact the contract itself enforces, so there is no
//! way for the facilitator and the contract to independently disagree about how a given resource
//! key maps to a storage slot. The only cost is a few bytes of extra calldata per call (the raw
//! key instead of a pre-hashed digest), which is negligible next to a token transfer.
//!
//! ## Data model
//!
//! Three per-key records:
//!
//!   * `Listing` (keyed by `hash(resource_key)`) — the bonded-listing state: seller, bonding
//!     asset, current bond amount, `last_claim_window_end`, and (new this pass)
//!     `open_dispute_count`.
//!   * `SettlementRecord` (keyed by `payment_id`) — the facts the facilitator registered about one
//!     settlement, so `file_dispute` can check standing without re-deriving it.
//!   * `Dispute` (new this pass, keyed by `payment_id`) — the fact that a dispute is currently
//!     open against a given settlement: who filed it and when.
//!
//! Plus one per-payer auxiliary record used only for rate-limiting: a list of recent
//! dispute-filing ledger timestamps (see `file_dispute`'s doc-comment).
//!
//! These are deliberately separate keyspaces. A listing can exist (a seller posted a bond) with
//! zero settlements registered against it yet, and a settlement can be registered against a
//! resource key that has no bond at all — see `deposit`'s doc-comment for why this contract does
//! not require one to precede the other.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, vec, Address, Bytes, BytesN, Env,
    Vec,
};

// ── Placeholder constants: named, accepted unknowns, not "TBD" ──────────────────────────────────
//
// The four constants below are not design decisions. They exist so the code paths that depend on
// them — the dust floor, both time windows, the rate limit — are real and testable now, rather
// than left as unimplementable gaps. Every one of them needs real operating data to set correctly,
// and none of that data exists yet, because nothing has processed a real dispute or a real slash.
// This is the same posture the design document (`docs/proposal-provider-bond.md`, Section 5,
// "minimal bond, ignore disputes") takes toward the seller-chosen bond-sizing gap: name the
// unknown, explain why it wasn't set, say what evidence would let someone set it — rather than
// either inventing a number that looks considered when it isn't, or hiding the gap behind "TBD."
//
// What each one specifically needs before it can be treated as a real decision:
//
//   * `PLACEHOLDER_DUST_FLOOR` — needs real observed listing prices and claim sizes once the
//     system carries live traffic. Set too low, it's meaningless (any deposit clears it). Set too
//     high before knowing what a typical low-value listing actually looks like, it excludes
//     legitimate small sellers from bonding at all. There is no way to calibrate this from first
//     principles; it needs a distribution of real numbers to look at.
//   * `PLACEHOLDER_DISPUTE_WINDOW_SECONDS` (the claim-filing window) — needs real data on how long
//     an honest buyer or agent actually takes to notice a missing or invalid receipt and decide to
//     file, weighed against how long it's reasonable to lock an honest seller's capital for a
//     settlement nobody disputes. Both sides of that tradeoff are currently guesses.
//   * `PLACEHOLDER_RESPONSE_WINDOW_SECONDS` (the seller's defense window) — needs real data on
//     receipt-posting latency under both ordinary conditions and the griefing-volume conditions
//     Section 5 describes, since this window has to survive a seller's real operational hiccups
//     under load without being long enough to become a deliberate stalling tool for a seller
//     avoiding a legitimate slash. Nobody has run this system under either condition yet.
//   * `PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX` / `_WINDOW_SECONDS` — needs real dispute-filing volume
//     from actual usage to calibrate a ceiling that doesn't block a payer with several genuine
//     grievances in a short window, while still bounding the griefing-shaped burst Section 5
//     describes ("a hundred trivial payments become a hundred filed disputes"). The current 5/hour
//     is a guess at that balance, not a measurement of it.
//
// Shipping with these values is not the same as approving them. Each one needs its own review,
// grounded in real data, before this contract is trusted with mainnet funds — the same bar the
// design document holds the bond-sizing gap to.

/// Placeholder dispute-response window, in seconds, measured from `Dispute.filed_at`.
///
/// Distinct from `PLACEHOLDER_DISPUTE_WINDOW_SECONDS` above, which is the CLAIM-FILING window (how
/// long after a settlement a payer may still file a dispute at all). This is the RESPONSE window:
/// once a dispute IS filed, how long the seller has to post a defeating receipt via `post_receipt`
/// before `finalize` may execute a slash. Section 3 locks that this window is "a fixed
/// protocol-wide constant, not seller-configurable" — same rationale as the claim-filing window
/// (Section 5: a seller who could self-configure it would have a standing incentive to set it as
/// long as the protocol permits, purely to delay a legitimate slash) — but, like every other
/// numeric placeholder in this file, does not lock a specific number.
///
/// **Currently set to 5 minutes for testnet proof-of-life demonstration, not 24 hours.** Neither
/// value is validated by real data — both are guesses, and this file's own header says shipping
/// with a placeholder is not the same as approving it. 24 hours was the original guess, reasoned
/// from "long enough for a seller's receipt-posting process under real operational load to
/// respond, short enough not to let a slash-avoidance seller stall indefinitely." Five minutes
/// abandons the first half of that reasoning entirely — it is almost certainly too tight for a
/// real seller's real infrastructure to notice a dispute and respond, and would unfairly slash
/// honest sellers who hit any real-world latency at all. It is set here ONLY to let a full
/// register_settlement → deposit → file_dispute → wait → finalize sequence be demonstrated
/// end-to-end against real ledger time in minutes instead of a day, for a testnet-only proof of
/// mechanism. **This value must not ship toward mainnet as-is** — it needs to move back toward
/// something like the original 24-hour reasoning, informed by real receipt-posting latency data,
/// before this contract is trusted with real funds. Revisit this constant specifically, not just
/// generically, before any pubnet deployment.
const PLACEHOLDER_RESPONSE_WINDOW_SECONDS: u64 = 5 * 60;

/// Placeholder dust-floor minimum bond, in the bonding token's atomic units (e.g. stroops of a
/// SEP-41 token with 7 decimals, or the token's own smallest unit).
///
/// The design doc (Section 2, "bond sizing is seller-chosen") is explicit that a dust-preventing
/// floor exists in concept but that no specific numeric floor is locked for v1 — picking one
/// before any operating data exists would be exactly the premature-commitment mistake Section 2
/// rejects for the size-to-price multiplier. `1` is used here only so the floor is enforced as a
/// real code path (rejecting a literal zero-or-negative deposit) without asserting a considered
/// number. **This value must be revisited with real operating data before mainnet** — it is not a
/// design decision, it is a placeholder that makes the check exist.
const PLACEHOLDER_DUST_FLOOR: i128 = 1;

/// Placeholder dispute response/claim window, in seconds.
///
/// Section 3 locks that the response window is "a fixed protocol-wide constant, not
/// seller-configurable," but — like the dust floor — does not lock a specific number in this
/// document. `lastClaimWindowEnd = lastSettlementAt + disputeWindowSeconds` (Section 2) needs a
/// concrete `disputeWindowSeconds` to compute against, so this pass defines one as a named,
/// clearly-flagged placeholder rather than leaving the field uncomputable. 24 hours is a
/// deliberately conservative placeholder — long enough for a human or agent buyer to notice a
/// missing receipt and file, short enough not to lock capital indefinitely — and, like the dust
/// floor, **must be revisited with real operating data**, not treated as locked.
const PLACEHOLDER_DISPUTE_WINDOW_SECONDS: u64 = 24 * 60 * 60;

/// Placeholder per-payer dispute-filing rate limit: at most `PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX`
/// filings within any trailing `PLACEHOLDER_DISPUTE_RATE_LIMIT_WINDOW_SECONDS` window.
///
/// Section 5 ("False slash claims") locks that per-payer dispute filing MUST be rate-limited, and
/// locks that the bond contract itself is the enforcement point (a call can bypass the
/// facilitator's HTTP layer entirely). It does not lock specific numbers — same situation as the
/// dust floor and dispute window above, so the same convention applies: a named, clearly-flagged
/// placeholder rather than an unenforceable requirement. `5` filings per `1 hour` is a
/// deliberately conservative starting guess — generous enough that a payer with several genuine
/// grievances in a short window isn't blocked outright, tight enough that "a hundred trivial
/// payments become a hundred filed disputes" (Section 5's own example of the attack this defends
/// against) cannot land in one burst. **These values must be revisited with real operating data
/// before mainnet** — they are not a design decision, they are placeholders that make the limiter
/// exist as a real, testable code path.
const PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX: u32 = 5;
const PLACEHOLDER_DISPUTE_RATE_LIMIT_WINDOW_SECONDS: u64 = 60 * 60;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The contract's admin was already set; `initialize` is single-use.
    AlreadyInitialized = 1,
    /// The contract's admin has not been set yet; no state-changing call is possible until
    /// `initialize` runs.
    ///
    /// Note on `register_settlement`'s authorization failure mode: an unauthorized caller is
    /// rejected by the Soroban host itself (`Address::require_auth()` traps rather than
    /// returning), the same mechanism `upto-stellar`'s `settle` relies on for its own signature
    /// checks — so there is deliberately no `NotAuthorized` variant here. A `Result`-returned
    /// error is reserved for conditions this contract's own logic decides; "the host refused to
    /// authenticate this caller" is not something the contract's code path ever reaches to
    /// return a value for.
    NotInitialized = 2,
    /// A `payment_id` was already registered. Registration is single-use per payment, matching
    /// the settlement it describes being itself a one-time event.
    SettlementAlreadyRegistered = 3,
    /// A negative or zero amount was supplied where a positive amount is required.
    InvalidAmount = 4,
    /// The deposited amount is below `PLACEHOLDER_DUST_FLOOR`.
    BelowDustFloor = 5,
    /// `deposit` was called with a different token than the listing already bonded in.
    TokenMismatch = 6,
    /// `deposit` was called with a different seller than the listing's recorded seller.
    SellerMismatch = 7,
    /// `withdraw`/`file_dispute` referenced a resource key or payment_id with no matching
    /// `Listing` record.
    ListingNotFound = 8,
    /// `withdraw` was called before `now >= last_claim_window_end` — the claim window is still
    /// open.
    ClaimWindowStillOpen = 9,
    /// `withdraw` was called while at least one dispute is currently open against the listing.
    DisputeOpen = 10,
    /// `withdraw` was called on a listing with a zero bond — nothing to withdraw.
    NothingToWithdraw = 11,
    /// `file_dispute` referenced a `payment_id` that was never registered via
    /// `register_settlement`.
    SettlementNotFound = 12,
    /// `file_dispute`'s caller does not match the settlement's recorded payer.
    NotThePayer = 13,
    /// `file_dispute` was called against a `payment_id` that already has an open dispute.
    DisputeAlreadyOpen = 14,
    /// `file_dispute` was called more than `PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX` times within the
    /// trailing `PLACEHOLDER_DISPUTE_RATE_LIMIT_WINDOW_SECONDS` window for this payer.
    DisputeRateLimited = 15,
    /// `post_receipt`/`finalize` referenced a `payment_id` with no OPEN dispute — either it was
    /// never disputed at all, or it was disputed and has already resolved (receipt posted, or
    /// already slashed). See `post_receipt`'s and `finalize`'s doc-comments for how a caller can
    /// distinguish "never disputed" from "already resolved" if that distinction matters to them
    /// (`get_settlement` tells them whether the payment_id is even real).
    DisputeNotFound = 16,
    /// `post_receipt` was called after the dispute's response window (measured from
    /// `Dispute.filed_at`) has already elapsed — too late for a receipt to defeat the dispute;
    /// only `finalize` may act on it now.
    ResponseWindowElapsed = 17,
    /// `finalize` was called before the dispute's response window (measured from
    /// `Dispute.filed_at`) has elapsed — the seller has not yet been given their full response
    /// window.
    ResponseWindowStillOpen = 18,
    /// `set_delivery_key` was called by an address that does not match the listing's recorded
    /// seller.
    NotTheSeller = 19,
    /// `post_receipt` was called against a listing with no delivery key registered
    /// (`Listing.delivery_pubkey == None`) — there is no key to verify a signature against, so
    /// every receipt fails closed rather than being treated as vacuously valid or invalid.
    NoDeliveryKeyRegistered = 20,
    /// `file_dispute` was called after `SettlementRecord.claim_deadline` has passed — the
    /// claim-filing window for this specific settlement has closed. Inclusive at the boundary:
    /// filing exactly AT the deadline still succeeds, only strictly after it fails (see
    /// `file_dispute`'s doc-comment).
    ClaimWindowElapsed = 21,
}

/// Per-listing bonded state, keyed by `hash(resource_key)`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Listing {
    /// The address that posted the bond and receives settlement proceeds for this listing.
    pub seller: Address,
    /// The SEP-41 token/asset contract this listing bonds in. Locked to the listing's first
    /// deposit (Section 2: "bonds are posted in the same asset the listing charges in") — every
    /// subsequent top-up must match, checked in `deposit`.
    pub token: Address,
    /// The current bonded amount, in the token's atomic units. Increases on `deposit`; decreases
    /// on `withdraw` (this pass); will also decrease on slash in a later pass.
    pub bond_amount: i128,
    /// `lastSettlementAt + disputeWindowSeconds` as of the most recent registered settlement,
    /// per Section 2's "unlock timing tracks only the latest settlement's window" decision: one
    /// timestamp per listing is exactly as protective as a per-settlement ledger given
    /// fixed-length windows, for a fraction of the state. A ledger timestamp (seconds since
    /// epoch, `env.ledger().timestamp()`), not a ledger sequence number, so it lines up with
    /// `disputeWindowSeconds` directly. `0` until the first settlement is registered, meaning
    /// "no open claim window."
    pub last_claim_window_end: u64,
    /// Count of currently OPEN disputes against this listing. `withdraw`'s gate checks this is
    /// zero (Section 2: "no dispute is currently open"); Section 4 also wants this exact number
    /// exposed in the catalog's `trust` block ("a count of currently open disputes"), so tracking
    /// it as a running count on the `Listing` record itself — rather than, say, requiring a
    /// caller to enumerate `Dispute` records — serves both needs with one field. Incremented by
    /// `file_dispute`; decremented by `post_receipt` (receipt defeats the dispute) and by
    /// `finalize` (slash resolves the dispute) — see those functions' doc-comments.
    pub open_dispute_count: u32,
    /// The seller's current delivery-signing Ed25519 public key, or `None` if the seller has
    /// never called `set_delivery_key` (see the module-level "Gap 1" doc-comment for why this is
    /// a standalone, independently-rotatable entry point rather than a `deposit`-time-only
    /// field). `post_receipt` verifies every receipt against whatever this field holds AT THE
    /// MOMENT `post_receipt` is called — see the module-level doc-comment's note on what
    /// "current" means across a rotation.
    pub delivery_pubkey: Option<BytesN<32>>,
}

/// What the facilitator asserts happened for one settlement, recorded so `file_dispute` can check
/// standing (Section 3: "only the verified payer of a settlement may file a dispute") without
/// needing to re-derive these facts from raw transaction history, which a Soroban contract cannot
/// do after the fact.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementRecord {
    pub payer: Address,
    pub seller: Address,
    /// `hash(resource_key)` — same key space as `Listing`, so `file_dispute` can look up the
    /// associated bond directly from a settlement record.
    pub resource_key_hash: BytesN<32>,
    pub amount: i128,
    /// The ledger timestamp after which `file_dispute` may no longer be called against this
    /// settlement — `register_settlement`'s own call-time `env.ledger().timestamp() +
    /// PLACEHOLDER_DISPUTE_WINDOW_SECONDS`, snapshotted onto the record at registration rather
    /// than read live from `Listing.last_claim_window_end` at filing time.
    ///
    /// This field closes a real gap found in review: `PLACEHOLDER_DISPUTE_WINDOW_SECONDS` was
    /// documented, twice, as "the CLAIM-FILING window (how long after a settlement a payer may
    /// still file a dispute at all)" — but until this field existed, the constant was only ever
    /// used to advance `Listing.last_claim_window_end`, which gates `withdraw`, not
    /// `file_dispute`. Nothing bounded how long after a settlement a dispute could first be
    /// filed against it. A payer could file against a real, ancient, never-disputed settlement
    /// at a time of their choosing, freezing or slashing a seller's CURRENT bond balance — funds
    /// deposited long after the original settlement and unrelated to it. Snapshotting the
    /// deadline per-settlement, rather than continuing to read the listing's shared, constantly-
    /// refreshed `last_claim_window_end`, is deliberate: `last_claim_window_end` is advanced by
    /// EVERY settlement registered against a listing (see `register_settlement` below), so
    /// reading it live at filing time would let a completely unrelated LATER settlement's
    /// registration silently extend an EARLIER settlement's dispute deadline — the same
    /// "unrelated activity reopens standing" shape as the bug this field fixes, just one level
    /// removed. A per-settlement snapshot has no such cross-settlement leakage.
    pub claim_deadline: u64,
}

/// An open dispute against one settlement, keyed by `payment_id` — the same keyspace
/// `SettlementRecord` uses, since a dispute is always filed against exactly one settlement and a
/// `payment_id` can have at most one dispute record alive at a time (see `file_dispute`'s
/// doc-comment on double-filing).
///
/// This is intentionally minimal: enough to know a dispute exists, who opened it, and when, so
/// `withdraw`'s gate and this pass's `post_receipt`/`finalize` resolution both have what they
/// need. It carries no separate resolution/status field, by design: both `post_receipt` and
/// `finalize` resolve a dispute by DELETING its `Dispute` record (see the module-level
/// doc-comment's opening note), so "does a `Dispute` record exist at this `payment_id`" continues
/// to mean exactly "is a dispute currently open" for the whole lifetime of this contract, with no
/// separate boolean/enum to ever fall out of sync with that fact.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    /// The payer who filed this dispute. Always equal to the disputed settlement's recorded
    /// `payer` — `file_dispute` enforces this at filing time — but stored redundantly here so a
    /// reader of a `Dispute` record does not need to also fetch the `SettlementRecord` to know
    /// who filed it.
    pub filed_by: Address,
    /// Ledger timestamp (`env.ledger().timestamp()`) at which this dispute was filed.
    pub filed_at: u64,
    /// `hash(resource_key)` of the listing this dispute is against, copied from the settlement
    /// record at filing time so `withdraw`'s gate and any future resolution pass can find the
    /// associated `Listing` directly from a `Dispute` without a second lookup through
    /// `SettlementRecord`.
    pub resource_key_hash: BytesN<32>,
}

#[contracttype]
enum DataKey {
    /// The facilitator's authorized identity. Set once via `initialize`.
    Admin,
    /// A bonded listing, keyed by `hash(resource_key)`.
    Listing(BytesN<32>),
    /// A registered settlement, keyed by `payment_id`.
    Settlement(BytesN<32>),
    /// An open dispute, keyed by `payment_id`. Presence of this key IS the "is a dispute open
    /// against this payment_id" fact for this pass — see `file_dispute`'s doc-comment for why
    /// there is no separate boolean/status field instead.
    Dispute(BytesN<32>),
    /// A payer's recent dispute-filing timestamps, used only for the rate limiter in
    /// `file_dispute`. Keyed by the payer's address, not by resource key or payment_id, because
    /// the rate limit is per-payer across ALL listings, matching Section 5's framing ("a griefer
    /// who has ... genuine settlement history against a target seller has standing to dispute
    /// every one of those real payments" — the limiter has to bound the payer's total filing
    /// rate, not a per-listing rate, or a griefer could simply spread filings across many
    /// listings to route around a per-listing limit).
    DisputeLog(Address),
}

#[contract]
pub struct BondEscrowContract;

#[contractimpl]
impl BondEscrowContract {
    /// Set the contract's admin (the facilitator's authorized on-chain identity). Callable
    /// exactly once — a second call fails with `AlreadyInitialized` rather than silently
    /// re-assigning who may register settlements, which would otherwise let whoever calls
    /// `initialize` last quietly take over authorization for every future call.
    ///
    /// ## Why a stored-admin pattern rather than something else
    ///
    /// A few shapes were available for gating `register_settlement`; this one was chosen because
    /// it is the standard idiomatic Soroban answer to "one privileged identity, changeable only
    /// through an explicit, auditable action" and needs no new primitive:
    ///
    ///   * **Stored `Address` admin, `require_auth` on every gated call (chosen).** One
    ///     ledger-storage read plus one signature check per `register_settlement` call. The admin
    ///     identity is visible on-chain (`get_admin`, below) so anyone can audit who is trusted
    ///     without needing off-chain knowledge. Rotation is a deliberate future addition (an
    ///     `set_admin` call gated by the current admin), not built in this pass since nothing in
    ///     this pass's scope needs it yet — adding it speculatively would be exactly the
    ///     unnecessary-complexity-for-this-pass this task explicitly warns against.
    ///   * **A hard-coded admin address baked into the wasm at build time.** Rejected: rotating
    ///     the facilitator's identity (key compromise, infra migration) would require redeploying
    ///     the contract rather than a single authorized call, and every bonded listing's state
    ///     would need migrating to a new contract instance — the exact problem Section 2's
    ///     single-shared-contract decision was trying to avoid for a different reason.
    ///   * **Multisig/threshold admin (e.g. an N-of-M Soroban account as the admin address).**
    ///     Not precluded by this design — the admin field is a plain `Address`, and a Soroban
    ///     "account contract" address satisfies `require_auth` identically to a keypair address.
    ///     Deliberately not decided *for* here: which threshold, who the signers are, is an
    ///     operational decision for whoever deploys this contract, not a code-level one.
    ///
    /// ## Which key: a dedicated admin key, not the facilitator's payment sponsor key — decided,
    /// ## not left open
    ///
    /// The address passed here should be a key generated and held specifically for this
    /// contract, distinct from `SPONSOR_SECRET_KEY` (the key that pays settlement fees and
    /// signs sponsored transactions elsewhere in this system). This is the exact same reasoning
    /// Gap 1 above already applies to the seller's delivery-signing key being split from
    /// `payTo`: a key is worth isolating when compromising it grants a materially different
    /// class of damage than compromising the key it would otherwise be bundled with.
    ///
    /// What this admin key actually protects: `register_settlement` trusts whatever
    /// `(payer, seller, resource_key, amount)` tuple the admin submits, with no independent
    /// on-chain check that a real payment ever happened (see "Why an authorized-caller pattern
    /// is needed here" above). Compromise it, and an attacker can register a fabricated
    /// settlement naming themselves as `payer` against any real seller's real bond, then file a
    /// dispute and force a slash without any real payment ever occurring — a direct path to
    /// stealing bonded funds. That is a different blast radius than `SPONSOR_SECRET_KEY`'s: the
    /// sponsor key's compromise lets an attacker drain sponsor XLM or forge fee-sponsored
    /// transactions; this key's compromise lets an attacker forge dispute standing and drain
    /// *bonded* funds. Welding them into one key means a single compromise event grants both,
    /// and makes them impossible to rotate independently — if the sponsor key is ever rotated
    /// for reasons unrelated to bond-escrow (routine rotation, unrelated incident), this admin
    /// role would be forced to rotate in lockstep for no reason, or vice versa: a
    /// bond-escrow-specific incident would force rotating a key that also holds unrelated
    /// payment-sponsorship authority.
    ///
    /// A dedicated key costs one more secret to generate, fund, and store — funded with only
    /// enough XLM to pay its own transaction fees, never holding or sponsoring anything else —
    /// in exchange for keeping these two failure domains genuinely separate. Given this contract
    /// exists specifically to hold and slash real user funds, that tradeoff is worth it; treat
    /// reusing `SPONSOR_SECRET_KEY` here as a shortcut that trades a small operational
    /// convenience for a real, avoidable increase in what one compromised secret can do.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// The contract's current admin, or `None` if `initialize` has not run yet. Exposed so
    /// anyone — an auditor, the operator runbook, a monitoring job — can check who is currently
    /// authorized to register settlements without needing off-chain knowledge.
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Register a settlement's facts, giving its payer future standing to dispute it.
    ///
    /// Callable only by the stored admin (the facilitator's authorized identity) — see the
    /// module-level doc-comment for why this call cannot be permissionless the way `upto`'s
    /// `settle` is. `admin.require_auth()` means the facilitator's own on-chain identity must
    /// sign this call; a forged registration would require forging that signature.
    ///
    /// * `payment_id` — unique identifier for the settlement (the same id the facilitator already
    ///   tracks for the underlying payment). Used as the storage key, so registration is
    ///   naturally idempotent-checkable: a second call with the same id is rejected rather than
    ///   silently overwriting the first (see "double-registration" below).
    /// * `payer` — the verified payer of this settlement; the only party Section 3 grants
    ///   dispute-filing standing to.
    /// * `seller` — the listing's seller for this settlement.
    /// * `resource_key` — the canonical resource key (UTF-8 bytes), hashed here into the same
    ///   `BytesN<32>` keyspace `Listing` uses.
    /// * `amount` — the settled amount, in the listing's bonding token's atomic units. Must be
    ///   positive; a zero-amount settlement (the `upto` scheme explicitly allows settling 0 for
    ///   no usage, see `upto-stellar`) has no loss for a payer to ever dispute, so it is rejected
    ///   here rather than accepted as a no-op — there is nothing meaningful to register standing
    ///   against.
    ///
    /// ## Double-registration
    ///
    /// A `payment_id` may be registered exactly once. Rejecting a second call with
    /// `SettlementAlreadyRegistered` (rather than silently overwriting, or silently no-op'ing)
    /// was chosen because a settlement is a real, one-time event — allowing a second registration
    /// to overwrite `(payer, seller, resource_key, amount)` for the same id would let a
    /// compromised or buggy facilitator caller quietly rewrite dispute standing for a payment
    /// already recorded, which is exactly the kind of forgeable-registration risk gating this
    /// call in the first place is meant to close. Returning an explicit error (rather than a
    /// silent no-op) also gives the facilitator's synchronous registration path (Section 6,
    /// `src/bazaar.ts`) an unambiguous signal to alert on, since a second registration attempt
    /// for a real `payment_id` should never happen in normal operation and is worth surfacing.
    ///
    /// ## Whether a listing must already exist
    ///
    /// Registration does NOT require `resource_key` to already have a bonded `Listing`. A
    /// listing only needs `ownershipState: verified` to accept settlements at all under plain
    /// x402 (Section 1); bonding is opt-in and layered on top (Section 7: "most sellers ... will
    /// never have posted a bond"). A verified-but-unbonded listing can transact and have
    /// settlements registered against it — `file_dispute` finds a `SettlementRecord` but no
    /// `Listing` in that case, and rejects with `ListingNotFound` (there is simply nothing to
    /// hold a dispute against).
    pub fn register_settlement(
        env: Env,
        payment_id: BytesN<32>,
        payer: Address,
        seller: Address,
        resource_key: Bytes,
        amount: i128,
    ) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        // `require_auth` traps on failure rather than returning, so reaching the line below
        // means the caller's on-chain signature for the stored admin address was verified by the
        // host. There is no explicit `NotAuthorized` error to return — see that variant's
        // doc-comment for why.

        // Deliberate divergence from `upto-stellar`'s `settle`, which allows and tests a zero
        // settlement as a legitimate no-op (see its `zero_settlement_moves_nothing_but_consumes_the_authorization`
        // test): that scheme's zero case still needs to consume the nonce and release the
        // reserved ceiling back to a payer's budget, so it has real work to do even at amount
        // zero. Registering settlement *standing* for a bond dispute has no equivalent — a
        // zero-amount settlement caused no loss, so there is nothing a payer could ever have
        // standing to dispute against it. Rejecting it here isn't stricter for its own sake; it
        // reflects that this entry point's zero case has no meaningful state to record, unlike
        // `upto`'s.
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let settlement_key = DataKey::Settlement(payment_id.clone());
        if env.storage().persistent().has(&settlement_key) {
            return Err(Error::SettlementAlreadyRegistered);
        }

        let resource_key_hash = Self::hash_resource_key(&env, &resource_key);
        let claim_deadline = env
            .ledger()
            .timestamp()
            .saturating_add(PLACEHOLDER_DISPUTE_WINDOW_SECONDS);
        let record = SettlementRecord {
            payer,
            seller,
            resource_key_hash: resource_key_hash.clone(),
            amount,
            claim_deadline,
        };
        env.storage().persistent().set(&settlement_key, &record);

        // Refresh the listing's claim window to cover this settlement, per Section 2's
        // single-timestamp unlock model, but ONLY if a listing already exists — registration must
        // not silently fabricate a zero-bond `Listing` record as a side effect (see `deposit`'s
        // doc-comment for why listing creation is deliberately scoped to `deposit` alone).
        let listing_key = DataKey::Listing(resource_key_hash);
        if let Some(mut listing) = env
            .storage()
            .persistent()
            .get::<DataKey, Listing>(&listing_key)
        {
            listing.last_claim_window_end = env
                .ledger()
                .timestamp()
                .saturating_add(PLACEHOLDER_DISPUTE_WINDOW_SECONDS);
            env.storage().persistent().set(&listing_key, &listing);
        }

        Ok(())
    }

    /// Look up a previously registered settlement, or `None` if `payment_id` was never
    /// registered. Lets `file_dispute` (and this pass's tests) check standing.
    pub fn get_settlement(env: Env, payment_id: BytesN<32>) -> Option<SettlementRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Settlement(payment_id))
    }

    /// Deposit `amount` of `token` into the contract, establishing a new listing's bond or
    /// topping up an existing one.
    ///
    /// * `seller` — must authorize this call (`seller.require_auth()`); only the seller who will
    ///   own the resulting bond may move their own funds into it.
    /// * `resource_key` — the canonical resource key (UTF-8 bytes) this bond protects, hashed the
    ///   same way as in `register_settlement`.
    /// * `token` — the SEP-41 token/asset contract to transfer from. Locked to the listing on
    ///   first deposit; a later top-up in a different token is rejected (`TokenMismatch`) rather
    ///   than accepted and silently tracked as two token balances under one `bond_amount` field,
    ///   which would make `bond_amount` meaningless as a single number.
    /// * `amount` — must be positive and at least `PLACEHOLDER_DUST_FLOOR`.
    ///
    /// ## Token transfer pattern
    ///
    /// Uses `token::TokenClient::transfer(seller, contract_address, amount)`, the same SEP-41
    /// client `upto-stellar` invokes the token contract through (see its `settle`). Unlike
    /// `upto`'s `transfer_from`-as-spender pattern (which exists there specifically because the
    /// *contract*, not the payer, decides the actual amount at settlement time), a deposit's
    /// amount is chosen and authorized directly by the depositing seller, so a plain `transfer`
    /// with the seller as `from` is the right primitive — there is no ceiling/actual split to
    /// reconcile here the way there is in `upto`.
    ///
    /// ## Whether deposit may initialize a new listing
    ///
    /// Yes — deposit is the ONLY way a `Listing` record comes into existence. `register_settlement`
    /// deliberately does not create one (see its doc-comment). This mirrors the real-world
    /// sequencing Section 2 describes: "posting a bond happens once a listing reaches
    /// `ownershipState: verified` — the seller sends a token transfer into the bond contract" —
    /// the seller's own deposit is the event that brings a bonded listing into being, not a fact
    /// the facilitator asserts on the seller's behalf. A seller could in principle call `deposit`
    /// before any settlement is ever registered against that resource key (they bond before their
    /// first sale), which is exactly the "fresh listing" path this pass's tests cover.
    ///
    /// On top-up: if a `Listing` already exists for this `resource_key_hash`, its `seller` and
    /// `token` must match exactly (`SellerMismatch` / `TokenMismatch` otherwise) and
    /// `bond_amount` is increased by `amount`. `last_claim_window_end` and `open_dispute_count`
    /// are left untouched by a deposit — the window is advanced only by `register_settlement`,
    /// and the dispute count only by `file_dispute`/future resolution, since a deposit is not
    /// itself a settlement or dispute event and must not disturb either.
    pub fn deposit(
        env: Env,
        seller: Address,
        resource_key: Bytes,
        token: Address,
        amount: i128,
    ) -> Result<i128, Error> {
        seller.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if amount < PLACEHOLDER_DUST_FLOOR {
            return Err(Error::BelowDustFloor);
        }

        let resource_key_hash = Self::hash_resource_key(&env, &resource_key);
        let listing_key = DataKey::Listing(resource_key_hash);

        let mut listing = match env
            .storage()
            .persistent()
            .get::<DataKey, Listing>(&listing_key)
        {
            Some(existing) => {
                if existing.seller != seller {
                    return Err(Error::SellerMismatch);
                }
                if existing.token != token {
                    return Err(Error::TokenMismatch);
                }
                existing
            }
            None => Listing {
                seller: seller.clone(),
                token: token.clone(),
                bond_amount: 0,
                last_claim_window_end: 0,
                open_dispute_count: 0,
                delivery_pubkey: None,
            },
        };

        // Move the funds before persisting the updated balance, so a failed transfer (e.g.
        // insufficient allowance/balance) leaves no partial state change behind — the token
        // client panics on failure inside `transfer`, which aborts the whole invocation
        // atomically; nothing above this line has written to persistent storage yet.
        let client = token::TokenClient::new(&env, &token);
        client.transfer(&seller, &env.current_contract_address(), &amount);

        listing.bond_amount = listing
            .bond_amount
            .checked_add(amount)
            .expect("bond_amount overflow");
        env.storage().persistent().set(&listing_key, &listing);

        Ok(listing.bond_amount)
    }

    /// Withdraw a listing's entire bond back to its seller.
    ///
    /// * `seller` — must authorize this call (`seller.require_auth()`) and must match the
    ///   listing's recorded seller, following the exact same seller-gating pattern `deposit`
    ///   uses. A non-seller caller (even one who supplies a valid `resource_key`) cannot withdraw
    ///   someone else's bond.
    /// * `resource_key` — the canonical resource key (UTF-8 bytes) identifying the listing, hashed
    ///   the same way as in `deposit`/`register_settlement`.
    ///
    /// Returns the amount withdrawn (equivalently, the listing's `bond_amount` immediately before
    /// this call, since this pass only supports full withdrawal — see below).
    ///
    /// ## The unlock gate (Section 2)
    ///
    /// Withdrawal is permitted only when BOTH of the following hold, checked atomically within
    /// this single call (Section 5, "The bond withdrawal race": Soroban contract execution is
    /// atomic within one invocation, so there is no gap between "check passed" and "funds move"
    /// for a new dispute to slip into):
    ///
    ///   1. `env.ledger().timestamp() >= listing.last_claim_window_end` — the most recent
    ///      settlement's claim window has closed. A `Listing` that has never had a settlement
    ///      registered against it has `last_claim_window_end == 0`, which is always `<= now`, so a
    ///      bond that was deposited but never used to back a settlement is withdrawable
    ///      immediately — there is no window to wait out if nothing was ever at stake.
    ///   2. `listing.open_dispute_count == 0` — no dispute is currently open. This holds
    ///      regardless of how much wall-clock time has passed since the window closed; an open
    ///      dispute keeps the gate closed until it resolves, matching Section 2's "an open dispute
    ///      keeps the withdrawal gate closed regardless of how much wall-clock time has passed."
    ///
    /// Failing (1) returns `ClaimWindowStillOpen`; failing (2) returns `DisputeOpen`, so a caller
    /// (and this pass's tests) can distinguish "too early" from "actively disputed" rather than
    /// collapsing both into one generic rejection.
    ///
    /// ## Full withdrawal only — no partial-amount parameter
    ///
    /// This entry point takes no `amount` parameter: a successful call always withdraws the
    /// listing's ENTIRE `bond_amount`, resetting it to `0`. The design doc does not pin this down
    /// explicitly, so the choice and its reasoning are recorded here the way the admin-pattern
    /// choice above is recorded.
    ///
    ///   * **Full withdrawal only (chosen).** Simplest to reason about and to test, and it
    ///     matches the trust model the rest of this design leans on: Section 4 says the catalog's
    ///     `trust` block must expose "whether the bond is currently withdrawable" as a boolean
    ///     gate a buyer checks before paying — that's inherently an all-or-nothing fact about a
    ///     listing's protection, not a partial one. A seller can always `deposit` again
    ///     immediately after a full withdrawal if they want to keep operating with a smaller (or
    ///     larger) bond; this only removes the ability to shave the bond down by a small amount
    ///     while leaving the rest quietly in place.
    ///   * **Partial withdrawal via an `amount` parameter, capped at `bond_amount`.** Gives a
    ///     seller finer control (e.g. withdraw profit while leaving a bond posted) without forcing
    ///     a full re-deposit. Rejected for this pass: it would let a seller quietly thin a bond
    ///     down toward the dust floor between settlements, one small withdrawal at a time, with no
    ///     single event that clearly signals "this bond just got meaningfully weaker" the way a
    ///     full withdrawal-to-zero does. Section 7's core warning — a buyer needs to actually
    ///     compare the posted bond against the listing's price — is undermined more by a bond that
    ///     erodes gradually and silently than by one that's either present at its stated size or
    ///     fully gone. Nothing in the design doc calls for partial withdrawal, so the extra
    ///     complexity (a new validated parameter, a new arithmetic path, a new gap between "some
    ///     funds left" and "no funds left" for `withdrawable` to represent) is not justified yet;
    ///     it can be added in a later pass if a real operational need for it shows up.
    ///   * **Do nothing — no `withdraw` at all this pass.** Not viable: it's explicitly in this
    ///     pass's required scope.
    ///
    /// A withdrawal on a listing with `bond_amount == 0` (nothing ever deposited, or the balance
    /// left at zero by a prior withdrawal) is rejected with `NothingToWithdraw` rather than
    /// silently succeeding as a zero-effect no-op — a real bond-holding contract should not accept
    /// a call whose only observable effect is authorizing nothing and moving nothing, and treating
    /// it as an explicit error gives a caller (and the facilitator's relay layer) an unambiguous
    /// signal that something about their expectation of the listing's state was wrong.
    ///
    /// ## Nonexistent listing
    ///
    /// A `resource_key` with no `Listing` record at all (never deposited into) fails with
    /// `ListingNotFound`, checked before the seller-match comparison — there is no seller to
    /// compare against yet, so failing with a listing-shaped error rather than a
    /// seller-mismatch-shaped one is the more accurate signal.
    pub fn withdraw(env: Env, seller: Address, resource_key: Bytes) -> Result<i128, Error> {
        seller.require_auth();

        let resource_key_hash = Self::hash_resource_key(&env, &resource_key);
        let listing_key = DataKey::Listing(resource_key_hash);

        let mut listing = env
            .storage()
            .persistent()
            .get::<DataKey, Listing>(&listing_key)
            .ok_or(Error::ListingNotFound)?;

        if listing.seller != seller {
            return Err(Error::SellerMismatch);
        }

        let now = env.ledger().timestamp();
        if now < listing.last_claim_window_end {
            return Err(Error::ClaimWindowStillOpen);
        }
        if listing.open_dispute_count > 0 {
            return Err(Error::DisputeOpen);
        }

        let amount = listing.bond_amount;
        if amount <= 0 {
            return Err(Error::NothingToWithdraw);
        }

        // Zero the balance before the transfer, symmetric with `deposit`'s "move funds, then
        // persist" ordering but inverted: here the outgoing transfer is what can legitimately
        // fail from the escrow's side only in a way the token contract itself would reject
        // (which panics and aborts the whole invocation atomically), so persisting first and
        // transferring second vs. the reverse are equally safe against partial state — this
        // pass writes state first so the amount moved is fixed and can't be affected by
        // anything the transfer call itself might read back.
        listing.bond_amount = 0;
        env.storage().persistent().set(&listing_key, &listing);

        let client = token::TokenClient::new(&env, &listing.token);
        client.transfer(&env.current_contract_address(), &seller, &amount);

        Ok(amount)
    }

    /// File a dispute against the listing backing a specific registered settlement.
    ///
    /// * `payer` — must authorize this call (`payer.require_auth()`) and must match the disputed
    ///   settlement's recorded `payer` exactly (Section 3: "only the verified payer of a
    ///   settlement may file a dispute"). No counter-stake is required (also Section 3, locked).
    /// * `payment_id` — identifies the settlement being disputed; must have been registered via
    ///   `register_settlement`.
    ///
    /// Returns nothing on success; the dispute's existence is queryable via `get_dispute` and
    /// reflected in `open_dispute_count` on the associated `Listing`.
    ///
    /// ## Standing checks, in order
    ///
    ///   1. `SettlementNotFound` — no `SettlementRecord` exists for `payment_id`. Filing against a
    ///      payment the facilitator never registered is rejected outright; there is no payer of
    ///      record to check standing against, and no listing to dispute against reliably (a
    ///      caller could otherwise supply an arbitrary unregistered id and, if this check were
    ///      skipped, nothing downstream would even have a resource key to look up).
    ///   2. `NotThePayer` — the settlement exists, but `payer` does not match its recorded payer.
    ///      Checked (and `payer.require_auth()` invoked) using the CALLER's claimed identity
    ///      against the STORED record, so an attacker cannot simply pass someone else's address
    ///      as `payer` and forge their signature — `require_auth` traps unless the transaction
    ///      actually carries that address's authorization.
    ///   3. `ClaimWindowElapsed` — the settlement is real, the caller is its real payer, but
    ///      `now > settlement.claim_deadline`: the claim-filing window for THIS settlement has
    ///      closed. Checked using the timestamp snapshotted onto the record at
    ///      `register_settlement` time, not the listing's shared, constantly-refreshed
    ///      `last_claim_window_end` — see `SettlementRecord.claim_deadline`'s doc-comment for why.
    ///      Inclusive at the boundary: exactly at the deadline still succeeds.
    ///   4. `ListingNotFound` — the settlement is real and within its claim window, but the
    ///      settlement's `resource_key_hash` has no `Listing` record (a verified-but-never-bonded
    ///      listing, per `register_settlement`'s doc-comment on "whether a listing must already
    ///      exist"). There is no bond to hold a dispute against, so filing is rejected rather than
    ///      creating a `Dispute` record that could never affect any `withdraw` gate.
    ///   5. `DisputeAlreadyOpen` — see below.
    ///   6. `DisputeRateLimited` — see below.
    ///
    /// ## Duplicate-filing / "already open" semantics, and this pass's known limitation
    ///
    /// A second `file_dispute` call against a `payment_id` that already has a `Dispute` record is
    /// rejected with `DisputeAlreadyOpen`. Presence of a `Dispute` record at `payment_id` is, for
    /// this pass, used directly as "is a dispute open" — there is no separate status field,
    /// because `post_receipt`/`finalize` (the calls that would ever resolve a dispute, by either
    /// defeating it with a receipt or executing a slash) do not exist in this codebase yet. That
    /// means this pass genuinely cannot distinguish "a dispute was already filed and is still
    /// open" from "a dispute was already filed and has since resolved" — the second case is
    /// simply not reachable yet, since nothing resolves a dispute. **This is a deliberate,
    /// explicitly-scoped limitation, not an oversight**: the task for this pass is to prevent a
    /// duplicate OPEN dispute against the same `payment_id`, which is exactly what this check
    /// does; deciding whether a payment_id whose prior dispute has resolved may be disputed again
    /// is correctly a question for whichever future pass introduces dispute resolution, since only
    /// that pass will have the resolved/unresolved distinction to decide it against. Whoever
    /// builds `post_receipt`/`finalize` next should either (a) delete the `Dispute` record on
    /// resolution, which would make this exact check ("does a `Dispute` record exist") continue to
    /// work unmodified for the resolved case too, or (b) add an explicit status field and update
    /// this check accordingly — that decision is intentionally left open rather than pre-committed
    /// here.
    ///
    /// ## Rate limiting (Section 5, "False slash claims")
    ///
    /// Enforced here, in the contract, not only at the facilitator's HTTP layer — Section 5 is
    /// explicit that filing can happen via direct contract call, bypassing the facilitator
    /// entirely, so the facilitator cannot be the only place this is enforced.
    ///
    /// Mechanism: a `Vec<u64>` of this payer's recent dispute-filing ledger timestamps is stored
    /// under `DataKey::DisputeLog(payer)`. On each `file_dispute` call, BEFORE recording the new
    /// filing:
    ///
    ///   1. Read the payer's log (empty `Vec` if none exists yet).
    ///   2. Prune every entry at or older than `now - PLACEHOLDER_DISPUTE_RATE_LIMIT_WINDOW_SECONDS`
    ///      — exclusive-at-start: an entry exactly `window_seconds` old is pruned, not counted, so
    ///      the effective window is exactly `window_seconds` wide, never `window_seconds + 1` (a
    ///      strictly rolling window measured against `env.ledger().timestamp()`, not a
    ///      fixed-bucket counter that resets on a calendar boundary — Soroban has no wall-clock
    ///      timer, only ledger sequence/timestamp, so the window is computed purely from ledger
    ///      time as the task requires).
    ///   3. If the pruned log's length is already `>= PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX`, reject
    ///      with `DisputeRateLimited` — checked BEFORE any other state is written this call, so a
    ///      rate-limited attempt has zero side effects, symmetric with how `register_settlement`
    ///      checks double-registration before writing.
    ///   4. Otherwise, append `now` to the pruned log and persist it, then proceed to record the
    ///      dispute.
    ///
    /// This bounds the log's own storage size to at most `PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX`
    /// entries per payer at any time (pruning happens on every call, so it never accumulates
    /// unboundedly), and bounds total filings from one payer, across every listing they've ever
    /// disputed, to the configured max per rolling window — closing the "spread filings across
    /// many listings to route around a per-listing limit" gap a per-listing-only counter would
    /// leave open.
    pub fn file_dispute(env: Env, payer: Address, payment_id: BytesN<32>) -> Result<(), Error> {
        let settlement = Self::get_settlement(env.clone(), payment_id.clone())
            .ok_or(Error::SettlementNotFound)?;

        if settlement.payer != payer {
            return Err(Error::NotThePayer);
        }
        payer.require_auth();

        let now = env.ledger().timestamp();
        // Inclusive at the boundary: filing exactly AT claim_deadline still succeeds, only
        // strictly after it fails. See SettlementRecord.claim_deadline's doc-comment for why
        // this is snapshotted per-settlement rather than read live from
        // Listing.last_claim_window_end.
        if now > settlement.claim_deadline {
            return Err(Error::ClaimWindowElapsed);
        }

        let listing_key = DataKey::Listing(settlement.resource_key_hash.clone());
        let mut listing = env
            .storage()
            .persistent()
            .get::<DataKey, Listing>(&listing_key)
            .ok_or(Error::ListingNotFound)?;

        let dispute_key = DataKey::Dispute(payment_id.clone());
        if env.storage().persistent().has(&dispute_key) {
            return Err(Error::DisputeAlreadyOpen);
        }

        Self::enforce_and_record_rate_limit(&env, &payer, now)?;

        let dispute = Dispute {
            filed_by: payer,
            filed_at: now,
            resource_key_hash: settlement.resource_key_hash,
        };
        env.storage().persistent().set(&dispute_key, &dispute);

        listing.open_dispute_count = listing
            .open_dispute_count
            .checked_add(1)
            .expect("open_dispute_count overflow");
        env.storage().persistent().set(&listing_key, &listing);

        Ok(())
    }

    /// Look up an open dispute, or `None` if `payment_id` has no dispute currently open — either
    /// never filed at all, or filed and since resolved via `post_receipt` (receipt defeated it)
    /// or `finalize` (slash resolved it). Both resolution paths delete the `Dispute` record (see
    /// the module-level doc-comment), so this single lookup cannot itself distinguish "never
    /// disputed" from "disputed and resolved" — a caller wanting that distinction can check
    /// `get_settlement` (real payment_id or not) alongside this.
    pub fn get_dispute(env: Env, payment_id: BytesN<32>) -> Option<Dispute> {
        env.storage().persistent().get(&DataKey::Dispute(payment_id))
    }

    /// Look up a listing's bonded state, or `None` if no deposit has ever been made against this
    /// resource key.
    pub fn get_listing(env: Env, resource_key: Bytes) -> Option<Listing> {
        let resource_key_hash = Self::hash_resource_key(&env, &resource_key);
        env.storage()
            .persistent()
            .get(&DataKey::Listing(resource_key_hash))
    }

    /// Register or rotate a listing's delivery-signing public key (Gap 1, see the module-level
    /// doc-comment for the full reasoning behind this being a standalone entry point).
    ///
    /// * `seller` — must authorize this call (`seller.require_auth()`) and must match the
    ///   listing's recorded seller, the same seller-gating pattern `deposit`/`withdraw` use.
    /// * `resource_key` — the canonical resource key (UTF-8 bytes) identifying the listing, hashed
    ///   the same way as every other entry point.
    /// * `pubkey` — the raw 32-byte Ed25519 public key the seller will sign delivery receipts
    ///   with from now on. Unconditionally overwrites whatever was previously stored (`None` or a
    ///   prior key) — this call IS the rotation mechanism, so there is no separate "rotate"
    ///   variant with different semantics.
    ///
    /// Callable at any time relative to `deposit`/`withdraw`/settlements — a seller may set a
    /// delivery key before ever depositing a bond, and rotating the key does not require, and has
    /// no effect on, `bond_amount`, `last_claim_window_end`, or `open_dispute_count`. Requires an
    /// existing `Listing` record, though (`ListingNotFound` otherwise): unlike `deposit`, this
    /// call deliberately does NOT create a fresh zero-bond `Listing` as a side effect, for the
    /// same reason `register_settlement` doesn't (see its doc-comment) — a delivery key with no
    /// bond behind it protects nothing, and silently fabricating a listing record here would let
    /// a caller create `Listing` rows with no funds ever having moved, muddying `get_listing`'s
    /// meaning for every other caller.
    pub fn set_delivery_key(
        env: Env,
        seller: Address,
        resource_key: Bytes,
        pubkey: BytesN<32>,
    ) -> Result<(), Error> {
        seller.require_auth();

        let resource_key_hash = Self::hash_resource_key(&env, &resource_key);
        let listing_key = DataKey::Listing(resource_key_hash);

        let mut listing = env
            .storage()
            .persistent()
            .get::<DataKey, Listing>(&listing_key)
            .ok_or(Error::ListingNotFound)?;

        if listing.seller != seller {
            return Err(Error::NotTheSeller);
        }

        listing.delivery_pubkey = Some(pubkey);
        env.storage().persistent().set(&listing_key, &listing);

        Ok(())
    }

    /// Verify a signed delivery receipt and, if valid and timely, defeat (close) the open dispute
    /// for `payment_id` — the only way a dispute closes without a slash (Section 3).
    ///
    /// * `payment_id` — identifies the disputed settlement; must have an OPEN `Dispute` record.
    /// * `response_hash` — the seller's commitment to the delivered content, opaque to this
    ///   contract (Section 3: the contract can verify a receipt exists and is well-formed, never
    ///   that its content was actually what the buyer received — see Section 3's "narrow and
    ///   worth stating precisely" paragraph).
    /// * `timestamp` — the ledger timestamp the seller signed as part of the receipt. NOT
    ///   independently validated against `env.ledger().timestamp()` beyond being part of the
    ///   signed tuple — Section 3 defines the receipt as a commitment over `(paymentId,
    ///   responseHash, timestamp)` with no separate freshness rule for `timestamp` itself; the
    ///   mechanism that actually bounds how late a receipt may be posted is the response window
    ///   below, measured from `Dispute.filed_at`, not from this field.
    /// * `signature` — raw 64-byte Ed25519 signature over the canonical encoding of
    ///   `(payment_id, response_hash, timestamp)` (see "Message encoding" below), verified against
    ///   `listing.delivery_pubkey`.
    ///
    /// On success: the `Dispute` record is deleted and `listing.open_dispute_count` is
    /// decremented. No fund movement happens here — Section 3 is explicit that a defeated dispute
    /// never reaches the slash step.
    ///
    /// ## Message encoding (signed by the seller off-chain, reconstructed here identically)
    ///
    /// The signed message is the big-endian-concatenated byte string:
    ///
    /// ```text
    /// payment_id (32 bytes) || response_hash (32 bytes) || timestamp (8 bytes, big-endian u64)
    /// ```
    ///
    /// 72 bytes total, built with `Bytes::from_array`/`extend_from_array` inside this contract
    /// from the call's own arguments (see `receipt_message` below) — not trusted as a caller-
    /// supplied blob. This is stated explicitly and precisely, per this pass's own requirement,
    /// because an implicit or ambiguous encoding is exactly the kind of detail that silently
    /// breaks interop: any SDK-side signer (the seller's delivery-signing helper) MUST reproduce
    /// this exact byte layout — fixed-width fields in this fixed order, no separators, no length
    /// prefixes, `timestamp` as a plain 8-byte big-endian integer (Rust's `u64::to_be_bytes()`
    /// matches this directly) — or every signature it produces will fail to verify here.
    ///
    /// ## Checks, in order
    ///
    ///   1. `DisputeNotFound` — no OPEN `Dispute` record exists for `payment_id`. Covers BOTH "this
    ///      payment_id was never disputed" and "it was disputed but already resolved" (receipt
    ///      already posted, or already slashed) — both collapse to the same observable fact, "no
    ///      open dispute right now," since resolution deletes the record. This is also the
    ///      contract's REPLAY defense: posting the same valid receipt a second time finds no
    ///      `Dispute` left to close (the first call already deleted it) and is rejected here, not
    ///      accepted as a silent no-op — a specific, deliberately chosen signal ("already
    ///      resolved," reported the same way as "never disputed" since the state left behind is
    ///      identical) rather than a distinct "replay detected" error, because this contract has
    ///      no post-resolution record to compare a replay against once the `Dispute` is gone.
    ///   2. `ListingNotFound` — the dispute is real, but its `resource_key_hash` has no `Listing`
    ///      record. Not reachable in practice (a `Dispute` cannot exist without the `Listing` that
    ///      `file_dispute` required to create it, and nothing deletes a `Listing` record), but
    ///      handled explicitly rather than unwrapped, matching this file's existing convention of
    ///      never assuming an invariant holds without checking it at the point it's relied on.
    ///   3. `NoDeliveryKeyRegistered` — the listing has no `delivery_pubkey` set (Gap 1). Fails
    ///      closed: with no registered key, no signature can ever be valid, so this is checked and
    ///      reported distinctly rather than letting a `None` key flow into the verify call.
    ///   4. `ResponseWindowElapsed` — `now >= dispute.filed_at + PLACEHOLDER_RESPONSE_WINDOW_SECONDS`.
    ///      See "Response window boundary" below for why this is the exact cutoff, checked BEFORE
    ///      signature verification: a late receipt is rejected on timing alone regardless of
    ///      whether it's genuinely valid, so a seller gets a clear "you were too late" signal
    ///      rather than an ambiguous crypto failure for what was actually a timing miss.
    ///   5. Signature verification — see "On signature failure" below.
    ///
    /// ## Response window boundary — exclusive at the edge, symmetric with `finalize`
    ///
    /// `post_receipt` succeeds only while `now < dispute.filed_at + PLACEHOLDER_RESPONSE_WINDOW_SECONDS`
    /// — strictly before the boundary instant, not inclusive of it. This is the deliberate mirror
    /// of `finalize`'s own gate (`now >= filed_at + PLACEHOLDER_RESPONSE_WINDOW_SECONDS`, inclusive):
    /// the two conditions are exact complements of each other over every possible `now`, so at
    /// every instant EXACTLY ONE of `post_receipt` or `finalize` is eligible to resolve a given
    /// open dispute — never both (which would create a race between "receipt defeats it" and
    /// "slash resolves it" landing in the same ledger) and never neither (which would leave a
    /// resolved-but-unresolvable dispute in limbo at the exact boundary instant). This is the same
    /// "pick one side of the inequality and hold it precisely" discipline the rate-limiter fix
    /// this pass was told to study applied to its own boundary — chosen here explicitly rather
    /// than left ambiguous, and tested in both directions (`response_window_boundary_*` tests).
    ///
    /// ## On signature failure — panics, does not return `Err`, and why there is no dedicated
    /// ## error variant for it
    ///
    /// `env.crypto().ed25519_verify` is a Soroban host function that PANICS (traps the whole
    /// transaction) on an invalid signature; it has no `Result`-returning or boolean-returning
    /// form in this SDK. This is documented in `soroban-sdk`'s own `ed25519_verify` doc-comment
    /// ("### Panics — If the signature verification fails") and is true across every published
    /// soroban-sdk version, not a quirk of this one. This mirrors exactly the situation this
    /// contract's `Error::NotInitialized` doc-comment already documents for `Address::require_auth`
    /// — "the host refused to authenticate this caller is not something the contract's code path
    /// ever reaches to return a value for."
    ///
    /// An earlier version of this contract carried two `Error` variants for this —
    /// `InvalidReceiptSignature` and `ReceiptPaymentIdMismatch` — named as documentation for a
    /// caller's error surface even though neither was ever actually constructed or returned. Both
    /// were removed: a named error variant that no code path can produce is misleading in a
    /// financial contract regardless of how well a comment nearby explains it — a reader of the
    /// `Error` enum alone has no way to tell it apart from a real, reachable outcome without
    /// tracing every call site, which defeats the point of the enum documenting the contract's
    /// real behavior. What actually happens on any of the three signature-adversarial cases below
    /// is a host trap, full stop — that is the true, complete, and now honestly-represented
    /// behavior, not an approximation of one two removed variants used to stand in for.
    ///
    /// A tampered message (Section 3's adversarial case: a genuinely valid signature over a
    /// message with one byte flipped, e.g. a different `response_hash`), a signature from the
    /// wrong keypair, and a signature genuinely produced for a DIFFERENT `payment_id` (Section 3's
    /// "different payment_id" adversarial case: signing over payment A's tuple and submitting it
    /// against payment B's dispute produces a message that does not match the tuple this contract
    /// reconstructs from ITS OWN `payment_id` argument, so it fails verification exactly like any
    /// other tampered message — there is no separate comparison needed to catch this specific
    /// case, because the payment_id is already baked into the signed byte string this contract
    /// reconstructs from its own trusted argument, not from anything the caller asserts about
    /// which payment the signature was "for") are all exactly the same category of failure from
    /// this function's point of view: the reconstructed message plus the supplied signature does
    /// not verify against `listing.delivery_pubkey`, and the host traps. All three are exercised
    /// as `#[should_panic]` tests, the same convention this file already uses for every other
    /// host-level trap (see e.g. `register_settlement_fails_without_admin_authorization`).
    pub fn post_receipt(
        env: Env,
        payment_id: BytesN<32>,
        response_hash: BytesN<32>,
        timestamp: u64,
        signature: BytesN<64>,
    ) -> Result<(), Error> {
        let dispute_key = DataKey::Dispute(payment_id.clone());
        let dispute: Dispute = env
            .storage()
            .persistent()
            .get(&dispute_key)
            .ok_or(Error::DisputeNotFound)?;

        let listing_key = DataKey::Listing(dispute.resource_key_hash.clone());
        let mut listing = env
            .storage()
            .persistent()
            .get::<DataKey, Listing>(&listing_key)
            .ok_or(Error::ListingNotFound)?;

        let delivery_pubkey = listing
            .delivery_pubkey
            .clone()
            .ok_or(Error::NoDeliveryKeyRegistered)?;

        let now = env.ledger().timestamp();
        let response_deadline = dispute
            .filed_at
            .saturating_add(PLACEHOLDER_RESPONSE_WINDOW_SECONDS);
        if now >= response_deadline {
            return Err(Error::ResponseWindowElapsed);
        }

        // Panics (traps the transaction) on any invalid signature — tampered message, wrong key,
        // or a receipt signed for a different payment_id. See this function's doc-comment ("On
        // signature failure") for why no `Err` is returned for this specific check.
        let message = Self::receipt_message(&env, &payment_id, &response_hash, timestamp);
        env.crypto()
            .ed25519_verify(&delivery_pubkey, &message, &signature);

        // Reaching here means the signature verified. Close the dispute: delete the record and
        // decrement the listing's open count. No fund movement — a defeated dispute is never
        // slashed.
        env.storage().persistent().remove(&dispute_key);
        listing.open_dispute_count = listing.open_dispute_count.saturating_sub(1);
        env.storage().persistent().set(&listing_key, &listing);

        Ok(())
    }

    /// Permissionless slash execution: once a dispute's response window has expired with no
    /// valid receipt posted, anyone may call this to execute the slash and close the dispute
    /// (Section 3: "the slash executes automatically via a permissionless finalize call, since
    /// Soroban contracts cannot self-trigger on elapsed time").
    ///
    /// * `payment_id` — identifies the disputed settlement; must have an OPEN `Dispute` record.
    ///
    /// Deliberately no `caller` parameter and no `require_auth()` anywhere in this function — the
    /// design doc requires this call to be callable by anyone, precisely because nothing else CAN
    /// trigger it once the window elapses. Gating it to a specific caller (the payer, the admin,
    /// anyone) would reintroduce exactly the "nothing triggers this" problem the permissionless
    /// design exists to solve, since there is no guarantee the gated party is online, watching, or
    /// even still exists by the time the window closes.
    ///
    /// ## Checks, in order
    ///
    ///   1. `DisputeNotFound` — same meaning and same collapsed "never disputed OR already
    ///      resolved" semantics as `post_receipt`'s identical first check (see its doc-comment) —
    ///      covers both a `payment_id` that was never disputed and one whose dispute already
    ///      resolved (receipt already posted via `post_receipt`, or already slashed by a PRIOR
    ///      `finalize` call — this is also this function's replay/double-slash defense: a second
    ///      `finalize` call against an already-resolved `payment_id` finds no `Dispute` record
    ///      left and is rejected here, never re-slashing).
    ///   2. `SettlementNotFound` — not realistically reachable (a `Dispute` cannot exist without
    ///      the `SettlementRecord` `file_dispute` required to create it, and nothing ever deletes
    ///      a `SettlementRecord`), but checked explicitly rather than unwrapped, same rationale as
    ///      `post_receipt`'s equivalent `ListingNotFound` check.
    ///   3. `ListingNotFound` — same rationale.
    ///   4. `ResponseWindowStillOpen` — `now < dispute.filed_at + PLACEHOLDER_RESPONSE_WINDOW_SECONDS`.
    ///      The exact complement of `post_receipt`'s own boundary check — see `post_receipt`'s
    ///      "Response window boundary" doc-comment for why the two are complements by
    ///      construction, checked here as `now >= deadline` to succeed (inclusive of the exact
    ///      boundary instant, mirroring `withdraw`'s own `now >= last_claim_window_end` inclusive
    ///      convention elsewhere in this file).
    ///
    /// ## Slash amount and destination (Gap 2 — see the module-level doc-comment for the full
    /// reasoning)
    ///
    /// `slash_amount = min(settlement.amount, listing.bond_amount)`, transferred to
    /// `settlement.payer`. `listing.bond_amount` is reduced by exactly `slash_amount` — using
    /// `checked_sub`, which cannot underflow given the `min(...)` cap (the subtrahend is
    /// mathematically bounded by the minuend by construction), but checked rather than assumed,
    /// matching this file's existing arithmetic-safety convention (`deposit`'s `checked_add`,
    /// `file_dispute`'s `checked_add` on `open_dispute_count`). A fully-drained bond
    /// (`slash_amount == listing.bond_amount`) leaves `bond_amount` at EXACTLY `0`, never negative
    /// — the cap makes a negative result unreachable, not merely unlikely.
    ///
    /// ## Atomicity — token transfer and dispute-closing state writes in one call
    ///
    /// The design doc's atomicity requirement is satisfied by two properties, stated explicitly
    /// rather than left implicit:
    ///
    ///   1. **Soroban contract execution is atomic per invocation** (already the exact reasoning
    ///      Section 5's "bond withdrawal race" analysis and `withdraw`'s doc-comment rely on): if
    ///      ANY part of this function traps — including the token transfer, if the escrow's own
    ///      balance accounting were ever wrong and the transfer failed — the ENTIRE transaction,
    ///      including every storage write already made earlier in the same call, is rolled back by
    ///      the host. There is no code path where this contract's own state writes commit while
    ///      the transfer silently fails, or vice versa, regardless of what order they appear in
    ///      this function's source.
    ///   2. **State is nonetheless written only AFTER the transfer succeeds**, matching `deposit`'s
    ///      existing "move funds, then persist" ordering and for the same documented reason there:
    ///      even though atomicity is already guaranteed by (1), writing state after the transfer
    ///      means the amount and destination actually moved are never inferred from state this
    ///      function itself just wrote — the transfer either completes for the exact
    ///      `slash_amount` computed, or the whole call aborts before any `Dispute`/`Listing` write
    ///      lands, which is the stronger and more auditable property to hold even though (1) alone
    ///      would already make a partial-success outcome impossible.
    ///
    /// A dedicated atomicity test (`finalize_atomically_updates_state_and_transfers_funds_in_one_call`)
    /// observes all three post-conditions — dispute gone, `bond_amount` reduced by exactly
    /// `slash_amount`, payer's balance increased by exactly `slash_amount` — from a SINGLE
    /// post-call state read, not three separate assumptions.
    pub fn finalize(env: Env, payment_id: BytesN<32>) -> Result<i128, Error> {
        let dispute_key = DataKey::Dispute(payment_id.clone());
        let dispute: Dispute = env
            .storage()
            .persistent()
            .get(&dispute_key)
            .ok_or(Error::DisputeNotFound)?;

        let settlement: SettlementRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Settlement(payment_id.clone()))
            .ok_or(Error::SettlementNotFound)?;

        let listing_key = DataKey::Listing(dispute.resource_key_hash.clone());
        let mut listing = env
            .storage()
            .persistent()
            .get::<DataKey, Listing>(&listing_key)
            .ok_or(Error::ListingNotFound)?;

        let now = env.ledger().timestamp();
        let response_deadline = dispute
            .filed_at
            .saturating_add(PLACEHOLDER_RESPONSE_WINDOW_SECONDS);
        if now < response_deadline {
            return Err(Error::ResponseWindowStillOpen);
        }

        let slash_amount = if settlement.amount < listing.bond_amount {
            settlement.amount
        } else {
            listing.bond_amount
        };

        // Move funds first; only on success do we write the dispute-closing state, per this
        // function's doc-comment ("Atomicity"). A transfer failure traps the whole invocation,
        // which would roll back any state written before it anyway — but writing state after
        // keeps the property true by construction rather than by relying on that host behavior.
        if slash_amount > 0 {
            let client = token::TokenClient::new(&env, &listing.token);
            client.transfer(
                &env.current_contract_address(),
                &settlement.payer,
                &slash_amount,
            );
        }

        listing.bond_amount = listing
            .bond_amount
            .checked_sub(slash_amount)
            .expect("bond_amount underflow");
        listing.open_dispute_count = listing.open_dispute_count.saturating_sub(1);
        env.storage().persistent().set(&listing_key, &listing);
        env.storage().persistent().remove(&dispute_key);

        Ok(slash_amount)
    }

    /// Hash a canonical resource key's UTF-8 bytes into the bounded `BytesN<32>` storage-key
    /// space every listing and settlement record is keyed by. See the module-level doc-comment
    /// for why this hashing happens inside the contract rather than being trusted as an input.
    fn hash_resource_key(env: &Env, resource_key: &Bytes) -> BytesN<32> {
        env.crypto().sha256(resource_key).to_bytes()
    }

    /// Build the canonical signed-message byte string for a delivery receipt: the
    /// big-endian concatenation `payment_id (32) || response_hash (32) || timestamp (8, BE u64)`,
    /// 72 bytes total. See `post_receipt`'s doc-comment ("Message encoding") for why this exact,
    /// fully-specified layout matters and must be reproduced identically by any off-chain signer.
    fn receipt_message(
        env: &Env,
        payment_id: &BytesN<32>,
        response_hash: &BytesN<32>,
        timestamp: u64,
    ) -> Bytes {
        let mut message = Bytes::new(env);
        message.append(&payment_id.clone().into());
        message.append(&response_hash.clone().into());
        message.extend_from_array(&timestamp.to_be_bytes());
        message
    }

    /// Load the stored admin, or fail with `NotInitialized` if `initialize` has not run yet.
    /// Centralizing this check means every gated entry point fails the same explicit way rather
    /// than each reimplementing "is there an admin" separately.
    fn require_admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    /// Enforce `file_dispute`'s per-payer rolling-window rate limit and, if it passes, record this
    /// filing in the payer's log. See `file_dispute`'s doc-comment ("Rate limiting") for the full
    /// mechanism description; this helper is the implementation of steps 1-4 there.
    fn enforce_and_record_rate_limit(env: &Env, payer: &Address, now: u64) -> Result<(), Error> {
        let log_key = DataKey::DisputeLog(payer.clone());
        let existing: Vec<u64> = env
            .storage()
            .persistent()
            .get(&log_key)
            .unwrap_or_else(|| vec![env]);

        // Exclusive-at-start: an entry exactly PLACEHOLDER_DISPUTE_RATE_LIMIT_WINDOW_SECONDS old
        // (ts == window_start) is pruned, not counted. `ts >= window_start` would count it,
        // making the effective window WINDOW+1 seconds wide and over-counting at the boundary —
        // corrected to `ts > window_start` so the window is exactly WINDOW seconds, no wider.
        let window_start = now.saturating_sub(PLACEHOLDER_DISPUTE_RATE_LIMIT_WINDOW_SECONDS);
        let mut pruned: Vec<u64> = vec![env];
        for ts in existing.iter() {
            if ts > window_start {
                pruned.push_back(ts);
            }
        }

        if pruned.len() >= PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX {
            return Err(Error::DisputeRateLimited);
        }

        pruned.push_back(now);
        env.storage().persistent().set(&log_key, &pruned);

        Ok(())
    }
}

mod test;
