#![cfg(test)]

use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    Address, Bytes, BytesN, Env,
};

use crate::{
    BondEscrowContract, BondEscrowContractClient, Error, PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX,
    PLACEHOLDER_DISPUTE_RATE_LIMIT_WINDOW_SECONDS, PLACEHOLDER_DISPUTE_WINDOW_SECONDS,
    PLACEHOLDER_DUST_FLOOR, PLACEHOLDER_RESPONSE_WINDOW_SECONDS,
};

struct Fixture<'a> {
    env: Env,
    contract: BondEscrowContractClient<'a>,
    admin: Address,
    token: Address,
    seller: Address,
    payer: Address,
}

fn setup() -> Fixture<'static> {
    let env = Env::default();
    env.ledger().set_timestamp(1_000_000);

    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = sac.address();

    let admin = Address::generate(&env);
    let seller = Address::generate(&env);
    let payer = Address::generate(&env);

    env.mock_all_auths();
    StellarAssetClient::new(&env, &token).mint(&seller, &1_000_000);

    let contract_id = env.register(BondEscrowContract, ());
    let contract = BondEscrowContractClient::new(&env, &contract_id);
    contract.initialize(&admin);

    Fixture { env: env.clone(), contract, admin, token, seller, payer }
}

fn resource_key(env: &Env, s: &str) -> Bytes {
    Bytes::from_slice(env, s.as_bytes())
}

fn payment_id(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

/// Like `payment_id`, but spread across two bytes so tests needing more than 256 distinct ids
/// (the rate-limit boundary tests) don't collide.
fn payment_id2(env: &Env, hi: u8, lo: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[30] = hi;
    bytes[31] = lo;
    BytesN::from_array(env, &bytes)
}

// ── receipt-signing test helpers ────────────────────────────────────────────
//
// `post_receipt` verifies raw Ed25519 signatures over a specific 72-byte encoding (see
// `receipt_message`'s doc-comment in lib.rs). These helpers generate real keypairs and sign that
// exact byte layout directly with `ed25519-dalek`, independent of Soroban's own
// auth-signing/mocking machinery (`mock_all_auths` etc. only cover `require_auth`, not this
// contract's own `ed25519_verify` call).

/// Generate a fresh Ed25519 keypair for use as a listing's delivery-signing key.
fn generate_keypair() -> SigningKey {
    SigningKey::generate(&mut OsRng)
}

/// The raw 32-byte public key, as this contract expects it for `set_delivery_key`/storage.
fn pubkey_bytes(env: &Env, key: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &key.verifying_key().to_bytes())
}

/// Build the exact same 72-byte message `post_receipt` reconstructs on-chain:
/// `payment_id (32) || response_hash (32) || timestamp (8, big-endian)`. Kept as an independent
/// re-implementation here (not calling into the contract's own private `receipt_message` helper)
/// so a bug in the contract's encoding would show up as a signature mismatch in tests, the same
/// way a real off-chain seller's signer would diverge.
fn build_receipt_message(payment_id: &BytesN<32>, response_hash: &BytesN<32>, timestamp: u64) -> [u8; 72] {
    let mut message = [0u8; 72];
    message[0..32].copy_from_slice(&payment_id.to_array());
    message[32..64].copy_from_slice(&response_hash.to_array());
    message[64..72].copy_from_slice(&timestamp.to_be_bytes());
    message
}

/// Sign a receipt tuple with the given key, returning the raw 64-byte signature this contract
/// expects.
fn sign_receipt(
    env: &Env,
    key: &SigningKey,
    payment_id: &BytesN<32>,
    response_hash: &BytesN<32>,
    timestamp: u64,
) -> BytesN<64> {
    let message = build_receipt_message(payment_id, response_hash, timestamp);
    let signature = key.sign(&message);
    BytesN::from_array(env, &signature.to_bytes())
}

fn response_hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

// ── initialize ──────────────────────────────────────────────────────────────

#[test]
fn initialize_sets_the_admin() {
    let f = setup();
    assert_eq!(f.contract.get_admin(), Some(f.admin.clone()));
}

#[test]
fn initialize_is_single_use() {
    let f = setup();
    f.env.mock_all_auths();
    let other = Address::generate(&f.env);

    let result = f.contract.try_initialize(&other);

    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
    // The original admin must still be the one on record — a second call must not silently
    // re-assign authorization even though it failed.
    assert_eq!(f.contract.get_admin(), Some(f.admin));
}

#[test]
fn get_admin_is_none_before_initialize() {
    let env = Env::default();
    let contract_id = env.register(BondEscrowContract, ());
    let contract = BondEscrowContractClient::new(&env, &contract_id);

    assert_eq!(contract.get_admin(), None);
}

// ── register_settlement: happy path ─────────────────────────────────────────

#[test]
fn registers_a_settlement() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 1);

    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);

    let record = f.contract.get_settlement(&pid).expect("settlement should be recorded");
    assert_eq!(record.payer, f.payer);
    assert_eq!(record.seller, f.seller);
    assert_eq!(record.amount, 500);
}

#[test]
fn registering_a_settlement_refreshes_an_existing_listings_claim_window() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    f.contract.deposit(&f.seller, &key, &f.token, &1_000);

    let before = f.contract.get_listing(&key).unwrap();
    assert_eq!(before.last_claim_window_end, 0, "no settlement registered yet");

    f.env.ledger().set_timestamp(2_000_000);
    f.contract.register_settlement(&payment_id(&f.env, 2), &f.payer, &f.seller, &key, &500);

    let after = f.contract.get_listing(&key).unwrap();
    assert!(after.last_claim_window_end > 2_000_000, "claim window must extend past now");
}

#[test]
fn registering_a_settlement_against_an_unbonded_resource_key_does_not_create_a_listing() {
    // Deliberate design choice: registration alone must not fabricate a zero-bond `Listing`.
    // See `register_settlement`'s doc-comment ("Whether a listing must already exist").
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/never-bonded");

    f.contract.register_settlement(&payment_id(&f.env, 3), &f.payer, &f.seller, &key, &500);

    assert_eq!(f.contract.get_listing(&key), None);
    // But the settlement itself is still recorded — standing to dispute does not depend on a
    // bond existing.
    assert!(f.contract.get_settlement(&payment_id(&f.env, 3)).is_some());
}

// ── register_settlement: authorization ──────────────────────────────────────

#[test]
#[should_panic]
fn register_settlement_fails_without_admin_authorization() {
    // `setup()` uses `mock_all_auths()` (sticky for the whole `Env`) to mint the seller's balance
    // and call `initialize`. `set_auths(&[])` explicitly disables that mocking and asserts an
    // EMPTY set of real authorization entries, so `admin.require_auth()` inside
    // `register_settlement` has nothing to match and the host must trap.
    let f = setup();
    f.env.set_auths(&[]);
    let key = resource_key(&f.env, "https://example.com/api/data");

    f.contract.register_settlement(&payment_id(&f.env, 4), &f.payer, &f.seller, &key, &500);
}

#[test]
fn register_settlement_fails_before_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(BondEscrowContract, ());
    let contract = BondEscrowContractClient::new(&env, &contract_id);
    let payer = Address::generate(&env);
    let seller = Address::generate(&env);
    let key = resource_key(&env, "https://example.com/api/data");

    let result = contract.try_register_settlement(&payment_id(&env, 5), &payer, &seller, &key, &500);

    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

// ── register_settlement: double-registration ────────────────────────────────

#[test]
fn double_registration_of_the_same_payment_id_is_rejected() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 6);

    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);
    let second = f.contract.try_register_settlement(&pid, &f.payer, &f.seller, &key, &999);

    assert_eq!(second, Err(Ok(Error::SettlementAlreadyRegistered)));
    // The FIRST registration's facts must survive untouched — a rejected second call must not
    // overwrite anything, even partially.
    let record = f.contract.get_settlement(&pid).unwrap();
    assert_eq!(record.amount, 500);
}

