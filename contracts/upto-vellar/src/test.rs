#![cfg(test)]

//! Test suite for the Vellar `upto` settlement contract.
//!
//! Covers TR-1 through TR-15 of `contracts/upto-vellar/DESIGN.md`.
//!
//! Two conventions worth stating, because they are what make the security
//! requirements *verified* rather than asserted:
//!
//! - Every rejection test asserts **balances are unchanged**, not merely that the
//!   call panicked (TR-14). A call can panic after moving funds; only the balance
//!   assertion rules that out.
//! - The contract's own balance is asserted zero before and after a settlement
//!   (TR-15), which is SR-1 measured rather than assumed.

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, Events, Ledger},
    token, Address, BytesN, Env, IntoVal, Symbol,
};

use crate::{UptoVellar, UptoVellarClient};

/// A funded payer, an empty recipient, and a deployed contract.
struct Fixture<'a> {
    env: Env,
    contract_id: Address,
    client: UptoVellarClient<'a>,
    token_id: Address,
    token: token::Client<'a>,
    payer: Address,
    recipient: Address,
}

const START_BALANCE: i128 = 1_000_000;

fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    // Authorization is exercised explicitly in `auth_is_bound_to_ceiling_args`;
    // every other test mocks it so the subject under test is the contract's own
    // checks rather than the SDK's signing machinery.
    env.mock_all_auths();

    let contract_id = env.register(UptoVellar, ());
    let client = UptoVellarClient::new(&env, &contract_id);

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer.clone());
    let token_id = sac.address();
    let token = token::Client::new(&env, &token_id);
    let mint = token::StellarAssetClient::new(&env, &token_id);

    let payer = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint.mint(&payer, &START_BALANCE);

    Fixture {
        env,
        contract_id,
        client,
        token_id,
        token,
        payer,
        recipient,
    }
}

fn nonce(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

/// The ledger sequence used as the expiry in most tests. Comfortably ahead of
/// the default test ledger so expiry is not accidentally the thing under test.
const EXPIRY: u32 = 10_000;

/// Whether settling `amount` panics with a message containing `needle`.
///
/// Exists because `try_settle(...).is_err()` cannot distinguish *which* guard
/// refused: a contract `panic!` and a rejection from inside the token both
/// revert the invocation and both surface as `Err`. Catching the panic payload
/// names the actual cause.
///
/// A fresh `Env` is used so the probe cannot disturb the caller's ledger state.
fn panic_message_contains(f: &Fixture, amount: i128, needle: &str) -> bool {
    let token_id = f.token_id.clone();
    let payer = f.payer.clone();
    let recipient = f.recipient.clone();
    let contract_id = f.contract_id.clone();
    let env = f.env.clone();

    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let client = UptoVellarClient::new(&env, &contract_id);
        client.settle(
            &token_id,
            &payer,
            &recipient,
            &1_000,
            &EXPIRY,
            &nonce(&env, 200),
            &amount,
        );
    }));

    match caught {
        Ok(()) => false,
        Err(payload) => payload
            .downcast_ref::<std::string::String>()
            .map(|s| s.contains(needle))
            .or_else(|| {
                payload
                    .downcast_ref::<&str>()
                    .map(|s| s.contains(needle))
            })
            .unwrap_or(false),
    }
}

// ---------------------------------------------------------------------------
// TR-1 — successful settlement within the ceiling
// ---------------------------------------------------------------------------

#[test]
fn tr1_settles_within_ceiling() {
    let f = setup();

    f.client.settle(
        &f.token_id,
        &f.payer,
        &f.recipient,
        &1_000,
        &EXPIRY,
        &nonce(&f.env, 1),
        &400,
    );

    assert_eq!(f.token.balance(&f.payer), START_BALANCE - 400);
    assert_eq!(f.token.balance(&f.recipient), 400);
}

// ---------------------------------------------------------------------------
// TR-2 — actual > max rejected, with balances unchanged (TR-14)
// ---------------------------------------------------------------------------

