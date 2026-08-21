#![no_std]
//! x402 `upto` settlement contract for Stellar.
//!
//! ## Why a contract is required
//!
//! A Soroban authorization entry commits to *exact* invocation arguments. `transfer(from, to,
//! amount)` therefore binds `amount` at signing time, and the `upto` scheme needs the opposite:
//! the client authorizes a **ceiling** and the server settles the **actual** usage afterwards.
//! Something has to sit between the signature and the transfer. Both existing profiles reach the
//! same conclusion — EVM deploys `x402UptoPermit2Proxy`, SVM uses the payment-channels program.
//!
//! ## How the four required guarantees are met
//!
//! `specs/schemes/upto/scheme_upto.md` mandates four properties across every network:
//!
//! | Requirement | Mechanism here |
//! |---|---|
//! | Single-use authorization | A nonce consumed in contract storage, checked before any transfer. Soroban's own auth nonce also covers the signed entry. |
//! | Time-bound validity | `expiration_ledger` is inside the client-signed argument tuple and re-checked on-ledger. |
//! | Recipient binding | `to` is inside the client-signed argument tuple. The facilitator cannot redirect funds without invalidating the signature. |
//! | Maximum amount enforcement | `max_amount` is signed; `actual_amount` is not, and `actual <= max` is asserted on-ledger. |
//!
//! The key detail is `require_auth_for_args`: the client signs over
//! `(token, to, max_amount, expiration_ledger, nonce)` and deliberately **not** over
//! `actual_amount`, which is unknown when they sign. That single choice is what makes the scheme
//! possible while keeping every other parameter cryptographically bound.
//!
//! ## Non-custodial
//!
//! The contract never holds funds. It moves value in exactly one direction, in one transaction,
//! from `from` to the signed `to`. There is no admin, no upgrade path, no withdrawal function and
//! no balance — so there is nothing for an operator or an attacker to drain.

use soroban_sdk::{contract, contractclient, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, IntoVal};

/// The settlement-hook ABI, version 1.
///
/// A smart-account spending policy implements this so `settle` can report the ACTUAL amount back after
/// the transfer, letting the policy refund the part of the authorized ceiling that was never spent.
/// Generic on purpose: the contract knows nothing about the policy beyond this one call, and any
/// policy implementing `release(from, payment_id, actual)` composes with it. Optional: a payer with no
/// such policy (a plain keypair) passes `None` and nothing is called, so `exact`-style keypair buyers
/// are unaffected.
///
/// The hook is deliberately outside the client's signed tuple, like `actual_amount`. Misdirecting it
/// can only fail to reconcile (the wrong policy finds no reservation and no-ops, or rejects a caller
/// it does not recognise), which leaves the budget conservatively over-committed rather than exposed.
#[contractclient(name = "SettlementHookClient")]
pub trait SettlementHook {
    fn release(env: Env, from: Address, payment_id: BytesN<32>, actual: i128);
}

/// Ledger-entry lifetime for a consumed nonce, and therefore the maximum authorization lifetime.
///
/// A nonce record must outlive the authorization that created it, or the single-use guarantee
/// simply stops holding while the authorization is still valid. That is not a property to assume —
/// it has to be enforced, in both directions:
///
///   * a consumed nonce is retained for `NONCE_TTL_LEDGERS`;
///   * `settle` refuses any `expiration_ledger` beyond `current + NONCE_TTL_LEDGERS`.
///
/// Without the second half the invariant is a comment rather than a rule. It was: an authorization
/// signed for ten days settled, the nonce record expired after ~24h, and the identical
/// authorization settled a second time, drawing the residual. Nothing
/// bounded `expiration_ledger`, and `Error::InvalidExpiration` — declared for exactly this — was
/// never returned by any code path.
///
/// ~24h is far above any legitimate x402 window (`maxTimeoutSeconds` defaults to 60s, i.e. ~12
/// ledgers), so this constrains nothing real while making the guarantee true by construction.
const NONCE_TTL_LEDGERS: u32 = 17_280; // ~24h at 5s ledgers

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `actual_amount` exceeded the client-authorized `max_amount`.
    SettlementExceedsAuthorized = 1,
    /// The authorization's `expiration_ledger` has passed.
    AuthorizationExpired = 2,
    /// This nonce was already settled. Authorizations are single-use.
    AuthorizationAlreadyUsed = 3,
    /// A negative amount was supplied.
    NegativeAmount = 4,
    /// `expiration_ledger` is further ahead than the consumed-nonce record can outlive, so the
    /// single-use guarantee could not be honoured for the whole of the authorization's life.
    InvalidExpiration = 5,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// Marks a (payer, nonce) pair as consumed.
    Used(Address, BytesN<32>),
}

#[contract]
pub struct UptoContract;