#[test]
fn double_registration_is_rejected_even_with_a_different_payer_and_seller() {
    // A forged second registration attempting to rewrite standing to a DIFFERENT payer for an
    // already-registered payment_id must still be rejected — this is exactly the "compromised
    // caller rewrites dispute standing" risk the doc-comment calls out.
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 7);
    let attacker_payer = Address::generate(&f.env);

    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);
    let second =
        f.contract.try_register_settlement(&pid, &attacker_payer, &f.seller, &key, &500);

    assert_eq!(second, Err(Ok(Error::SettlementAlreadyRegistered)));
    assert_eq!(f.contract.get_settlement(&pid).unwrap().payer, f.payer);
}

// ── register_settlement: amount validation ──────────────────────────────────

#[test]
fn register_settlement_rejects_a_zero_amount() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    let result =
        f.contract.try_register_settlement(&payment_id(&f.env, 8), &f.payer, &f.seller, &key, &0);

    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
    assert!(f.contract.get_settlement(&payment_id(&f.env, 8)).is_none());
}

#[test]
fn register_settlement_rejects_a_negative_amount() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    let result = f.contract.try_register_settlement(
        &payment_id(&f.env, 9),
        &f.payer,
        &f.seller,
        &key,
        &-1,
    );

    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

// ── deposit: happy path, fresh listing ──────────────────────────────────────

#[test]
fn deposit_creates_a_fresh_listing() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    let new_balance = f.contract.deposit(&f.seller, &key, &f.token, &10_000);

    assert_eq!(new_balance, 10_000);
    let listing = f.contract.get_listing(&key).unwrap();
    assert_eq!(listing.seller, f.seller);
    assert_eq!(listing.token, f.token);
    assert_eq!(listing.bond_amount, 10_000);
    assert_eq!(listing.last_claim_window_end, 0, "a deposit alone opens no claim window");
    assert_eq!(listing.open_dispute_count, 0);
}

#[test]
fn deposit_actually_moves_tokens_into_the_contract() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let token_client = soroban_sdk::token::TokenClient::new(&f.env, &f.token);

    f.contract.deposit(&f.seller, &key, &f.token, &10_000);

    assert_eq!(token_client.balance(&f.seller), 990_000);
    assert_eq!(token_client.balance(&f.contract.address), 10_000);
}

#[test]
fn deposit_before_any_registration_succeeds() {
    // A seller may bond a listing before it ever transacts (Section 2: bonding happens once
    // ownership is verified, independent of settlement history).
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/brand-new-listing");

    let balance = f.contract.deposit(&f.seller, &key, &f.token, &5_000);

    assert_eq!(balance, 5_000);
    assert!(f.contract.get_settlement(&payment_id(&f.env, 99)).is_none());
}

// ── deposit: top-up of an existing listing ──────────────────────────────────

#[test]
fn deposit_tops_up_an_existing_listing() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    let new_balance = f.contract.deposit(&f.seller, &key, &f.token, &2_500);

    assert_eq!(new_balance, 12_500);
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 12_500);
}

#[test]
fn topping_up_does_not_disturb_the_claim_window() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&payment_id(&f.env, 10), &f.payer, &f.seller, &key, &100);
    let window_after_settlement = f.contract.get_listing(&key).unwrap().last_claim_window_end;

    f.contract.deposit(&f.seller, &key, &f.token, &1_000);
    let window_after_deposit = f.contract.get_listing(&key).unwrap().last_claim_window_end;

    assert_eq!(
        window_after_settlement, window_after_deposit,
        "a deposit must not extend or reset an in-progress claim window"
    );
}

// ── deposit: validation ──────────────────────────────────────────────────────

#[test]
fn deposit_rejects_a_zero_amount() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    let result = f.contract.try_deposit(&f.seller, &key, &f.token, &0);

    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
    assert!(f.contract.get_listing(&key).is_none(), "a rejected deposit must not create a listing");
}

#[test]
fn deposit_rejects_a_negative_amount() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    let result = f.contract.try_deposit(&f.seller, &key, &f.token, &-500);

    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn deposit_rejects_below_the_dust_floor() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    // Only meaningful once the placeholder floor is raised above 1 in a later pass, but exercises
    // the actual comparison rather than assuming it.
    let below_floor = PLACEHOLDER_DUST_FLOOR - 1;
    if below_floor > 0 {
        let result = f.contract.try_deposit(&f.seller, &key, &f.token, &below_floor);
        assert_eq!(result, Err(Ok(Error::BelowDustFloor)));
    }
}

#[test]
fn deposit_at_exactly_the_dust_floor_succeeds() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    let balance = f.contract.deposit(&f.seller, &key, &f.token, &PLACEHOLDER_DUST_FLOOR);

    assert_eq!(balance, PLACEHOLDER_DUST_FLOOR);
}

#[test]
fn deposit_rejects_a_mismatched_token_on_top_up() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let other_token_admin = Address::generate(&f.env);
    let other_sac = f.env.register_stellar_asset_contract_v2(other_token_admin);
    let other_token = other_sac.address();
    StellarAssetClient::new(&f.env, &other_token).mint(&f.seller, &1_000_000);

    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    let result = f.contract.try_deposit(&f.seller, &key, &other_token, &1_000);

    assert_eq!(result, Err(Ok(Error::TokenMismatch)));
    // The original bond, in the original token, must be untouched.
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 10_000);
    assert_eq!(f.contract.get_listing(&key).unwrap().token, f.token);
}

#[test]
fn deposit_rejects_a_mismatched_seller_on_top_up() {
    // A second address attempting to "top up" someone else's listing must not be allowed to
    // attach its own funds to another seller's bond — ownership of a listing's bond is fixed at
    // creation.
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let impostor = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&impostor, &1_000_000);

    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    let result = f.contract.try_deposit(&impostor, &key, &f.token, &1_000);

    assert_eq!(result, Err(Ok(Error::SellerMismatch)));
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 10_000);
    assert_eq!(f.contract.get_listing(&key).unwrap().seller, f.seller);
}

#[test]
#[should_panic]
fn deposit_fails_without_the_sellers_authorization() {
    // See `register_settlement_fails_without_admin_authorization` for why `set_auths(&[])` is
    // needed rather than simply omitting a mock call — `setup()`'s own `mock_all_auths()` is
    // sticky for the whole `Env` otherwise.
    let f = setup();
    f.env.set_auths(&[]);
    let key = resource_key(&f.env, "https://example.com/api/data");

    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
}

#[test]
#[should_panic]
fn deposit_fails_when_the_seller_lacks_sufficient_balance() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    // Seller was only minted 1_000_000; asking to move more must fail (the SEP-41 token contract
    // itself enforces this — the escrow contract has no override for it).
    f.contract.deposit(&f.seller, &key, &f.token, &10_000_000);
}

// ── deposit: resource-key hashing / isolation ───────────────────────────────

#[test]
fn deposits_under_different_resource_keys_are_isolated() {
    let f = setup();
    f.env.mock_all_auths();
    let key_a = resource_key(&f.env, "https://example.com/listing-a");
    let key_b = resource_key(&f.env, "https://example.com/listing-b");

    f.contract.deposit(&f.seller, &key_a, &f.token, &10_000);
    f.contract.deposit(&f.seller, &key_b, &f.token, &2_000);

    assert_eq!(f.contract.get_listing(&key_a).unwrap().bond_amount, 10_000);
    assert_eq!(f.contract.get_listing(&key_b).unwrap().bond_amount, 2_000);
}

#[test]
fn get_listing_is_none_for_an_unknown_resource_key() {
    let f = setup();
    let key = resource_key(&f.env, "https://example.com/never-touched");

    assert_eq!(f.contract.get_listing(&key), None);
}

// ── deposit: overflow / boundary ────────────────────────────────────────────

#[test]
#[should_panic]
fn deposit_that_would_overflow_bond_amount_panics_rather_than_wrapping() {
    // i128::MAX deposited twice must not silently wrap around; `checked_add` in `deposit` is
    // expected to panic (via `.expect(..)`) rather than let the balance wrap to a small or
    // negative number, which would be a far worse outcome for a contract holding real funds. The
    // token contract's own balance accounting would in practice reject moving this much value
    // long before the escrow's internal add could wrap, but this test exercises the escrow's own
    // arithmetic guard directly rather than relying on the token contract to save it, matching
    // `overflow-checks = true` being load-bearing rather than decorative in this crate's release
    // profile.
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    StellarAssetClient::new(&f.env, &f.token).mint(&f.seller, &i128::MAX);

    f.contract.deposit(&f.seller, &key, &f.token, &(i128::MAX / 2 + 1));
    f.contract.deposit(&f.seller, &key, &f.token, &(i128::MAX / 2 + 1));
}