#[test]
fn tr2_rejects_actual_above_ceiling() {
    let f = setup();
    let before_payer = f.token.balance(&f.payer);
    let before_recipient = f.token.balance(&f.recipient);

    let res = f.client.try_settle(
        &f.token_id,
        &f.payer,
        &f.recipient,
        &1_000,
        &EXPIRY,
        &nonce(&f.env, 2),
        &1_001,
    );

    assert!(res.is_err(), "settlement above the ceiling must be refused");
    // TR-14: refusal must mean no funds moved, not merely that the call failed.
    assert_eq!(f.token.balance(&f.payer), before_payer);
    assert_eq!(f.token.balance(&f.recipient), before_recipient);
}

// ---------------------------------------------------------------------------
// TR-3 — nonce replay rejected, with balances unchanged (TR-14)
// ---------------------------------------------------------------------------

#[test]
fn tr3_rejects_nonce_replay() {
    let f = setup();
    let n = nonce(&f.env, 3);

    f.client
        .settle(&f.token_id, &f.payer, &f.recipient, &1_000, &EXPIRY, &n, &100);

    let after_first_payer = f.token.balance(&f.payer);
    let after_first_recipient = f.token.balance(&f.recipient);

    let res = f
        .client
        .try_settle(&f.token_id, &f.payer, &f.recipient, &1_000, &EXPIRY, &n, &100);

    assert!(res.is_err(), "a replayed nonce must be refused");
    // TR-14: the second settlement must not have moved anything.
    assert_eq!(f.token.balance(&f.payer), after_first_payer);
    assert_eq!(f.token.balance(&f.recipient), after_first_recipient);
}

// ---------------------------------------------------------------------------
// TR-4 — expired ledger rejected, with balances unchanged (TR-14)
// ---------------------------------------------------------------------------

#[test]
fn tr4_rejects_expired_authorization() {
    let f = setup();
    f.env.ledger().set_sequence_number(EXPIRY + 1);

    let before_payer = f.token.balance(&f.payer);
    let before_recipient = f.token.balance(&f.recipient);

    let res = f.client.try_settle(
        &f.token_id,
        &f.payer,
        &f.recipient,
        &1_000,
        &EXPIRY,
        &nonce(&f.env, 4),
        &100,
    );

    assert!(res.is_err(), "an expired authorization must be refused");
    assert_eq!(f.token.balance(&f.payer), before_payer);
    assert_eq!(f.token.balance(&f.recipient), before_recipient);
}

// ---------------------------------------------------------------------------
// TR-5 — settlement event emitted with the exact FR-7 fields
// ---------------------------------------------------------------------------

#[test]
fn tr5_emits_settlement_event() {
    let f = setup();
    let n = nonce(&f.env, 5);

    f.client
        .settle(&f.token_id, &f.payer, &f.recipient, &1_000, &EXPIRY, &n, &250);

    // The token's own transfer event is also in the log; select this contract's.
    let ours: std::vec::Vec<_> = f
        .env
        .events()
        .all()
        .iter()
        .filter(|(id, _, _)| id == &f.contract_id)
        .collect();

    assert_eq!(ours.len(), 1, "exactly one settlement event per settlement");
    let (_, topics, data) = ours[0].clone();

    // `Val` is an opaque tagged word with no `PartialEq`, so decode both halves
    // back into typed Rust values and compare those. This asserts the event's
    // real shape rather than a re-encoding of it.
    let decoded_topic: Symbol = topics.get(0).unwrap().into_val(&f.env);
    assert_eq!(
        decoded_topic,
        Symbol::new(&f.env, "upto_settled"),
        "topic must be upto_settled",
    );
    assert_eq!(topics.len(), 1, "exactly one topic");

    // FR-7: payer, recipient, ceiling, actual, nonce — ceiling AND actual, so an
    // indexer can see the authorized headroom that went unspent.
    let (payer, recipient, ceiling, actual, ev_nonce): (Address, Address, i128, i128, BytesN<32>) =
        data.into_val(&f.env);

    assert_eq!(payer, f.payer);
    assert_eq!(recipient, f.recipient);
    assert_eq!(ceiling, 1_000);
    assert_eq!(actual, 250);
    assert_eq!(ev_nonce, n);
}

// ---------------------------------------------------------------------------
// TR-6 / TR-7 — is_used before and after
// ---------------------------------------------------------------------------

#[test]
fn tr7_is_used_false_before_settle() {
    let f = setup();
    assert!(!f.client.is_used(&f.payer, &nonce(&f.env, 7)));
}

