#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, IntoVal,
};

use crate::{Error, UptoContract, UptoContractClient};

/// A stand-in for a payer's spending policy, implementing the settlement-hook ABI so a test can
/// assert `settle` reports the ACTUAL charge back after the transfer. It records the single call it
/// receives; the OZ smart-account canary proves the same path end to end on-ledger against the real
/// policy.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct HookCall {
    pub from: Address,
    pub payment_id: BytesN<32>,
    pub actual: i128,
}

#[contracttype]
enum HookKey {
    Last,
}

#[contract]
struct MockHook;

#[contractimpl]
impl MockHook {
    pub fn release(env: Env, from: Address, payment_id: BytesN<32>, actual: i128) {
        env.storage()
            .instance()
            .set(&HookKey::Last, &HookCall { from, payment_id, actual });
    }

    pub fn last(env: Env) -> Option<HookCall> {
        env.storage().instance().get(&HookKey::Last)
    }
}

struct Fixture<'a> {
    env: Env,
    contract: UptoContractClient<'a>,
    token: Address,
    token_client: TokenClient<'a>,
    payer: Address,
    seller: Address,
}

fn setup() -> Fixture<'static> {
    let env = Env::default();
    env.ledger().set_sequence_number(1000);

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();

    let payer = Address::generate(&env);
    let seller = Address::generate(&env);

    // Mint the payer a balance to spend.
    env.mock_all_auths();
    StellarAssetClient::new(&env, &token).mint(&payer, &10_000);

    let contract_id = env.register(UptoContract, ());
    let contract = UptoContractClient::new(&env, &contract_id);

    Fixture {
        env: env.clone(),
        contract,
        token: token.clone(),
        token_client: TokenClient::new(&env, &token),
        payer,
        seller,
    }
}