// ── settlement + deposit interplay ──────────────────────────────────────────

#[test]
fn a_settlement_can_be_registered_for_a_listing_with_multiple_deposits() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    f.contract.deposit(&f.seller, &key, &f.token, &1_000);
    f.contract.deposit(&f.seller, &key, &f.token, &500);
    f.contract.register_settlement(&payment_id(&f.env, 11), &f.payer, &f.seller, &key, &50);

    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 1_500);
    assert!(f.contract.get_settlement(&payment_id(&f.env, 11)).is_some());
}

#[test]
fn get_settlement_is_none_for_an_unregistered_payment_id() {
    let f = setup();
    assert_eq!(f.contract.get_settlement(&payment_id(&f.env, 250)), None);
}

// ── withdraw: happy path ─────────────────────────────────────────────────────

#[test]
fn withdraw_after_the_window_closes_returns_the_full_bond() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let token_client = soroban_sdk::token::TokenClient::new(&f.env, &f.token);

    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&payment_id(&f.env, 12), &f.payer, &f.seller, &key, &500);
    let window_end = f.contract.get_listing(&key).unwrap().last_claim_window_end;
    f.env.ledger().set_timestamp(window_end);

    let withdrawn = f.contract.withdraw(&f.seller, &key);

    assert_eq!(withdrawn, 10_000);
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 0);
    assert_eq!(token_client.balance(&f.seller), 1_000_000, "full balance returned to seller");
    assert_eq!(token_client.balance(&f.contract.address), 0);
}

#[test]
fn withdraw_succeeds_immediately_for_a_bond_with_no_settlements_ever_registered() {
    // last_claim_window_end == 0 for a never-settled listing, which is always <= now.
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/never-settled");

    f.contract.deposit(&f.seller, &key, &f.token, &3_000);
    let withdrawn = f.contract.withdraw(&f.seller, &key);

    assert_eq!(withdrawn, 3_000);
}

#[test]
fn withdraw_zeroes_the_listings_bond_amount_but_leaves_the_listing_queryable() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    f.contract.deposit(&f.seller, &key, &f.token, &4_000);
    f.contract.withdraw(&f.seller, &key);

    let listing = f.contract.get_listing(&key).expect("listing record should survive withdrawal");
    assert_eq!(listing.bond_amount, 0);
    assert_eq!(listing.seller, f.seller);
    assert_eq!(listing.token, f.token);
}

// ── withdraw: window gate ────────────────────────────────────────────────────

#[test]
fn withdraw_before_the_window_closes_is_rejected() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&payment_id(&f.env, 13), &f.payer, &f.seller, &key, &500);
    let window_end = f.contract.get_listing(&key).unwrap().last_claim_window_end;
    f.env.ledger().set_timestamp(window_end - 1);

    let result = f.contract.try_withdraw(&f.seller, &key);

    assert_eq!(result, Err(Ok(Error::ClaimWindowStillOpen)));
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 10_000, "funds must stay put");
}

#[test]
fn withdraw_at_exactly_the_window_boundary_succeeds() {
    // Boundary math: `now >= last_claim_window_end` is inclusive of the exact instant, matching
    // the design doc's "now >= lastClaimWindowEnd" phrasing precisely, not "now > ...".
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&payment_id(&f.env, 14), &f.payer, &f.seller, &key, &500);
    let window_end = f.contract.get_listing(&key).unwrap().last_claim_window_end;

    f.env.ledger().set_timestamp(window_end - 1);
    assert_eq!(f.contract.try_withdraw(&f.seller, &key), Err(Ok(Error::ClaimWindowStillOpen)));

    f.env.ledger().set_timestamp(window_end);
    let withdrawn = f.contract.withdraw(&f.seller, &key);
    assert_eq!(withdrawn, 10_000);
}

// ── withdraw: dispute gate ───────────────────────────────────────────────────

#[test]
fn withdraw_while_a_dispute_is_open_is_rejected_even_after_the_window_closes() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 15);

    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);
    let window_end = f.contract.get_listing(&key).unwrap().last_claim_window_end;
    f.contract.file_dispute(&f.payer, &pid);

    // Window has fully elapsed — the ONLY thing blocking withdrawal now is the open dispute.
    f.env.ledger().set_timestamp(window_end + 1_000);

    let result = f.contract.try_withdraw(&f.seller, &key);

    assert_eq!(result, Err(Ok(Error::DisputeOpen)));
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 10_000);
}

// ── withdraw: non-seller caller ──────────────────────────────────────────────

#[test]
#[should_panic]
fn withdraw_fails_without_the_sellers_authorization() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);

    f.env.set_auths(&[]);
    f.contract.withdraw(&f.seller, &key);
}

#[test]
fn withdraw_by_a_non_seller_caller_is_rejected() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let impostor = Address::generate(&f.env);

    f.contract.deposit(&f.seller, &key, &f.token, &10_000);

    let result = f.contract.try_withdraw(&impostor, &key);

    assert_eq!(result, Err(Ok(Error::SellerMismatch)));
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 10_000);
}

// ── withdraw: nonexistent listing ────────────────────────────────────────────

#[test]
fn withdraw_from_a_nonexistent_listing_is_rejected() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/never-deposited");

    let result = f.contract.try_withdraw(&f.seller, &key);

    assert_eq!(result, Err(Ok(Error::ListingNotFound)));
}

// ── withdraw: full-withdrawal-only shape ─────────────────────────────────────

#[test]
fn withdraw_takes_no_amount_parameter_and_always_drains_the_full_bond() {
    // Documents and exercises the "full withdrawal only" design choice (see `withdraw`'s
    // doc-comment): a single successful call always empties bond_amount to 0, regardless of how
    // large the bond was.
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    f.contract.deposit(&f.seller, &key, &f.token, &1_000);
    f.contract.deposit(&f.seller, &key, &f.token, &4_000); // top-ups accumulate to 5_000 total

    let withdrawn = f.contract.withdraw(&f.seller, &key);

    assert_eq!(withdrawn, 5_000, "the ENTIRE accumulated bond is withdrawn in one call");
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 0);
}

#[test]
fn withdraw_on_an_already_empty_bond_is_rejected_rather_than_a_silent_no_op() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.withdraw(&f.seller, &key); // first withdrawal drains it to 0

    let result = f.contract.try_withdraw(&f.seller, &key);

    assert_eq!(result, Err(Ok(Error::NothingToWithdraw)));
}

#[test]
fn seller_can_redeposit_after_a_full_withdrawal() {
    // The full-withdrawal-only design's stated escape hatch: a seller wanting a smaller bond can
    // withdraw everything and deposit a smaller amount back, rather than needing a partial
    // withdrawal primitive.
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");

    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.withdraw(&f.seller, &key);
    let new_balance = f.contract.deposit(&f.seller, &key, &f.token, &2_000);

    assert_eq!(new_balance, 2_000);
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 2_000);
}

// ── file_dispute: happy path ──────────────────────────────────────────────────

#[test]
fn files_a_dispute_by_the_correct_payer() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 16);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);

    f.contract.file_dispute(&f.payer, &pid);

    let dispute = f.contract.get_dispute(&pid).expect("dispute should be recorded");
    assert_eq!(dispute.filed_by, f.payer);
    assert_eq!(dispute.filed_at, f.env.ledger().timestamp());
    assert_eq!(f.contract.get_listing(&key).unwrap().open_dispute_count, 1);
}

#[test]
fn filing_a_dispute_does_not_touch_the_bond_amount() {
    // Section 3/6: filing only opens a dispute; slashing logic is out of scope for this pass.
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 17);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);

    f.contract.file_dispute(&f.payer, &pid);

    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 10_000);
}