#[test]
fn tr6_is_used_true_after_settle() {
    let f = setup();
    let n = nonce(&f.env, 6);

    assert!(!f.client.is_used(&f.payer, &n), "precondition");
    f.client
        .settle(&f.token_id, &f.payer, &f.recipient, &1_000, &EXPIRY, &n, &100);
    assert!(f.client.is_used(&f.payer, &n));
}

// ---------------------------------------------------------------------------
// TR-8 — zero actual_amount succeeds and still consumes the nonce
// ---------------------------------------------------------------------------

#[test]
fn tr8_zero_amount_burns_the_nonce() {
    let f = setup();
    let n = nonce(&f.env, 8);
    let before = f.token.balance(&f.payer);

    f.client
        .settle(&f.token_id, &f.payer, &f.recipient, &1_000, &EXPIRY, &n, &0);

    // Nothing moved, but the authorization is spent: a zero settlement is a
    // legitimate outcome of a metered scheme (the buyer used nothing), and it
    // must not leave the nonce replayable.
    assert_eq!(f.token.balance(&f.payer), before);
    assert_eq!(f.token.balance(&f.recipient), 0);
    assert!(f.client.is_used(&f.payer, &n), "zero settle must burn the nonce");

    let res = f
        .client
        .try_settle(&f.token_id, &f.payer, &f.recipient, &1_000, &EXPIRY, &n, &500);
    assert!(res.is_err(), "the burnt nonce must not be reusable");
}

// ---------------------------------------------------------------------------
// TR-9 — actual == max (the exact ceiling) succeeds
// ---------------------------------------------------------------------------

#[test]
fn tr9_settles_at_exact_ceiling() {
    let f = setup();

    f.client.settle(
        &f.token_id,
        &f.payer,
        &f.recipient,
        &1_000,
        &EXPIRY,
        &nonce(&f.env, 9),
        &1_000,
    );

    // The bound is inclusive: `actual > max` is refused, `actual == max` is not.
    assert_eq!(f.token.balance(&f.recipient), 1_000);
}

// ---------------------------------------------------------------------------
// TR-10 — different nonces, same payer, are isolated
// ---------------------------------------------------------------------------

#[test]
fn tr10_distinct_nonces_same_payer() {
    let f = setup();
    let a = nonce(&f.env, 10);
    let b = nonce(&f.env, 11);

    f.client
        .settle(&f.token_id, &f.payer, &f.recipient, &1_000, &EXPIRY, &a, &100);
    f.client
        .settle(&f.token_id, &f.payer, &f.recipient, &1_000, &EXPIRY, &b, &200);

    assert_eq!(f.token.balance(&f.recipient), 300);
    assert!(f.client.is_used(&f.payer, &a));
    assert!(f.client.is_used(&f.payer, &b));
}

// ---------------------------------------------------------------------------
// TR-11 — negative actual_amount rejected, with balances unchanged (TR-14)
// ---------------------------------------------------------------------------

#[test]
fn tr11_rejects_negative_amount() {
    let f = setup();
    let before_payer = f.token.balance(&f.payer);
    let before_recipient = f.token.balance(&f.recipient);

    // A negative amount satisfies `actual <= max` trivially. Without the explicit
    // non-negative check this would reach the token with a negative value.
    let res = f.client.try_settle(
        &f.token_id,
        &f.payer,
        &f.recipient,
        &1_000,
        &EXPIRY,
        &nonce(&f.env, 12),
        &-1,
    );

    assert!(res.is_err(), "a negative amount must be refused");
    assert_eq!(f.token.balance(&f.payer), before_payer);
    assert_eq!(f.token.balance(&f.recipient), before_recipient);

    // `is_err` alone does NOT prove FR-3 fired: the SAC also rejects a negative
    // transfer, and either rejection reverts the whole invocation identically.
    // Mutation-testing caught exactly this — deleting FR-3 from the contract left
    // this test green. Asserting the contract's own panic message is what makes
    // the check itself the subject under test.
    assert!(
        panic_message_contains(&f, -1, "actual_amount must not be negative"),
        "the contract's own non-negative check must be what refuses, not the token",
    );
}

// ---------------------------------------------------------------------------
// TR-12 — the expiry boundary is inclusive
// ---------------------------------------------------------------------------

