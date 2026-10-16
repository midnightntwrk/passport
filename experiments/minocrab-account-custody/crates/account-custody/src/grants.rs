//! Scoped grants share the device and custody implementations.
use crate::auth::{Auth, F, Preimage, bytes_eq, next_counter};
use crate::{ACCOUNT, GrantRecord, GrantScope, Mutation, increment};
use minocrab::v3::Circuit3;
use minocrab::{Private, Public};
use minocrab_std::v3::*;

#[derive(CircuitArg)]
pub struct ScopeInput {
    pub unshielded: Bool,
    pub shielded: Bool,
    pub to_contract: Bool,
    pub read: Bool,
    pub color: B32<Private>,
    pub recipient_kind: Uint<8>,
    pub recipient: B32<Private>,
    pub max_coin_value: Uint<128>,
    pub per_call_cap: Uint<128>,
    pub cap: Uint<128>,
    pub expires_at: Uint<64>,
    pub rp_id_hash: B32<Private>,
    pub read_pk_hash: B32<Private>,
    pub window_len: Uint<64>,
    pub window_cap: Uint<128>,
    pub caller: Maybe<ContractAddress<Private>, Private>,
    pub salt: B32<Private>,
}

fn either(c: &mut Circuit3, a: F, b: F) -> F {
    let one = c.constant(1u64).private();
    c.cond_select(a, one, b)
}
fn implies(c: &mut Circuit3, a: F, b: F) {
    let one = c.constant(1u64).private();
    let good = c.cond_select(a, b, one);
    c.assert(good);
}
fn le(c: &mut Circuit3, a: F, b: F, bits: u32) -> F {
    let greater = c.less_than(b, a, bits);
    c.not(greater)
}

pub fn object(
    c: &mut Circuit3,
    salt: B32<Private>,
    color: B32<Private>,
    kind: Uint<8>,
    recipient: B32<Private>,
    max: Uint<128>,
) -> B32<Private> {
    Preimage::tag(c, "midnight:account:grant:obj:v1")
        .bytes(salt)
        .bytes(color)
        .uint(kind.field(), 1)
        .bytes(recipient)
        .uint(max.field(), 16)
        .hash(c)
}
pub fn spent(c: &mut Circuit3, salt: B32<Private>, value: F) -> B32<Private> {
    Preimage::tag(c, "midnight:account:grant:spent:v1")
        .bytes(salt)
        .uint(value, 16)
        .hash(c)
}
impl ScopeInput {
    pub fn digest(&self, c: &mut Circuit3) -> B32<Private> {
        let caller = caller_commit(
            c,
            self.salt,
            self.caller.is_some.field(),
            self.caller.value.bytes(),
        );
        Preimage::tag(c, "midnight:account:grant:scope:v2")
            .bytes(self.salt)
            .uint(self.unshielded.field(), 1)
            .uint(self.shielded.field(), 1)
            .uint(self.to_contract.field(), 1)
            .uint(self.read.field(), 1)
            .bytes(self.color)
            .uint(self.recipient_kind.field(), 1)
            .bytes(self.recipient)
            .uint(self.max_coin_value.field(), 16)
            .uint(self.per_call_cap.field(), 16)
            .uint(self.cap.field(), 16)
            .uint(self.expires_at.field(), 8)
            .bytes(self.rp_id_hash)
            .bytes(self.read_pk_hash)
            .uint(self.window_len.field(), 8)
            .uint(self.window_cap.field(), 16)
            .bytes(caller)
            .hash(c)
    }
}