// ── file_dispute: the claim-filing window (SettlementRecord.claim_deadline) ──────────────
//
// Regression coverage for the review finding that file_dispute never enforced a claim-filing
// window at all: PLACEHOLDER_DISPUTE_WINDOW_SECONDS was documented as bounding "how long after
// a settlement a payer may still file a dispute," but the only code path that ever read it
// advanced Listing.last_claim_window_end, which gates withdraw, not file_dispute. These two
// tests hit the corrected boundary from both directions, the same discipline this file already
// applies to the rate-limiter and response-window boundaries.

#[test]
fn filing_a_dispute_exactly_at_the_claim_deadline_succeeds() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 90);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);

    let registered_at = f.env.ledger().timestamp();
    let settlement = f.contract.get_settlement(&pid).unwrap();
    assert_eq!(
        settlement.claim_deadline,
        registered_at + PLACEHOLDER_DISPUTE_WINDOW_SECONDS,
        "claim_deadline must be snapshotted at registration time, not left at zero"
    );

    // Advance to exactly the deadline — not one second short, not one second past.
    f.env
        .ledger()
        .set_timestamp(registered_at + PLACEHOLDER_DISPUTE_WINDOW_SECONDS);

    f.contract.file_dispute(&f.payer, &pid);

    assert!(
        f.contract.get_dispute(&pid).is_some(),
        "filing exactly at claim_deadline must succeed — the window is inclusive at its end"
    );
}

#[test]
fn filing_a_dispute_one_ledger_after_the_claim_deadline_is_rejected() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 91);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);

    let registered_at = f.env.ledger().timestamp();

    // One second past the deadline — the smallest possible step beyond it.
    f.env
        .ledger()
        .set_timestamp(registered_at + PLACEHOLDER_DISPUTE_WINDOW_SECONDS + 1);

    let result = f.contract.try_file_dispute(&f.payer, &pid);

    assert_eq!(
        result,
        Err(Ok(Error::ClaimWindowElapsed)),
        "filing one second past claim_deadline must be rejected"
    );
    assert!(
        f.contract.get_dispute(&pid).is_none(),
        "a rejected filing must not create a Dispute record"
    );
}

#[test]
fn filing_a_dispute_against_an_old_settlement_does_not_freeze_an_unrelated_later_bond() {
    // The concrete failure mode the review finding described: a seller withdraws legitimately
    // after an old, never-disputed settlement's window closes, then deposits fresh capital for
    // unrelated future business. Confirms the old settlement can no longer be disputed at all
    // once its own claim_deadline has passed, regardless of what the listing's CURRENT
    // last_claim_window_end says (which later, unrelated settlements may have since advanced).
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let old_pid = payment_id(&f.env, 92);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&old_pid, &f.payer, &f.seller, &key, &500);
    let old_registered_at = f.env.ledger().timestamp();

    // The old settlement's window closes with no dispute ever filed; the seller withdraws.
    f.env
        .ledger()
        .set_timestamp(old_registered_at + PLACEHOLDER_DISPUTE_WINDOW_SECONDS);
    f.contract.withdraw(&f.seller, &key);
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 0);

    // Much later, the seller deposits fresh capital and registers an unrelated new settlement —
    // which, under the OLD (buggy) behavior, would have kept extending the shared
    // last_claim_window_end that a live read might have mistakenly consulted.
    f.env.ledger().set_timestamp(old_registered_at + 50_000_000);
    f.contract.deposit(&f.seller, &key, &f.token, &7_000);
    let new_pid = payment_id(&f.env, 93);
    f.contract.register_settlement(&new_pid, &f.payer, &f.seller, &key, &300);

    // The original payer, showing up long after the fact, can no longer dispute the OLD
    // settlement — its own snapshotted deadline closed long ago, independent of the listing's
    // freshly-advanced last_claim_window_end.
    let old_claim_attempt = f.contract.try_file_dispute(&f.payer, &old_pid);
    assert_eq!(old_claim_attempt, Err(Ok(Error::ClaimWindowElapsed)));

    // The NEW settlement, by contrast, is well within its own fresh window.
    f.contract.file_dispute(&f.payer, &new_pid);
    assert!(f.contract.get_dispute(&new_pid).is_some());
}

// ── file_dispute: standing ────────────────────────────────────────────────────

#[test]
fn filing_by_someone_who_is_not_the_recorded_payer_is_rejected() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 18);
    let impostor = Address::generate(&f.env);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);

    let result = f.contract.try_file_dispute(&impostor, &pid);

    assert_eq!(result, Err(Ok(Error::NotThePayer)));
    assert_eq!(f.contract.get_dispute(&pid), None);
    assert_eq!(f.contract.get_listing(&key).unwrap().open_dispute_count, 0);
}

#[test]
#[should_panic]
fn filing_a_dispute_fails_without_the_payers_authorization() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 19);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);

    f.env.set_auths(&[]);
    f.contract.file_dispute(&f.payer, &pid);
}

// ── file_dispute: unregistered / missing listing ──────────────────────────────

#[test]
fn filing_against_an_unregistered_payment_id_is_rejected() {
    let f = setup();
    f.env.mock_all_auths();
    let pid = payment_id(&f.env, 20);

    let result = f.contract.try_file_dispute(&f.payer, &pid);

    assert_eq!(result, Err(Ok(Error::SettlementNotFound)));
}

#[test]
fn filing_against_a_settlement_whose_listing_was_never_bonded_is_rejected() {
    // Mirrors register_settlement's "verified-but-unbonded listing" case: the settlement is real
    // and standing checks out, but there is no bond to hold a dispute against.
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/never-bonded");
    let pid = payment_id(&f.env, 21);
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);

    let result = f.contract.try_file_dispute(&f.payer, &pid);

    assert_eq!(result, Err(Ok(Error::ListingNotFound)));
}

// ── file_dispute: duplicate open dispute ──────────────────────────────────────

#[test]
fn filing_a_second_dispute_against_an_already_open_one_is_rejected() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 22);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);

    f.contract.file_dispute(&f.payer, &pid);
    let second = f.contract.try_file_dispute(&f.payer, &pid);

    assert_eq!(second, Err(Ok(Error::DisputeAlreadyOpen)));
    // The count must not double-increment on a rejected second filing.
    assert_eq!(f.contract.get_listing(&key).unwrap().open_dispute_count, 1);
}

#[test]
fn a_rejected_duplicate_filing_does_not_overwrite_the_original_disputes_filed_at() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 23);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);

    f.contract.file_dispute(&f.payer, &pid);
    let original_filed_at = f.contract.get_dispute(&pid).unwrap().filed_at;

    f.env.ledger().set_timestamp(f.env.ledger().timestamp() + 500);
    let _ = f.contract.try_file_dispute(&f.payer, &pid);

    assert_eq!(f.contract.get_dispute(&pid).unwrap().filed_at, original_filed_at);
}

// ── file_dispute: rate limit boundary ─────────────────────────────────────────

#[test]
fn filing_up_to_the_rate_limit_within_the_window_succeeds() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    f.contract.deposit(&f.seller, &key, &f.token, &1_000_000);

    for i in 0..PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX {
        let pid = payment_id2(&f.env, 100, i as u8);
        f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &10);
        f.contract.file_dispute(&f.payer, &pid);
    }

    assert_eq!(
        f.contract.get_listing(&key).unwrap().open_dispute_count,
        PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX
    );
}

#[test]
fn filing_one_more_than_the_limit_within_the_window_is_rejected() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    f.contract.deposit(&f.seller, &key, &f.token, &1_000_000);

    for i in 0..PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX {
        let pid = payment_id2(&f.env, 101, i as u8);
        f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &10);
        f.contract.file_dispute(&f.payer, &pid);
    }

    let one_too_many_pid = payment_id2(&f.env, 101, PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX as u8);
    f.contract.register_settlement(&one_too_many_pid, &f.payer, &f.seller, &key, &10);
    let result = f.contract.try_file_dispute(&f.payer, &one_too_many_pid);

    assert_eq!(result, Err(Ok(Error::DisputeRateLimited)));
    // The rejected attempt must not have opened a dispute or bumped the listing's count.
    assert_eq!(f.contract.get_dispute(&one_too_many_pid), None);
    assert_eq!(
        f.contract.get_listing(&key).unwrap().open_dispute_count,
        PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX
    );
}