#[contractimpl]
impl UptoContract {
    /// Settle an `upto` authorization for `actual_amount`, which must not exceed the signed ceiling.
    ///
    /// The client authorizes `(token, to, max_amount, expiration_ledger, nonce)`. `actual_amount`
    /// is supplied by the facilitator at settlement and is intentionally outside the signed tuple.
    ///
    /// * `token` — SEP-41 token contract, signed by the client.
    /// * `from` — the payer, whose authorization is required.
    /// * `to` — the recipient, signed by the client so it cannot be redirected.
    /// * `max_amount` — the authorized ceiling, signed by the client.
    /// * `expiration_ledger` — last ledger at which this authorization is valid, signed.
    /// * `nonce` — client-chosen unique value making the authorization single-use, signed.
    /// * `actual_amount` — metered charge. NOT signed. Must satisfy `0 <= actual <= max_amount`.
    pub fn settle(
        env: Env,
        token: Address,
        from: Address,
        to: Address,
        max_amount: i128,
        expiration_ledger: u32,
        nonce: BytesN<32>,
        actual_amount: i128,
        hook: Option<Address>,
    ) -> Result<(), Error> {
        // Authorize over the ceiling and the recipient, but NOT the metered amount. This is the
        // whole trick: everything the client can meaningfully commit to is bound, and the one
        // value they cannot know is left free and constrained on-ledger instead.
        from.require_auth_for_args(
            (
                token.clone(),
                to.clone(),
                max_amount,
                expiration_ledger,
                nonce.clone(),
            )
                .into_val(&env),
        );

        if max_amount < 0 || actual_amount < 0 {
            return Err(Error::NegativeAmount);
        }
        // Enforced on-ledger, not merely by the facilitator. A dishonest or compromised facilitator
        // still cannot charge more than the client signed for.
        if actual_amount > max_amount {
            return Err(Error::SettlementExceedsAuthorized);
        }

        let current = env.ledger().sequence();
        if expiration_ledger < current {
            return Err(Error::AuthorizationExpired);
        }
        // Refuse an authorization that would outlive the record making it single-use. Checked
        // BEFORE the nonce is consumed, so a rejected authorization is not silently burned.
        if expiration_ledger > current.saturating_add(NONCE_TTL_LEDGERS) {
            return Err(Error::InvalidExpiration);
        }

        // Single-use. Checked and recorded before the transfer, so a re-entrant or replayed call
        // cannot settle twice even if it reaches this point concurrently.
        let key = DataKey::Used(from.clone(), nonce.clone());
        if env.storage().temporary().has(&key) {
            return Err(Error::AuthorizationAlreadyUsed);
        }
        env.storage().temporary().set(&key, &true);
        env.storage()
            .temporary()
            .extend_ttl(&key, NONCE_TTL_LEDGERS, NONCE_TTL_LEDGERS);

        // A zero charge is explicitly valid: the spec allows settling 0 when no usage occurred.
        // Consuming the nonce without moving funds is the correct outcome. The reservation, if any,
        // is still released so the whole ceiling is refunded to the budget.
        if actual_amount == 0 {
            if let Some(h) = &hook {
                SettlementHookClient::new(&env, h).release(&from, &nonce, &0);
            }
            return Ok(());
        }

        // The client's signed tuple covers an `approve` sub-invocation for `max_amount`; the
        // contract then draws only `actual_amount` as spender. `transfer_from` requires the
        // SPENDER's authorization, which is this contract invoking itself — so the facilitator
        // never gains the ability to move funds on its own.
        let client = token::TokenClient::new(&env, &token);
        client.approve(&from, &env.current_contract_address(), &max_amount, &expiration_ledger);
        client.transfer_from(&env.current_contract_address(), &from, &to, &actual_amount);

        // Report the actual figure to the payer's spending policy, if one is wired up, so it can
        // refund the part of the ceiling it reserved but that was never spent. This contract is the
        // caller, so the policy authenticates it via Soroban's invoker authorization; no other party
        // can release the reservation. Absent a policy (`None`) this is skipped entirely.
        if let Some(h) = &hook {
            SettlementHookClient::new(&env, h).release(&from, &nonce, &actual_amount);
        }

        // NOTE: the residual allowance (`max_amount - actual_amount`) is deliberately NOT reset.
        //
        // Resetting it would require a SECOND `approve` sub-invocation, which — like the first —
        // must be covered by the client's signature. That would mean every client signing a
        // two-child auth tree on every request, for no security benefit. Verified empirically: an
        // unreset test fails with Error(Auth, InvalidAction) on `approve(..., 0, ...)`.
        //
        // The residual is not exploitable:
        //   1. The allowance names THIS CONTRACT as spender, so only this contract can draw it.
        //   2. This contract has exactly one state-changing entry point, `settle`, which begins
        //      with `require_auth_for_args` — spending the residual therefore requires another
        //      valid client signature, which is the same bar as any new payment.
        //   3. The nonce for this authorization is already consumed, so this exact authorization
        //      can never be replayed to reach the residual.
        //   4. The allowance carries `expiration_ledger`, so it lapses on its own within the
        //      window the client signed for (~60s at default `maxTimeoutSeconds`).
        //
        // A standing allowance is normally a smell, so this reasoning is stated here explicitly
        // for the audit rather than left implicit.

        Ok(())
    }

    /// Whether a given (payer, nonce) authorization has already been settled.
    ///
    /// Lets a facilitator check before submitting, turning a wasted transaction into a fast
    /// coded rejection.
    pub fn is_used(env: Env, from: Address, nonce: BytesN<32>) -> bool {
        env.storage().temporary().has(&DataKey::Used(from, nonce))
    }
}

mod test;