pub fn issue(c: &mut Circuit3, id: B32<Private>, s: ScopeInput) {
    let id = id.disclose_as::<Mutation>(c);
    let known = ACCOUNT.grants.member(c, &id).stale(c);
    c.when(known.field(), |c| {
        let old = ACCOUNT.grants.lookup(c, &id).stale(c);
        let inactive = c.not(old.active.field()).private();
        let epoch = ACCOUNT.device_epoch.read(c).stale(c).field();
        let same_epoch = c.test_eq(old.epoch.field(), epoch);
        let stale_epoch = c.not(same_epoch).private();
        let generation = ACCOUNT.grant_generation.read(c).stale(c).field();
        let same_gen = c.test_eq(old.generation.field(), generation);
        let stale_gen = c.not(same_gen).private();
        let good = either(c, inactive, stale_epoch);
        let good = either(c, good, stale_gen);
        c.assert(good);
    });
    let shielded = either(c, s.shielded.field(), s.to_contract.field());
    let spend = either(c, s.unshielded.field(), shielded);
    let nonempty = either(c, spend, s.read.field());
    c.assert(nonempty);
    let unrestricted = c.not(s.caller.is_some.field());
    let valid_caller_scope = either(c, spend, unrestricted);
    c.assert(valid_caller_scope);
    implies(c, shielded, s.read.field());
    let cap_valid = le(c, s.per_call_cap.field(), s.cap.field(), 128);
    c.assert(cap_valid);
    let zero = c.constant(0u64).private();
    let positive_cap = c.less_than(zero, s.cap.field(), 128);
    implies(c, spend, positive_cap);
    let coin_bound = le(c, s.per_call_cap.field(), s.max_coin_value.field(), 128);
    implies(c, spend, coin_bound);
    let empty = B32::pad(c, "").private();
    let zero_key = bytes_eq(c, s.read_pk_hash, empty);
    let nonzero_key = c.not(zero_key);
    implies(c, s.read.field(), nonzero_key);
    c.assert_eq(s.window_len.field(), zero);
    c.assert_eq(s.window_cap.field(), zero);
    let no_spend = c.not(spend);
    for valid in [bytes_eq(c, s.color, empty), bytes_eq(c, s.recipient, empty)] {
        implies(c, no_spend, valid);
    }
    for value in [
        s.recipient_kind.field(),
        s.max_coin_value.field(),
        s.per_call_cap.field(),
        s.cap.field(),
    ] {
        let valid = c.test_eq(value, zero);
        implies(c, no_spend, valid);
    }
    let epoch = ACCOUNT.device_epoch.read(c).stale(c);
    let generation = ACCOUNT.grant_generation.read(c).stale(c);
    let issued_at = ACCOUNT.auth_nonce.read(c).stale(c);
    let spent_commit = spent(c, s.salt, zero).disclose_as::<Mutation>(c);
    let object_commit = object(
        c,
        s.salt,
        s.color,
        s.recipient_kind,
        s.recipient,
        s.max_coin_value,
    )
    .disclose_as::<Mutation>(c);
    let rp_commit = Preimage::tag(c, "midnight:account:grant:rp:v1")
        .bytes(s.salt)
        .bytes(s.rp_id_hash)
        .hash(c)
        .disclose_as::<Mutation>(c);
    let caller_commit = caller_commit(c, s.salt, s.caller.is_some.field(), s.caller.value.bytes())
        .disclose_as::<Mutation>(c);
    let zero = c.constant(0u64);
    let one = c.constant(1u64);
    let record = GrantRecord {
        epoch,
        generation,
        issued_at,
        nonce: Uint::from_field_unchecked(zero),
        spent_commit,
        window_start: Uint::from_field_unchecked(zero),
        window_spent: Uint::from_field_unchecked(zero),
        active: Bool::from_field_unchecked(one),
        scope: GrantScope {
            op_withdraw_unshielded: s.unshielded.disclose_as::<Mutation>(c),
            op_withdraw_shielded: s.shielded.disclose_as::<Mutation>(c),
            op_withdraw_shielded_to_contract: s.to_contract.disclose_as::<Mutation>(c),
            read: s.read.disclose_as::<Mutation>(c),
            object_commit,
            per_call_cap: s.per_call_cap.disclose_as::<Mutation>(c),
            cap: s.cap.disclose_as::<Mutation>(c),
            expires_at: s.expires_at.disclose_as::<Mutation>(c),
            rp_commit,
            read_pk_hash: s.read_pk_hash.disclose_as::<Mutation>(c),
            window_len: Uint::from_field_unchecked(zero),
            window_cap: Uint::from_field_unchecked(zero),
            caller_commit,
        },
    };
    ACCOUNT.grants.insert(c, &id, &record);
}

pub fn revoke(c: &mut Circuit3, id: B32<Private>) {
    let id = id.disclose_as::<Mutation>(c);
    let known = ACCOUNT.grants.member(c, &id).stale(c);
    c.assert(known.field());
    let mut old = ACCOUNT.grants.lookup(c, &id).stale(c);
    c.assert(old.active.field());
    old.active = Bool::from_field_unchecked(c.constant(0u64));
    ACCOUNT.grants.insert(c, &id, &old);
}

pub fn revoke_all(c: &mut Circuit3) {
    increment(c, &ACCOUNT.grant_generation);
    ACCOUNT.grants.reset_to_default(c);
}

pub fn authenticate(
    c: &mut Circuit3,
    auth: &Auth,
    origin: B32<Private>,
    slot: Uint<8>,
) -> (B32<Public>, GrantRecord) {
    if let Auth::K256 { envelope, .. } = auth {
        let zero = c.constant(0u64).private();
        c.assert_eq(envelope.field(), zero);
    }
    auth.live_key(c);
    let p = Preimage::tag(c, &format!("midnight:account:grant:id:{}v1", auth.marker()));
    let me = kernel::self_address(c).bytes().private();
    let p = p.bytes(me).append(auth.key(c));
    let p = if let Auth::K256 { envelope, .. } = auth {
        p.uint(envelope.field(), 1)
    } else {
        p
    };
    let id = p
        .bytes(origin)
        .uint(slot.field(), 1)
        .hash(c)
        .disclose_as::<Mutation>(c);
    let known = ACCOUNT.grants.member(c, &id).stale(c);
    c.assert(known.field());
    let g = ACCOUNT.grants.lookup(c, &id).stale(c);
    c.assert(g.active.field());
    let epoch = ACCOUNT.device_epoch.read(c).stale(c);
    c.assert_eq(g.epoch.field(), epoch.field());
    let generation = ACCOUNT.grant_generation.read(c).stale(c);
    c.assert_eq(g.generation.field(), generation.field());
    // Compact || short-circuits, so the block-time read is guarded too.
    let zero = c.constant(0u64);
    let no_expiry = c.test_eq(g.scope.expires_at.field(), zero);
    let expires = c.not(no_expiry);
    c.when(expires, |c| {
        let valid = kernel::block_time_less_than(c, g.scope.expires_at);
        c.assert(valid);
    });
    (id, g)
}