#[test]
fn filing_again_after_the_window_fully_elapses_succeeds() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    f.contract.deposit(&f.seller, &key, &f.token, &1_000_000);

    for i in 0..PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX {
        let pid = payment_id2(&f.env, 102, i as u8);
        f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &10);
        f.contract.file_dispute(&f.payer, &pid);
    }

    // Confirm the limit is actually binding right now, before advancing time.
    let still_blocked_pid = payment_id2(&f.env, 102, 250);
    f.contract.register_settlement(&still_blocked_pid, &f.payer, &f.seller, &key, &10);
    assert_eq!(
        f.contract.try_file_dispute(&f.payer, &still_blocked_pid),
        Err(Ok(Error::DisputeRateLimited))
    );

    // Advance past the entire rolling window — every prior filing should now be pruned.
    f.env
        .ledger()
        .set_timestamp(f.env.ledger().timestamp() + PLACEHOLDER_DISPUTE_RATE_LIMIT_WINDOW_SECONDS + 1);

    let after_window_pid = payment_id2(&f.env, 102, 251);
    f.contract.register_settlement(&after_window_pid, &f.payer, &f.seller, &key, &10);
    // This must succeed now that the whole prior window has elapsed and been pruned.
    f.contract.file_dispute(&f.payer, &after_window_pid);

    assert!(f.contract.get_dispute(&after_window_pid).is_some());
}

#[test]
fn the_rate_limit_boundary_is_exact_at_the_window_edge() {
    // Boundary-math test in the style of upto-stellar's `accepts_an_expiration_at_the_boundary`.
    //
    // Corrected convention: exclusive-at-start. An entry exactly `window_seconds` old
    // (age == window, i.e. `now - ts == window`) is PRUNED, not counted — the window is exactly
    // `window_seconds` wide, not `window_seconds + 1`. This test hits the boundary from both
    // directions explicitly: one second before the window elapses (still counted, still
    // rate-limited) and exactly at the window edge (pruned, no longer rate-limited) — not just
    // the "well after" case, so a regression back to inclusive-at-start (`ts >= window_start`)
    // fails here immediately rather than only showing up as an off-by-one in production.
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    f.contract.deposit(&f.seller, &key, &f.token, &1_000_000);

    let start = f.env.ledger().timestamp();

    // File exactly at the limit at `start`.
    for i in 0..PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX {
        let pid = payment_id2(&f.env, 103, i as u8);
        f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &10);
        f.contract.file_dispute(&f.payer, &pid);
    }

    // Direction 1 — one second before the window elapses (age = window - 1): the oldest
    // filing is still within the window, so the limit is still binding.
    f.env
        .ledger()
        .set_timestamp(start + PLACEHOLDER_DISPUTE_RATE_LIMIT_WINDOW_SECONDS - 1);
    let still_within_pid = payment_id2(&f.env, 103, 240);
    f.contract.register_settlement(&still_within_pid, &f.payer, &f.seller, &key, &10);
    assert_eq!(
        f.contract.try_file_dispute(&f.payer, &still_within_pid),
        Err(Ok(Error::DisputeRateLimited)),
        "one second before the window elapses, the original filings must still count"
    );

    // Direction 2 — exactly at the window edge (age == window, to the second): the oldest
    // filing is now exactly `window_seconds` old and must be pruned immediately, not one
    // second later. This is the exact case the inclusive-at-start bug got wrong.
    f.env
        .ledger()
        .set_timestamp(start + PLACEHOLDER_DISPUTE_RATE_LIMIT_WINDOW_SECONDS);
    let at_boundary_pid = payment_id2(&f.env, 103, 241);
    f.contract.register_settlement(&at_boundary_pid, &f.payer, &f.seller, &key, &10);
    f.contract.file_dispute(&f.payer, &at_boundary_pid);
    assert!(
        f.contract.get_dispute(&at_boundary_pid).is_some(),
        "at exactly `window_seconds` old, the oldest filing must already be pruned — the window is `window_seconds` wide, not `window_seconds + 1`"
    );
}

#[test]
fn the_rate_limit_is_per_payer_not_per_listing() {
    // A griefer cannot route around the limit by spreading filings across many listings — the
    // limiter keys on payer alone (see `file_dispute`'s doc-comment).
    let f = setup();
    f.env.mock_all_auths();
    let key_a = resource_key(&f.env, "https://example.com/listing-a");
    let key_b = resource_key(&f.env, "https://example.com/listing-b");
    f.contract.deposit(&f.seller, &key_a, &f.token, &400_000);
    f.contract.deposit(&f.seller, &key_b, &f.token, &400_000);

    let mut filed = 0u32;
    for i in 0..PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX {
        let key = if i % 2 == 0 { &key_a } else { &key_b };
        let pid = payment_id2(&f.env, 104, i as u8);
        f.contract.register_settlement(&pid, &f.payer, &f.seller, key, &10);
        f.contract.file_dispute(&f.payer, &pid);
        filed += 1;
    }
    assert_eq!(filed, PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX);

    let one_more_pid = payment_id2(&f.env, 104, PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX as u8);
    f.contract.register_settlement(&one_more_pid, &f.payer, &f.seller, &key_a, &10);
    let result = f.contract.try_file_dispute(&f.payer, &one_more_pid);

    assert_eq!(result, Err(Ok(Error::DisputeRateLimited)));
}

#[test]
fn the_rate_limit_does_not_apply_across_different_payers() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    f.contract.deposit(&f.seller, &key, &f.token, &1_000_000);
    let other_payer = Address::generate(&f.env);

    for i in 0..PLACEHOLDER_DISPUTE_RATE_LIMIT_MAX {
        let pid = payment_id2(&f.env, 105, i as u8);
        f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &10);
        f.contract.file_dispute(&f.payer, &pid);
    }

    // A different payer, disputing a different settlement, must not be affected by the first
    // payer's exhausted limit.
    let other_pid = payment_id2(&f.env, 105, 200);
    f.contract.register_settlement(&other_pid, &other_payer, &f.seller, &key, &10);
    f.contract.file_dispute(&other_payer, &other_pid);

    assert!(f.contract.get_dispute(&other_pid).is_some());
}

// ── get_dispute ────────────────────────────────────────────────────────────

#[test]
fn get_dispute_is_none_for_an_unfiled_payment_id() {
    let f = setup();
    assert_eq!(f.contract.get_dispute(&payment_id(&f.env, 251)), None);
}

// ── set_delivery_key ─────────────────────────────────────────────────────────

#[test]
fn sets_a_delivery_key_on_a_bonded_listing() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    let signing_key = generate_keypair();
    let pubkey = pubkey_bytes(&f.env, &signing_key);

    f.contract.set_delivery_key(&f.seller, &key, &pubkey);

    assert_eq!(f.contract.get_listing(&key).unwrap().delivery_pubkey, Some(pubkey));
}

#[test]
fn rotating_the_delivery_key_overwrites_the_previous_one() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    let old_key = generate_keypair();
    let new_key = generate_keypair();

    f.contract.set_delivery_key(&f.seller, &key, &pubkey_bytes(&f.env, &old_key));
    f.contract.set_delivery_key(&f.seller, &key, &pubkey_bytes(&f.env, &new_key));

    assert_eq!(
        f.contract.get_listing(&key).unwrap().delivery_pubkey,
        Some(pubkey_bytes(&f.env, &new_key))
    );
}

#[test]
fn set_delivery_key_on_a_nonexistent_listing_is_rejected() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/never-deposited");
    let signing_key = generate_keypair();

    let result =
        f.contract.try_set_delivery_key(&f.seller, &key, &pubkey_bytes(&f.env, &signing_key));

    assert_eq!(result, Err(Ok(Error::ListingNotFound)));
}

#[test]
fn set_delivery_key_by_a_non_seller_caller_is_rejected() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    let impostor = Address::generate(&f.env);
    let signing_key = generate_keypair();

    let result = f.contract.try_set_delivery_key(
        &impostor,
        &key,
        &pubkey_bytes(&f.env, &signing_key),
    );

    assert_eq!(result, Err(Ok(Error::NotTheSeller)));
    assert_eq!(f.contract.get_listing(&key).unwrap().delivery_pubkey, None);
}