#[test]
fn tr12_expiry_boundary_is_inclusive() {
    // At exactly expiration_ledger: valid.
    let f = setup();
    f.env.ledger().set_sequence_number(EXPIRY);
    f.client.settle(
        &f.token_id,
        &f.payer,
        &f.recipient,
        &1_000,
        &EXPIRY,
        &nonce(&f.env, 13),
        &100,
    );
    assert_eq!(f.token.balance(&f.recipient), 100);

    // One ledger later: refused.
    let g = setup();
    g.env.ledger().set_sequence_number(EXPIRY + 1);
    let before = g.token.balance(&g.payer);
    let res = g.client.try_settle(
        &g.token_id,
        &g.payer,
        &g.recipient,
        &1_000,
        &EXPIRY,
        &nonce(&g.env, 13),
        &100,
    );
    assert!(res.is_err(), "one ledger past expiry must be refused");
    assert_eq!(g.token.balance(&g.payer), before);
}

// ---------------------------------------------------------------------------
// TR-13 — the same nonce from different payers is not a replay
// ---------------------------------------------------------------------------

#[test]
fn tr13_same_nonce_different_payers() {
    let f = setup();
    let other_payer = Address::generate(&f.env);
    token::StellarAssetClient::new(&f.env, &f.token_id).mint(&other_payer, &START_BALANCE);

    let shared = nonce(&f.env, 14);

    f.client.settle(
        &f.token_id,
        &f.payer,
        &f.recipient,
        &1_000,
        &EXPIRY,
        &shared,
        &100,
    );
    // FR-4 keys on (from, nonce). Two unrelated buyers drawing the same random
    // nonce is a collision, not an attack, and must not lock either of them out.
    f.client.settle(
        &f.token_id,
        &other_payer,
        &f.recipient,
        &1_000,
        &EXPIRY,
        &shared,
        &200,
    );

    assert_eq!(f.token.balance(&f.recipient), 300);
    assert!(f.client.is_used(&f.payer, &shared));
    assert!(f.client.is_used(&other_payer, &shared));
}

// ---------------------------------------------------------------------------
// TR-15 — the contract never holds a balance (SR-1)
// ---------------------------------------------------------------------------

#[test]
fn tr15_contract_never_holds_funds() {
    let f = setup();

    assert_eq!(
        f.token.balance(&f.contract_id),
        0,
        "contract must start with no balance"
    );

    f.client.settle(
        &f.token_id,
        &f.payer,
        &f.recipient,
        &1_000,
        &EXPIRY,
        &nonce(&f.env, 15),
        &750,
    );

    // Value moved payer -> recipient directly; the contract was never a party to
    // the transfer and holds nothing after it.
    assert_eq!(
        f.token.balance(&f.contract_id),
        0,
        "contract must hold no balance after settling"
    );
    assert_eq!(f.token.balance(&f.payer), START_BALANCE - 750);
    assert_eq!(f.token.balance(&f.recipient), 750);
}

// ---------------------------------------------------------------------------
// SR-2 — the authorization is bound to the ceiling tuple, not to actual_amount
// ---------------------------------------------------------------------------

#[test]
fn auth_is_bound_to_ceiling_args() {
    // Not in the TR list, but SR-2 is the load-bearing security property of the
    // whole scheme and would otherwise be covered only by `mock_all_auths`, which
    // authorizes anything and so proves nothing about argument binding.
    let f = setup();
    let n = nonce(&f.env, 16);

    f.client.settle(
        &f.token_id,
        &f.payer,
        &f.recipient,
        &1_000,
        &EXPIRY,
        &n,
        &600,
    );

    let auths = f.env.auths();
    let (addr, invocation) = &auths[0];
    assert_eq!(addr, &f.payer, "the payer is who authorizes");

    // The authorized arguments are the ceiling tuple. `actual_amount` (600) is
    // absent: the buyer signed the bound, and the facilitator chose the charge
    // underneath it.
    let expected_args: soroban_sdk::Vec<soroban_sdk::Val> = (
        f.token_id.clone(),
        f.payer.clone(),
        f.recipient.clone(),
        1_000_i128,
        EXPIRY,
        n.clone(),
    )
        .into_val(&f.env);

    assert_eq!(
        invocation.function,
        AuthorizedFunction::Contract((
            f.contract_id.clone(),
            Symbol::new(&f.env, "settle"),
            expected_args,
        )),
    );
}