#[derive(CircuitArg)]
pub struct SpendOpening {
    pub salt: B32<Private>,
    pub kind: Uint<8>,
    pub recipient: B32<Private>,
    pub max_coin_value: Uint<128>,
    pub spent_prev: Uint<128>,
}

// Keep the opened scope and the actual transfer fields explicit at this boundary.
#[allow(clippy::too_many_arguments)]
pub fn check_scope(
    c: &mut Circuit3,
    g: &GrantRecord,
    admitted: Bool<Public>,
    opening: &SpendOpening,
    color: B32<Private>,
    amount: Uint<128>,
    recipient: B32<Private>,
    kind: u64,
) -> F {
    c.assert(admitted.field());
    let hi = c.test_eq(g.scope.caller_commit.hi, 0u64);
    let lo = c.test_eq(g.scope.caller_commit.lo, 0u64);
    let unrestricted = c.mul(hi, lo);
    let restricted = c.not(unrestricted);
    c.when(restricted, |c| {
        let caller = kernel::caller(c);
        c.assert(caller.is_some.field());
        c.assert(caller.value.is_left.field());
        let address = caller.value.left.bytes().private();
        let present = c.constant(1u64).private();
        let commitment = caller_commit(c, opening.salt, present, address);
        let valid = bytes_eq(c, commitment, g.scope.caller_commit.private());
        c.assert(valid);
    });
    let expected = object(
        c,
        opening.salt,
        color,
        opening.kind,
        opening.recipient,
        opening.max_coin_value,
    );
    let matches = bytes_eq(c, expected, g.scope.object_commit.private());
    c.assert(matches);
    let valid = le(
        c,
        amount.field(),
        g.scope.per_call_cap.field().private(),
        128,
    );
    c.assert(valid);
    let expected = spent(c, opening.salt, opening.spent_prev.field());
    let matches = bytes_eq(c, expected, g.spent_commit.private());
    c.assert(matches);
    let wide = c.add(opening.spent_prev.field(), amount.field());
    let valid = le(c, wide, g.scope.cap.field().private(), 129);
    c.assert(valid);
    let next = c.assert_bits(wide, 128);
    let zero = c.constant(0u64).private();
    let wildcard = c.test_eq(opening.kind.field(), zero);
    let this_kind = c.constant(kind).private();
    let kind_matches = c.test_eq(opening.kind.field(), this_kind);
    let recipient_matches = bytes_eq(c, opening.recipient, recipient);
    let pinned = c.mul(kind_matches, recipient_matches);
    let admitted = either(c, wildcard, pinned);
    c.assert(admitted);
    next
}

pub fn shielded_bounds(
    c: &mut Circuit3,
    coin: &QualifiedShieldedCoinInfo3<Private>,
    max: Uint<128>,
    enc_pk: B32<Private>,
) {
    let valid = le(c, coin.value, max.field(), 128);
    c.assert(valid);
    let current = ACCOUNT.enc_key.read(c).stale(c).private();
    let matches = bytes_eq(c, current, enc_pk);
    c.assert(matches);
}

pub fn settle(
    c: &mut Circuit3,
    auth: &Auth,
    id: B32<Public>,
    mut g: GrantRecord,
    challenge: B32<Private>,
    salt: B32<Private>,
    new_spent: F,
) {
    auth.verify_grant(c, challenge);
    let nonce = next_counter(c, g.nonce.field().private()).disclose_as::<Mutation>(c);
    g.nonce = Uint::from_field_unchecked(nonce);
    g.spent_commit = spent(c, salt, new_spent).disclose_as::<Mutation>(c);
    ACCOUNT.grants.insert(c, &id, &g);
    increment(c, &ACCOUNT.round);
}

/// Canonical optional immediate-contract-caller commitment, shared with issue.
pub fn caller_commit(
    c: &mut Circuit3,
    salt: B32<Private>,
    present: F,
    address: B32<Private>,
) -> B32<Private> {
    let zero = B32::pad(c, "").private();
    let empty = bytes_eq(c, address, zero);
    let canonical = either(c, present, empty);
    c.assert(canonical);
    let commitment = Preimage::tag(c, "midnight:account:grant:caller:v1")
        .bytes(salt)
        .bytes(address)
        .hash(c);
    let reserved = bytes_eq(c, commitment, zero);
    let nonzero = c.not(reserved);
    implies(c, present, nonzero);
    B32::cond_select(c, present, &commitment, &zero)
}