#[test]
#[should_panic]
fn set_delivery_key_fails_without_the_sellers_authorization() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    let signing_key = generate_keypair();

    f.env.set_auths(&[]);
    f.contract.set_delivery_key(&f.seller, &key, &pubkey_bytes(&f.env, &signing_key));
}

#[test]
fn a_dispute_filed_after_a_key_rotation_is_verified_against_the_current_key() {
    // Decided and documented in lib.rs's module doc-comment ("Gap 1"): post_receipt always
    // verifies against whatever delivery_pubkey holds AT THE MOMENT post_receipt is called, not a
    // key snapshotted at file_dispute (or receipt-signing) time. This test signs a receipt with a
    // BRAND NEW key that is set only AFTER the dispute was already filed under the old key, and
    // confirms it verifies successfully — "current" means "current at post_receipt time."
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 40);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    let old_key = generate_keypair();
    f.contract.set_delivery_key(&f.seller, &key, &pubkey_bytes(&f.env, &old_key));
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);
    f.contract.file_dispute(&f.payer, &pid);

    // Rotate to a NEW key after filing, and sign the receipt with the new key.
    let new_key = generate_keypair();
    f.contract.set_delivery_key(&f.seller, &key, &pubkey_bytes(&f.env, &new_key));
    let rhash = response_hash(&f.env, 1);
    let ts = f.env.ledger().timestamp();
    let sig = sign_receipt(&f.env, &new_key, &pid, &rhash, ts);

    f.contract.post_receipt(&pid, &rhash, &ts, &sig);

    assert_eq!(f.contract.get_dispute(&pid), None, "the new key's signature must defeat the dispute");
}

#[test]
#[should_panic]
fn a_receipt_signed_with_a_rotated_out_key_no_longer_verifies() {
    // The mirror of the above: a receipt signed under the OLD key, after rotating to a new one,
    // must fail — "current" is evaluated at post_receipt call time, so the old key is no longer
    // trusted even though it was valid when the dispute was filed.
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 41);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    let old_key = generate_keypair();
    f.contract.set_delivery_key(&f.seller, &key, &pubkey_bytes(&f.env, &old_key));
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);
    f.contract.file_dispute(&f.payer, &pid);
    let rhash = response_hash(&f.env, 1);
    let ts = f.env.ledger().timestamp();
    let sig_under_old_key = sign_receipt(&f.env, &old_key, &pid, &rhash, ts);

    // Rotate AFTER signing but BEFORE posting.
    let new_key = generate_keypair();
    f.contract.set_delivery_key(&f.seller, &key, &pubkey_bytes(&f.env, &new_key));

    f.contract.post_receipt(&pid, &rhash, &ts, &sig_under_old_key);
}

// ── post_receipt: the five required adversarial cases ────────────────────────
//
// Helper that sets up a bonded, keyed, disputed settlement ready for a receipt, returning
// everything a test needs to build/tamper a receipt against it.
struct DisputedFixture<'a> {
    f: Fixture<'a>,
    key: Bytes,
    pid: BytesN<32>,
    signing_key: SigningKey,
    response_hash: BytesN<32>,
    timestamp: u64,
}

fn setup_disputed(pid_byte: u8) -> DisputedFixture<'static> {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, pid_byte);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    let signing_key = generate_keypair();
    f.contract.set_delivery_key(&f.seller, &key, &pubkey_bytes(&f.env, &signing_key));
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);
    f.contract.file_dispute(&f.payer, &pid);
    let response_hash = response_hash(&f.env, 7);
    let timestamp = f.env.ledger().timestamp();
    DisputedFixture { f, key, pid, signing_key, response_hash, timestamp }
}

// Case 5 (positive control, checked first so the four rejections below are meaningful): a
// genuinely valid receipt succeeds.
#[test]
fn post_receipt_case_5_a_genuinely_valid_receipt_succeeds() {
    let d = setup_disputed(50);
    let sig = sign_receipt(&d.f.env, &d.signing_key, &d.pid, &d.response_hash, d.timestamp);

    d.f.contract.post_receipt(&d.pid, &d.response_hash, &d.timestamp, &sig);

    assert_eq!(d.f.contract.get_dispute(&d.pid), None, "a valid receipt must close the dispute");
    assert_eq!(
        d.f.contract.get_listing(&d.key).unwrap().open_dispute_count,
        0,
        "the listing's open count must be decremented"
    );
    // No fund movement on a defeated dispute.
    assert_eq!(d.f.contract.get_listing(&d.key).unwrap().bond_amount, 10_000);
}

// Case 1: a tampered receipt — take a genuinely valid signature and flip a bit in the signed
// message (change one byte of response_hash) before verification. Must be rejected.
#[test]
#[should_panic]
fn post_receipt_case_1_a_tampered_receipt_is_rejected() {
    let d = setup_disputed(51);
    let sig = sign_receipt(&d.f.env, &d.signing_key, &d.pid, &d.response_hash, d.timestamp);

    // Flip one byte of response_hash AFTER signing — the signature was valid for the original
    // message, but the message submitted to post_receipt no longer matches it.
    let mut tampered_bytes = d.response_hash.to_array();
    tampered_bytes[0] ^= 0xFF;
    let tampered_hash = BytesN::from_array(&d.f.env, &tampered_bytes);

    d.f.contract.post_receipt(&d.pid, &tampered_hash, &d.timestamp, &sig);
}

// Case 2: a receipt signed by the wrong key — sign with a different Ed25519 keypair than the one
// registered for that listing. Must be rejected.
#[test]
#[should_panic]
fn post_receipt_case_2_a_receipt_signed_by_the_wrong_key_is_rejected() {
    let d = setup_disputed(52);
    let wrong_key = generate_keypair();
    let sig = sign_receipt(&d.f.env, &wrong_key, &d.pid, &d.response_hash, d.timestamp);

    d.f.contract.post_receipt(&d.pid, &d.response_hash, &d.timestamp, &sig);
}

// Case 3: a receipt for a different payment_id than the one it's being submitted against — sign
// a valid receipt for payment A, then call post_receipt claiming it's for payment B's dispute.
// Must be rejected.
#[test]
#[should_panic]
fn post_receipt_case_3_a_receipt_for_a_different_payment_id_is_rejected() {
    let d = setup_disputed(53);
    // A second, independently disputed payment_id ("payment B") under the SAME listing/key, so
    // the only variable is which payment_id the signature actually commits to.
    let pid_b = payment_id(&d.f.env, 153);
    d.f.contract.register_settlement(&pid_b, &d.f.payer, &d.f.seller, &d.key, &500);
    d.f.contract.file_dispute(&d.f.payer, &pid_b);

    // Sign a valid receipt for payment A (`d.pid`)...
    let sig_for_a = sign_receipt(&d.f.env, &d.signing_key, &d.pid, &d.response_hash, d.timestamp);

    // ...but submit it against payment B's dispute.
    d.f.contract.post_receipt(&pid_b, &d.response_hash, &d.timestamp, &sig_for_a);
}

// Case 4: a replay of a receipt already posted — post a valid receipt once (closing the
// dispute), then attempt to post the identical receipt again. Must be rejected (the dispute no
// longer exists to close — DisputeNotFound).
#[test]
fn post_receipt_case_4_a_replay_of_an_already_posted_receipt_is_rejected() {
    let d = setup_disputed(54);
    let sig = sign_receipt(&d.f.env, &d.signing_key, &d.pid, &d.response_hash, d.timestamp);
    d.f.contract.post_receipt(&d.pid, &d.response_hash, &d.timestamp, &sig);
    assert_eq!(d.f.contract.get_dispute(&d.pid), None, "first post must have closed the dispute");

    let replay = d.f.contract.try_post_receipt(&d.pid, &d.response_hash, &d.timestamp, &sig);

    assert_eq!(replay, Err(Ok(Error::DisputeNotFound)));
}

// ── post_receipt: no dispute exists at all ────────────────────────────────────