fn nonce(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

#[test]
fn settles_less_than_the_authorized_ceiling() {
    let f = setup();
    f.env.mock_all_auths();

    // Client authorized up to 1000; the server metered 250.
    f.contract
        .settle(&f.token, &f.payer, &f.seller, &1000, &2000, &nonce(&f.env, 1), &250, &None);

    assert_eq!(f.token_client.balance(&f.seller), 250);
    assert_eq!(f.token_client.balance(&f.payer), 9_750);
}

#[test]
fn the_residual_allowance_is_bounded_and_unspendable() {
    // The unspent ceiling remains approved to THIS CONTRACT until `expiration_ledger`. That is a
    // deliberate trade: resetting it would need a second signed `approve` sub-invocation on every
    // request. It is safe because the only way to draw it is `settle`, which demands a fresh
    // client signature — and the nonce that produced this allowance is already consumed.
    let f = setup();
    f.env.mock_all_auths();
    let n = nonce(&f.env, 2);

    f.contract.settle(&f.token, &f.payer, &f.seller, &1000, &2000, &n, &250, &None);

    // The residual exists …
    assert_eq!(f.token_client.allowance(&f.payer, &f.contract.address), 750);

    // … but the authorization that created it cannot be reused to spend it.
    assert_eq!(
        f.contract.try_settle(&f.token, &f.payer, &f.seller, &1000, &2000, &n, &750, &None),
        Err(Ok(Error::AuthorizationAlreadyUsed))
    );
    assert_eq!(f.token_client.balance(&f.seller), 250, "residual was not drawn");
}

#[test]
fn settling_the_full_ceiling_works() {
    let f = setup();
    f.env.mock_all_auths();

    f.contract
        .settle(&f.token, &f.payer, &f.seller, &1000, &2000, &nonce(&f.env, 3), &1000, &None);

    assert_eq!(f.token_client.balance(&f.seller), 1000);
}

#[test]
fn zero_settlement_moves_nothing_but_consumes_the_authorization() {
    // The spec explicitly permits settling 0 when no usage occurred.
    let f = setup();
    f.env.mock_all_auths();
    let n = nonce(&f.env, 4);

    f.contract.settle(&f.token, &f.payer, &f.seller, &1000, &2000, &n, &0, &None);

    assert_eq!(f.token_client.balance(&f.seller), 0);
    assert!(f.contract.is_used(&f.payer, &n), "a zero settlement still consumes the nonce");
}

#[test]
fn rejects_settling_more_than_authorized() {
    // The guarantee that matters most: enforced on-ledger, so a dishonest facilitator cannot
    // overcharge even though it is the party supplying `actual_amount`.
    let f = setup();
    f.env.mock_all_auths();

    let result =
        f.contract
            .try_settle(&f.token, &f.payer, &f.seller, &1000, &2000, &nonce(&f.env, 5), &1001, &None);

    assert_eq!(result, Err(Ok(Error::SettlementExceedsAuthorized)));
    assert_eq!(f.token_client.balance(&f.seller), 0);
}

#[test]
fn rejects_a_replayed_authorization() {
    let f = setup();
    f.env.mock_all_auths();
    let n = nonce(&f.env, 6);

    f.contract.settle(&f.token, &f.payer, &f.seller, &1000, &2000, &n, &100, &None);
    let replay = f.contract.try_settle(&f.token, &f.payer, &f.seller, &1000, &2000, &n, &100, &None);

    assert_eq!(replay, Err(Ok(Error::AuthorizationAlreadyUsed)));
    assert_eq!(f.token_client.balance(&f.seller), 100, "replay must not transfer again");
}

#[test]
fn rejects_an_expired_authorization() {
    let f = setup();
    f.env.mock_all_auths();
    f.env.ledger().set_sequence_number(3000);

    let result =
        f.contract
            .try_settle(&f.token, &f.payer, &f.seller, &1000, &2000, &nonce(&f.env, 7), &100, &None);

    assert_eq!(result, Err(Ok(Error::AuthorizationExpired)));
}

#[test]
fn rejects_an_authorization_that_would_outlive_its_nonce_record() {
    // The single-use guarantee is only as long-lived as the consumed-nonce record. An
    // authorization signed for ten days used to settle, lose its nonce record after ~24h, and then
    // settle again for the residual. Refusing it up front is what makes the
    // guarantee hold for the whole of an authorization's life rather than for the first day of it.
    let f = setup();
    f.env.mock_all_auths();

    let far = 1000 + 17_280 * 10;
    assert_eq!(
        f.contract.try_settle(&f.token, &f.payer, &f.seller, &1000, &far, &nonce(&f.env, 20), &1, &None),
        Err(Ok(Error::InvalidExpiration))
    );
    assert_eq!(f.token_client.balance(&f.seller), 0);
    // Rejected before the nonce was consumed, so a mistake here does not burn the authorization.
    assert!(!f.contract.is_used(&f.payer, &nonce(&f.env, 20)));
}

#[test]
fn accepts_an_expiration_at_the_boundary() {
    // Guard against over-correcting: exactly at the limit must still work, and a normal ~60s x402
    // window (~12 ledgers) is three orders of magnitude inside it.
    let f = setup();
    f.env.mock_all_auths();

    let boundary = 1000 + 17_280;
    f.contract
        .settle(&f.token, &f.payer, &f.seller, &1000, &boundary, &nonce(&f.env, 21), &10, &None);
    assert_eq!(f.token_client.balance(&f.seller), 10);

    f.contract
        .settle(&f.token, &f.payer, &f.seller, &1000, &1012, &nonce(&f.env, 22), &10, &None);
    assert_eq!(f.token_client.balance(&f.seller), 20);
}

#[test]
fn rejects_negative_amounts() {
    let f = setup();
    f.env.mock_all_auths();

    assert_eq!(
        f.contract.try_settle(&f.token, &f.payer, &f.seller, &1000, &2000, &nonce(&f.env, 8), &-1, &None),
        Err(Ok(Error::NegativeAmount))
    );
    assert_eq!(
        f.contract.try_settle(&f.token, &f.payer, &f.seller, &-1, &2000, &nonce(&f.env, 9), &0, &None),
        Err(Ok(Error::NegativeAmount))
    );
}

#[test]
fn the_signed_tuple_excludes_actual_amount() {
    // The scheme only works if the client's signature covers the ceiling and the recipient but NOT
    // the metered amount. This asserts the exact authorized argument tuple, so a refactor that
    // accidentally pulled `actual_amount` into the signed args — which would make partial
    // settlement impossible — fails loudly here.
    let f = setup();
    let n = nonce(&f.env, 10);

    f.contract
        .mock_auths(&[MockAuth {
            address: &f.payer,
            invoke: &MockAuthInvoke {
                contract: &f.contract.address,
                fn_name: "settle",
                args: (
                    f.token.clone(),
                    f.seller.clone(),
                    1000_i128,
                    2000_u32,
                    n.clone(),
                )
                    .into_val(&f.env),
                // The client signs a TREE, not just the root. `approve` is invoked on their behalf
                // inside `settle`, so it must be covered by the same signature — and every value in
                // it (ceiling, expiry) is known at signing time. Discovered empirically: omitting
                // this sub-invoke fails with Error(Auth, InvalidAction) / "Unauthorized function
                // call for address" on the approve call.
                sub_invokes: &[MockAuthInvoke {
                    contract: &f.token,
                    fn_name: "approve",
                    args: (
                        f.payer.clone(),
                        f.contract.address.clone(),
                        1000_i128,
                        2000_u32,
                    )
                        .into_val(&f.env),
                    sub_invokes: &[],
                }],
            },
        }])
        .settle(&f.token, &f.payer, &f.seller, &1000, &2000, &n, &137, &None);

    assert_eq!(f.token_client.balance(&f.seller), 137);
}

#[test]
fn a_different_recipient_is_not_covered_by_the_signature() {
    // Recipient binding. The facilitator supplies `to` at submission; if it substitutes another
    // address the client's authorization no longer matches and the host rejects the call.
    let f = setup();
    let attacker = Address::generate(&f.env);
    let n = nonce(&f.env, 11);

    let result = f
        .contract
        .mock_auths(&[MockAuth {
            address: &f.payer,
            invoke: &MockAuthInvoke {
                contract: &f.contract.address,
                fn_name: "settle",
                // Client signed for `seller` …
                args: (f.token.clone(), f.seller.clone(), 1000_i128, 2000_u32, n.clone())
                    .into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        // … but settlement is attempted against `attacker`.
        .try_settle(&f.token, &f.payer, &attacker, &1000, &2000, &n, &100, &None);

    assert!(result.is_err(), "redirecting funds must fail authorization");
    assert_eq!(f.token_client.balance(&attacker), 0);
}

#[test]
fn a_raised_ceiling_is_not_covered_by_the_signature() {
    let f = setup();
    let n = nonce(&f.env, 12);

    let result = f
        .contract
        .mock_auths(&[MockAuth {
            address: &f.payer,
            invoke: &MockAuthInvoke {
                contract: &f.contract.address,
                fn_name: "settle",
                args: (f.token.clone(), f.seller.clone(), 1000_i128, 2000_u32, n.clone())
                    .into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        // Facilitator tries to claim a higher ceiling than was signed.
        .try_settle(&f.token, &f.payer, &f.seller, &5000, &2000, &n, &5000, &None);

    assert!(result.is_err(), "raising the ceiling must fail authorization");
    assert_eq!(f.token_client.balance(&f.seller), 0);
}

#[test]
fn is_used_reports_consumption() {
    let f = setup();
    f.env.mock_all_auths();
    let n = nonce(&f.env, 13);

    assert!(!f.contract.is_used(&f.payer, &n));
    f.contract.settle(&f.token, &f.payer, &f.seller, &500, &2000, &n, &10, &None);
    assert!(f.contract.is_used(&f.payer, &n));
}

#[test]
fn nonces_are_scoped_per_payer() {
    // Two clients independently choosing the same nonce value must not collide.
    let f = setup();
    f.env.mock_all_auths();
    let other = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&other, &5_000);
    let n = nonce(&f.env, 14);

    f.contract.settle(&f.token, &f.payer, &f.seller, &100, &2000, &n, &50, &None);
    f.contract.settle(&f.token, &other, &f.seller, &100, &2000, &n, &50, &None);

    assert_eq!(f.token_client.balance(&f.seller), 100);
}

#[test]
fn settle_reports_the_actual_amount_to_the_hook() {
    // The reconciliation wiring. After the transfer, `settle` reports the ACTUAL charge — not the
    // signed ceiling — to the payer's spending policy, which is what lets a budget refund the
    // unspent difference. A misdirected or absent hook can only fail to reconcile, never overcharge,
    // because it is outside the client's signed tuple.
    let f = setup();
    f.env.mock_all_auths();

    let hook_id = f.env.register(MockHook, ());
    let hook = MockHookClient::new(&f.env, &hook_id);
    let n = nonce(&f.env, 30);

    f.contract
        .settle(&f.token, &f.payer, &f.seller, &1000, &2000, &n, &250, &Some(hook_id.clone()));

    assert_eq!(f.token_client.balance(&f.seller), 250);
    assert_eq!(
        hook.last(),
        Some(HookCall { from: f.payer.clone(), payment_id: n.clone(), actual: 250 }),
        "the hook must be told the metered 250, not the 1000 ceiling",
    );
}

#[test]
fn a_zero_settlement_still_reports_to_the_hook() {
    // A zero settlement returns before any transfer, but must still call the hook so the whole
    // reserved ceiling is released back to the budget rather than stranded. The reported actual is 0.
    let f = setup();
    f.env.mock_all_auths();

    let hook_id = f.env.register(MockHook, ());
    let hook = MockHookClient::new(&f.env, &hook_id);
    let n = nonce(&f.env, 31);

    f.contract
        .settle(&f.token, &f.payer, &f.seller, &1000, &2000, &n, &0, &Some(hook_id.clone()));

    assert_eq!(f.token_client.balance(&f.seller), 0);
    assert_eq!(
        hook.last(),
        Some(HookCall { from: f.payer.clone(), payment_id: n.clone(), actual: 0 }),
    );
}
