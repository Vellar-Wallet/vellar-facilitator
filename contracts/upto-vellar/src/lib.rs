#![no_std]

//! Vellar `upto` settlement contract.
//!
//! Implements `contracts/upto-vellar/DESIGN.md`, which was committed before this
//! file existed. Written from that brief and Soroban's auth model, not derived
//! from `contracts/upto-stellar/` (the vendored rail402 implementation).
//!
//! The scheme in one line: the buyer signs a **ceiling**, the facilitator settles
//! the **actual** metered amount, and this contract enforces `actual <= ceiling`
//! on-ledger before any funds move.
//!
//! The security properties worth stating up front, because they are what a
//! reviewer should check first:
//!
//! - **No custody** (SR-1). Value moves directly from payer to recipient in a
//!   single cross-contract call. This contract never holds a balance.
//! - **No admin, no upgrade** (SR-1, SR-3). There is one state-changing entry
//!   point and no privileged caller. The deployer has no standing after deploy.
//! - **The buyer authorizes the ceiling, not the charge** (SR-2). `actual_amount`
//!   is deliberately excluded from the authorized argument tuple. Within the
//!   ceiling, the facilitator chooses the amount; the chain's guarantee is the
//!   bound, not the price.

use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, BytesN, Env, IntoVal, Symbol,
};

/// Storage key for a consumed nonce.
///
/// Keyed on `(from, nonce)` rather than `nonce` alone (FR-4) so one payer cannot
/// consume another payer's nonce space. Two unrelated buyers picking the same
/// random nonce is not an error and must not be treated as a replay.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// `(payer, nonce)` -> consumed. Presence is the whole signal; see `is_used`.
    Nonce(Address, BytesN<32>),
}

/// Topic for the settlement event (FR-7).
const SETTLED: &str = "upto_settled";

#[contract]
pub struct UptoVellar;

#[contractimpl]
impl UptoVellar {
    /// Settle an `upto` payment.
    ///
    /// `actual_amount` is supplied by the facilitator at settlement time and is
    /// **not** part of what the buyer authorized (SR-2). Everything this contract
    /// guarantees about it is enforced below: non-negative, and no greater than
    /// the ceiling the buyer did sign.
    ///
    /// # Panics
    ///
    /// Before any state change or transfer, in this order (per DESIGN.md):
    ///
    /// 1. `actual_amount` is negative
    /// 2. `actual_amount` exceeds `max_amount`
    /// 3. the current ledger is past `expiration_ledger`
    /// 4. `(from, nonce)` has already been consumed
    ///
    /// Ordering matters for diagnosis rather than safety — every path panics
    /// before the transfer — but a caller reading the failure gets the most
    /// specific reason rather than whichever check happened to run first.
    #[allow(clippy::too_many_arguments)]
    pub fn settle(
        env: Env,
        token: Address,
        from: Address,
        to: Address,
        max_amount: i128,
        expiration_ledger: u32,
        nonce: BytesN<32>,
        actual_amount: i128,
    ) {
        // SR-2: the buyer authorizes THIS invocation over the ceiling tuple.
        // `actual_amount` is deliberately absent from the authorized arguments —
        // that exclusion is the entire difference between `upto` and `exact`.
        //
        // `require_auth_for_args` (rather than `from.require_auth()`) is what
        // binds the authorization to these specific values. A bare `require_auth`
        // would let a signed authorization be replayed against a different token,
        // recipient, ceiling or expiry, since the auth entry would then cover only
        // "this address approves this contract call" with no argument binding.
        from.require_auth_for_args(
            (
                token.clone(),
                from.clone(),
                to.clone(),
                max_amount,
                expiration_ledger,
                nonce.clone(),
            )
                .into_val(&env),
        );

        // FR-3: reject a negative amount before the ceiling comparison.
        //
        // This check is not redundant with the one below. A negative
        // `actual_amount` satisfies `actual <= max` trivially, so without it the
        // ceiling check passes and the contract calls `transfer` with a negative
        // value. SEP-41 implementations are not uniformly required to reject that,
        // so the contract must not assume the token will.
        if actual_amount < 0 {
            panic!("actual_amount must not be negative");
        }

        // FR-3: the ceiling is the buyer's signed bound. This is the check the
        // whole scheme exists for.
        if actual_amount > max_amount {
            panic!("actual_amount exceeds max_amount");
        }

        // FR-5: expiry is in LEDGERS, not wall-clock time. `>` not `>=`, so a
        // settlement landing in exactly `expiration_ledger` is still valid —
        // the authorization is good through that ledger inclusive (TR-12).
        if env.ledger().sequence() > expiration_ledger {
            panic!("authorization has expired");
        }

        // FR-4: replay protection. Checked before any funds move.
        let key = DataKey::Nonce(from.clone(), nonce.clone());
        if env.storage().temporary().has(&key) {
            panic!("nonce already used");
        }

        // Consume the nonce BEFORE the transfer. Ordering is deliberate: if the
        // transfer panics the whole invocation reverts and the nonce is unwritten
        // anyway, so this cannot strand a nonce. Writing first means there is no
        // window in which a transfer has occurred against an unconsumed nonce.
        env.storage().temporary().set(&key, &true);

        // OQ-1, resolved to `expiration_ledger` with NO buffer.
        //
        // The reasoning: FR-5 rejects any settlement past `expiration_ledger`
        // regardless of nonce state, so the expiry check alone closes the replay
        // window. Retaining the nonce record beyond that point would pay Soroban
        // state rent to defend against an attack that FR-5 already refuses. A
        // buffer would be belt-and-braces against a rent-expiry edge case, but it
        // would also be unbounded-in-principle storage growth for no reachable
        // gain.
        //
        // `temporary()` is the correct storage class for exactly this shape:
        // state that is meaningless once a deadline passes.
        let ttl = expiration_ledger.saturating_sub(env.ledger().sequence());
        if ttl > 0 {
            env.storage().temporary().extend_ttl(&key, ttl, ttl);
        }

        // FR-6 / SR-1: one direct transfer, payer to recipient. No `approve` +
        // `transfer_from` (OQ-3) — the transfer is atomic within the invocation
        // that already carries the buyer's authorization, so an allowance would be
        // written and consumed in the same call for no gain. This contract is
        // never a party to the transfer and never holds a balance.
        token::Client::new(&env, &token).transfer(&from, &to, &actual_amount);

        // FR-7: emit AFTER the transfer, so the event is only ever observed for a
        // settlement that actually completed.
        //
        // Both `ceiling` and `actual` are reported. The gap between them is the
        // headroom the buyer authorized but did not spend, which is the property
        // that distinguishes `upto` from `exact` and is otherwise invisible to an
        // indexer reading only the token's own transfer event.
        env.events().publish(
            (Symbol::new(&env, SETTLED),),
            (from, to, max_amount, actual_amount, nonce),
        );
    }

    /// Whether `(from, nonce)` has been consumed (FR-8).
    ///
    /// Read-only and unauthenticated: it reveals only whether a nonce the caller
    /// already knows has been spent, which is public ledger state anyway.
    ///
    /// Note the interaction with the TTL above: this returns `false` for a nonce
    /// whose temporary entry has expired. That is not a replay window — a nonce
    /// can only expire at or after `expiration_ledger`, at which point FR-5
    /// refuses the settlement outright. Callers should read this as "can this
    /// nonce still be used", not as "was this nonce ever used".
    pub fn is_used(env: Env, from: Address, nonce: BytesN<32>) -> bool {
        env.storage()
            .temporary()
            .has(&DataKey::Nonce(from, nonce))
    }
}

#[cfg(test)]
mod test;