#[test]
fn post_receipt_against_a_payment_id_never_disputed_is_rejected_distinctly() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 55);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    let signing_key = generate_keypair();
    f.contract.set_delivery_key(&f.seller, &key, &pubkey_bytes(&f.env, &signing_key));
    // Note: no register_settlement, no file_dispute — pid was NEVER disputed.
    let rhash = response_hash(&f.env, 1);
    let ts = f.env.ledger().timestamp();
    let sig = sign_receipt(&f.env, &signing_key, &pid, &rhash, ts);

    let result = f.contract.try_post_receipt(&pid, &rhash, &ts, &sig);

    assert_eq!(result, Err(Ok(Error::DisputeNotFound)));
}

// ── post_receipt: no delivery key registered ──────────────────────────────────

#[test]
fn post_receipt_against_a_listing_with_no_delivery_key_registered_is_rejected() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    let pid = payment_id(&f.env, 56);
    f.contract.deposit(&f.seller, &key, &f.token, &10_000);
    // Deliberately no set_delivery_key call.
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);
    f.contract.file_dispute(&f.payer, &pid);
    let signing_key = generate_keypair();
    let rhash = response_hash(&f.env, 1);
    let ts = f.env.ledger().timestamp();
    let sig = sign_receipt(&f.env, &signing_key, &pid, &rhash, ts);

    let result = f.contract.try_post_receipt(&pid, &rhash, &ts, &sig);

    assert_eq!(result, Err(Ok(Error::NoDeliveryKeyRegistered)));
}

// ── post_receipt: response-window boundary, tested in both directions ────────

#[test]
fn post_receipt_succeeds_one_second_before_the_response_window_elapses() {
    let d = setup_disputed(60);
    f_advance_to(&d.f, d.timestamp + PLACEHOLDER_RESPONSE_WINDOW_SECONDS - 1);
    let sig = sign_receipt(&d.f.env, &d.signing_key, &d.pid, &d.response_hash, d.timestamp);

    d.f.contract.post_receipt(&d.pid, &d.response_hash, &d.timestamp, &sig);

    assert_eq!(d.f.contract.get_dispute(&d.pid), None);
}

#[test]
fn post_receipt_is_rejected_exactly_at_the_response_window_boundary() {
    // Exclusive-at-the-edge: at now == filed_at + WINDOW exactly, post_receipt must no longer
    // succeed — this is the instant finalize becomes eligible instead (see the two tests'
    // complementary boundary coverage together).
    let d = setup_disputed(61);
    f_advance_to(&d.f, d.timestamp + PLACEHOLDER_RESPONSE_WINDOW_SECONDS);
    let sig = sign_receipt(&d.f.env, &d.signing_key, &d.pid, &d.response_hash, d.timestamp);

    let result = d.f.contract.try_post_receipt(&d.pid, &d.response_hash, &d.timestamp, &sig);

    assert_eq!(result, Err(Ok(Error::ResponseWindowElapsed)));
}

#[test]
fn post_receipt_is_rejected_well_after_the_response_window_elapses() {
    let d = setup_disputed(62);
    f_advance_to(&d.f, d.timestamp + PLACEHOLDER_RESPONSE_WINDOW_SECONDS + 10_000);
    let sig = sign_receipt(&d.f.env, &d.signing_key, &d.pid, &d.response_hash, d.timestamp);

    let result = d.f.contract.try_post_receipt(&d.pid, &d.response_hash, &d.timestamp, &sig);

    assert_eq!(result, Err(Ok(Error::ResponseWindowElapsed)));
}

fn f_advance_to(f: &Fixture, ts: u64) {
    f.env.ledger().set_timestamp(ts);
}

// ── finalize: the four required cases ─────────────────────────────────────────

// Case 1: called before the response window has expired — must be rejected.
#[test]
fn finalize_case_1_called_before_the_response_window_elapses_is_rejected() {
    let d = setup_disputed(70);
    f_advance_to(&d.f, d.timestamp + PLACEHOLDER_RESPONSE_WINDOW_SECONDS - 1);

    let result = d.f.contract.try_finalize(&d.pid);

    assert_eq!(result, Err(Ok(Error::ResponseWindowStillOpen)));
    assert_eq!(d.f.contract.get_dispute(&d.pid).is_some(), true, "dispute must remain open");
    assert_eq!(d.f.contract.get_listing(&d.key).unwrap().bond_amount, 10_000, "no slash yet");
}

#[test]
fn finalize_succeeds_exactly_at_the_response_window_boundary() {
    // The exact complement of post_receipt's own boundary: finalize becomes eligible at the same
    // instant post_receipt stops being eligible.
    let d = setup_disputed(71);
    f_advance_to(&d.f, d.timestamp + PLACEHOLDER_RESPONSE_WINDOW_SECONDS);

    let slashed = d.f.contract.finalize(&d.pid);

    assert_eq!(slashed, 500, "slash_amount = min(settlement.amount, bond_amount) = min(500, 10_000)");
    assert_eq!(d.f.contract.get_dispute(&d.pid), None);
}

// Case 2: called against a payment_id whose dispute was already closed via post_receipt — must
// be rejected, not silently no-op and not re-slash.
#[test]
fn finalize_case_2_against_an_already_receipt_resolved_dispute_is_rejected() {
    let d = setup_disputed(72);
    let sig = sign_receipt(&d.f.env, &d.signing_key, &d.pid, &d.response_hash, d.timestamp);
    d.f.contract.post_receipt(&d.pid, &d.response_hash, &d.timestamp, &sig);
    f_advance_to(&d.f, d.timestamp + PLACEHOLDER_RESPONSE_WINDOW_SECONDS + 1);

    let result = d.f.contract.try_finalize(&d.pid);

    assert_eq!(result, Err(Ok(Error::DisputeNotFound)));
    // No slash must have occurred — the bond is fully intact.
    assert_eq!(d.f.contract.get_listing(&d.key).unwrap().bond_amount, 10_000);
}

#[test]
fn finalize_against_a_never_disputed_payment_id_is_rejected() {
    let f = setup();
    let pid = payment_id(&f.env, 73);

    let result = f.contract.try_finalize(&pid);

    assert_eq!(result, Err(Ok(Error::DisputeNotFound)));
}

#[test]
fn finalize_a_second_time_after_a_successful_slash_does_not_re_slash() {
    let d = setup_disputed(74);
    f_advance_to(&d.f, d.timestamp + PLACEHOLDER_RESPONSE_WINDOW_SECONDS);
    let first = d.f.contract.finalize(&d.pid);
    assert_eq!(first, 500);
    let balance_after_first = d.f.contract.get_listing(&d.key).unwrap().bond_amount;

    let second = d.f.contract.try_finalize(&d.pid);

    assert_eq!(second, Err(Ok(Error::DisputeNotFound)));
    assert_eq!(
        d.f.contract.get_listing(&d.key).unwrap().bond_amount,
        balance_after_first,
        "a rejected second finalize must not slash again"
    );
}

// Case 3: bond_amount insufficient to cover the full disputed settlement amount — must still
// succeed with a partial slash (min(settlement.amount, bond_amount)), leaving bond_amount at
// exactly zero, not negative.
#[test]
fn finalize_case_3_partial_slash_when_the_bond_is_insufficient() {
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    // A small bond: 300, less than the settlement amount we'll dispute (500).
    f.contract.deposit(&f.seller, &key, &f.token, &300);
    let signing_key = generate_keypair();
    f.contract.set_delivery_key(&f.seller, &key, &pubkey_bytes(&f.env, &signing_key));
    let pid = payment_id(&f.env, 75);
    f.contract.register_settlement(&pid, &f.payer, &f.seller, &key, &500);
    f.contract.file_dispute(&f.payer, &pid);
    let filed_at = f.env.ledger().timestamp();
    f.env.ledger().set_timestamp(filed_at + PLACEHOLDER_RESPONSE_WINDOW_SECONDS);

    let slashed = f.contract.finalize(&pid);

    assert_eq!(slashed, 300, "only the available 300 can be slashed, not the full 500 claimed");
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 0, "must land at exactly zero");
    assert_eq!(f.contract.get_dispute(&pid), None);
}

#[test]
fn finalize_case_3_drains_the_bond_via_a_prior_resolved_dispute_then_partially_slashes_a_second() {
    // Constructs a genuinely low-balance listing WITHIN the contract's own rules: file and
    // resolve one dispute via finalize (a full slash that drains most of the bond), then file a
    // second dispute for more than what remains, and confirm the second finalize takes only the
    // remainder and lands bond_amount at exactly zero.
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    f.contract.deposit(&f.seller, &key, &f.token, &1_000);
    let signing_key = generate_keypair();
    f.contract.set_delivery_key(&f.seller, &key, &pubkey_bytes(&f.env, &signing_key));

    // First dispute: settlement of 900, fully slashed via finalize (bond has enough: 1_000 >=
    // 900), leaving bond_amount = 100.
    let pid_1 = payment_id(&f.env, 76);
    f.contract.register_settlement(&pid_1, &f.payer, &f.seller, &key, &900);
    f.contract.file_dispute(&f.payer, &pid_1);
    let filed_at_1 = f.env.ledger().timestamp();
    f.env.ledger().set_timestamp(filed_at_1 + PLACEHOLDER_RESPONSE_WINDOW_SECONDS);
    let first_slash = f.contract.finalize(&pid_1);
    assert_eq!(first_slash, 900);
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 100, "drained to 100 remaining");

    // Second dispute: a DIFFERENT payer's settlement of 500 (avoids the first payer's rate
    // limit), against the now-thin 100 remaining bond.
    let other_payer = Address::generate(&f.env);
    let pid_2 = payment_id(&f.env, 77);
    f.contract.register_settlement(&pid_2, &other_payer, &f.seller, &key, &500);
    f.contract.file_dispute(&other_payer, &pid_2);
    let filed_at_2 = f.env.ledger().timestamp();
    f.env.ledger().set_timestamp(filed_at_2 + PLACEHOLDER_RESPONSE_WINDOW_SECONDS);

    let second_slash = f.contract.finalize(&pid_2);

    assert_eq!(second_slash, 100, "only the remaining 100 can be slashed, not the full 500 claimed");
    assert_eq!(
        f.contract.get_listing(&key).unwrap().bond_amount,
        0,
        "must land at exactly zero, never negative"
    );
}

#[test]
fn finalize_on_a_bond_already_at_zero_slashes_nothing_but_still_closes_the_dispute() {
    // Edge of the edge: bond_amount is already 0 by the time finalize runs (fully drained by a
    // prior resolved dispute). min(settlement.amount, 0) = 0 — the dispute still closes (the
    // seller genuinely never produced a receipt), but no transfer of 0 is meaningfully harmful,
    // and bond_amount stays at exactly 0.
    let f = setup();
    f.env.mock_all_auths();
    let key = resource_key(&f.env, "https://example.com/api/data");
    f.contract.deposit(&f.seller, &key, &f.token, &500);
    let signing_key = generate_keypair();
    f.contract.set_delivery_key(&f.seller, &key, &pubkey_bytes(&f.env, &signing_key));

    let pid_1 = payment_id(&f.env, 78);
    f.contract.register_settlement(&pid_1, &f.payer, &f.seller, &key, &500);
    f.contract.file_dispute(&f.payer, &pid_1);
    let filed_at_1 = f.env.ledger().timestamp();
    f.env.ledger().set_timestamp(filed_at_1 + PLACEHOLDER_RESPONSE_WINDOW_SECONDS);
    f.contract.finalize(&pid_1);
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 0);

    let other_payer = Address::generate(&f.env);
    let pid_2 = payment_id(&f.env, 79);
    f.contract.register_settlement(&pid_2, &other_payer, &f.seller, &key, &200);
    f.contract.file_dispute(&other_payer, &pid_2);
    let filed_at_2 = f.env.ledger().timestamp();
    f.env.ledger().set_timestamp(filed_at_2 + PLACEHOLDER_RESPONSE_WINDOW_SECONDS);

    let slashed = f.contract.finalize(&pid_2);

    assert_eq!(slashed, 0);
    assert_eq!(f.contract.get_listing(&key).unwrap().bond_amount, 0);
    assert_eq!(f.contract.get_dispute(&pid_2), None, "dispute still closes even with nothing to slash");
}

// Case 4: atomicity — token transfer and dispute-closing state write happen together, observed
// as one combined post-state.
#[test]
fn finalize_case_4_atomically_updates_state_and_transfers_funds_in_one_call() {
    let d = setup_disputed(80);
    let token_client = soroban_sdk::token::TokenClient::new(&d.f.env, &d.f.token);
    let payer_balance_before = token_client.balance(&d.f.payer);
    let contract_balance_before = token_client.balance(&d.f.contract.address);
    f_advance_to(&d.f, d.timestamp + PLACEHOLDER_RESPONSE_WINDOW_SECONDS);

    let slashed = d.f.contract.finalize(&d.pid);

    // All three post-conditions read from a SINGLE post-call state, not three separate
    // assumptions made at different points.
    assert_eq!(slashed, 500);
    let listing_after = d.f.contract.get_listing(&d.key).unwrap();
    let dispute_after = d.f.contract.get_dispute(&d.pid);
    let payer_balance_after = token_client.balance(&d.f.payer);
    let contract_balance_after = token_client.balance(&d.f.contract.address);

    assert_eq!(dispute_after, None, "dispute must be gone");
    assert_eq!(listing_after.bond_amount, 10_000 - 500, "bond reduced by exactly the slash amount");
    assert_eq!(listing_after.open_dispute_count, 0);
    assert_eq!(
        payer_balance_after,
        payer_balance_before + 500,
        "payer's balance increased by exactly the slash amount"
    );
    assert_eq!(
        contract_balance_after,
        contract_balance_before - 500,
        "contract's balance decreased by exactly the slash amount"
    );
}

// Happy path: response window fully elapsed, no receipt was ever posted, finalize executes the
// slash, dispute closes, funds move. (Largely covered by the atomicity test above and the
// boundary test, but stated as its own explicit "happy path" test per the task's requirement.)
#[test]
fn finalize_happy_path_slashes_and_closes_the_dispute_when_no_receipt_was_ever_posted() {
    let d = setup_disputed(81);
    f_advance_to(&d.f, d.timestamp + PLACEHOLDER_RESPONSE_WINDOW_SECONDS + 3_600);

    let slashed = d.f.contract.finalize(&d.pid);

    assert_eq!(slashed, 500);
    assert_eq!(d.f.contract.get_dispute(&d.pid), None);
    assert_eq!(d.f.contract.get_listing(&d.key).unwrap().bond_amount, 9_500);
}

// finalize is genuinely permissionless: callable by anyone, not accidentally gated to the payer,
// seller, or admin.
#[test]
fn finalize_is_callable_by_a_completely_unrelated_random_address() {
    let d = setup_disputed(82);
    f_advance_to(&d.f, d.timestamp + PLACEHOLDER_RESPONSE_WINDOW_SECONDS);
    let random_caller = Address::generate(&d.f.env);
    // Deliberately not used for anything except existing — finalize takes no `caller` parameter
    // at all, so this test's real assertion is simply that ANY invocation succeeds without any
    // authorization tied to `random_caller` ever having been mocked or required. Referencing the
    // address (rather than declaring it and never touching it) documents intent for a reader.
    let _ = &random_caller;
    d.f.env.set_auths(&[]); // no mocked authorizations at all for this call

    let slashed = d.f.contract.finalize(&d.pid);

    assert_eq!(slashed, 500, "finalize must succeed with zero authorization entries — no require_auth gate exists on the caller");
}

// ── finalize: nonexistent settlement/listing (defensive, not realistically reachable) ────────

#[test]
fn finalize_response_window_boundary_one_second_before_is_rejected() {
    let d = setup_disputed(83);
    f_advance_to(&d.f, d.timestamp + PLACEHOLDER_RESPONSE_WINDOW_SECONDS - 1);

    let result = d.f.contract.try_finalize(&d.pid);

    assert_eq!(result, Err(Ok(Error::ResponseWindowStillOpen)));
}
