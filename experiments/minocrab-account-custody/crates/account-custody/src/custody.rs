use crate::auth::{Auth, Preimage, bytes_eq};
use crate::{ACCOUNT, Mutation, increment};
use minocrab::v3::{Circuit3, CircuitAbi, FieldT, Prim, Wire3};
use minocrab::{Private, Public};
use minocrab_std::v3::*;

/// An unconstrained Compact Field argument (signature scalar).
#[derive(Clone, Copy)]
pub struct Scalar(pub Wire3<FieldT, Private>);
impl CircuitAbi for Scalar {
    const SLOTS: usize = 1;
    fn push_atoms(out: &mut Vec<minocrab::AlignmentAtom>) {
        out.push(minocrab::AlignmentAtom::Field);
    }
    fn push_prims(out: &mut Vec<Prim>) {
        out.push(Prim::Field);
    }
}
impl CircuitArg for Scalar {
    fn declare(c: &mut Circuit3, path: &ArgPath) -> Self {
        Self(c.arg(path.as_str()))
    }
    fn push_slots(&self, out: &mut Vec<Wire3<FieldT, Private>>) {
        out.push(self.0);
    }
}

pub fn activate(c: &mut Circuit3, auth: &Auth, salt: B32<Private>) {
    let booted = ACCOUNT.booted.read(c).stale(c);
    let fresh = c.not(booted.field());
    c.assert(fresh);
    auth.live_key(c);
    let expected = auth.boot(c, salt);
    let stored = ACCOUNT.boot.read(c).stale(c).private();
    let matches = bytes_eq(c, expected, stored);
    c.assert(matches);
    let zero = c.constant(0u64).private();
    let entry = auth.entry(c, zero).disclose_as::<Mutation>(c);
    ACCOUNT.devices.insert(c, &entry);
    let one = c.constant(1u64);
    ACCOUNT
        .device_count
        .write(c, &Uint::<8, Public>::from_field_unchecked(one));
    ACCOUNT.booted.write(c, &Bool::from_field_unchecked(one));
    let zero = B32::pad(c, "");
    ACCOUNT.boot.write(c, &zero);
    increment(c, &ACCOUNT.round);
}

pub fn gate(c: &mut Circuit3, auth: &Auth, counter: Uint<64>, op: &str, args: Preimage) {
    let nonce = ACCOUNT.auth_nonce.read(c).stale(c).field().private();
    let challenge = auth.challenge(c, op, false, args, nonce);
    auth.authorise(c, counter, challenge);
}

pub fn append(c: &mut Circuit3, entry: &BytesN<Private, 192>) {
    let count = ACCOUNT.inbox_count.read(c).stale(c);
    let entry = entry.clone().disclose_as::<Mutation>(c);
    ACCOUNT.inbox.insert(c, &count, &entry);
    increment(c, &ACCOUNT.inbox_count);
}

pub fn withdraw_unshielded(
    c: &mut Circuit3,
    color: CoinColor<Private>,
    amount: Uint<128>,
    recipient: UserAddress<Private>,
) {
    let color = color.disclose_as::<Mutation>(c);
    let amount = amount.disclose_as::<Mutation>(c);
    let known = ACCOUNT.unshielded_balances.member(c, &color).stale(c);
    c.assert(known.field());
    let balance = ACCOUNT.unshielded_balances.lookup(c, &color).stale(c);
    let remaining = balance.sub(c, amount);
    ACCOUNT.unshielded_balances.insert(c, &color, &remaining);
    let zero = B32::pad(c, "");
    let no = c.constant(0u64);
    let recipient = Either {
        is_left: Bool::from_field_unchecked(no),
        left: ContractAddress::from_limbs([zero.hi, zero.lo]),
        right: recipient.disclose_as::<Mutation>(c),
    };
    kernel::send_unshielded(c, color, amount, &recipient);
}

pub fn held_coin(c: &mut Circuit3) -> QualifiedShieldedCoinInfo3<Private> {
    // Witness order and all six constraints match held_coin's return ABI.
    let nonce_hi = c.witness::<FieldT>();
    let nonce_lo = c.witness::<FieldT>();
    let color_hi = c.witness::<FieldT>();
    let color_lo = c.witness::<FieldT>();
    let value = c.witness::<FieldT>();
    let index = c.witness::<FieldT>();
    QualifiedShieldedCoinInfo3 {
        nonce: CoinNonce::from_limbs([c.assert_bits(nonce_hi, 8), c.assert_bits(nonce_lo, 248)]),
        color: CoinColor::from_limbs([c.assert_bits(color_hi, 8), c.assert_bits(color_lo, 248)]),
        value: c.assert_bits(value, 128),
        mt_index: c.assert_bits(index, 64),
    }
}

pub fn coin_preimage(coin: &QualifiedShieldedCoinInfo3<Private>) -> Preimage {
    Preimage::default()
        .bytes(coin.nonce.bytes())
        .bytes(coin.color.bytes())
        .uint(coin.value, 16)
        .uint(coin.mt_index, 8)
}

pub fn withdraw_shielded(
    c: &mut Circuit3,
    coin: QualifiedShieldedCoinInfo3<Private>,
    amount: Uint<128>,
    recipient: B32<Private>,
    to_contract: bool,
) -> ShieldedSendResult<Public> {
    let coin = QualifiedShieldedCoinInfo3 {
        nonce: coin.nonce.disclose_as::<Mutation>(c),
        color: coin.color.disclose_as::<Mutation>(c),
        value: coin.value.disclose_as::<Mutation>(c),
        mt_index: coin.mt_index.disclose_as::<Mutation>(c),
    };
    let amount = amount.disclose_as::<Mutation>(c);
    let recipient = recipient.disclose_as::<Mutation>(c);
    // The recipient arm is fixed by each exported circuit. Compute the output
    // commitment once, reusing it when a contract sends to itself.
    let me = kernel::self_address(c).bytes();
    let nullifier = coin_nullifier_contract(c, &coin.downcast(), &me);
    kernel::claim_zswap_nullifier(c, &nullifier);
    let balance = Uint::<128, Public>::from_field_unchecked(coin.value);
    let change = balance.sub(c, amount).field();
    let output = ShieldedCoinInfo3 {
        nonce: successor_nonce(c, b"midnight:kernel:nonce_evolve", coin.nonce),
        color: coin.color,
        value: amount.field(),
    };
    let is_user = c.constant(u64::from(!to_contract));
    let commitment = coin_commitment_to(c, &output, is_user.erase(), &recipient);
    kernel::claim_zswap_coin_spend(c, &commitment);
    if to_contract {
        let hi = c.test_eq(recipient.hi, me.hi);
        let lo = c.test_eq(recipient.lo, me.lo);
        let is_self = c.mul(hi, lo);
        c.when(is_self, |c| {
            kernel::claim_zswap_coin_receive(c, &commitment)
        });
    }
    let spent_all = c.test_eq(change, 0u64);
    let has_change = c.not(spent_all);
    let change_coin = ShieldedCoinInfo3 {
        nonce: successor_nonce(c, b"midnight:kernel:nonce_evolve/2", coin.nonce),
        color: coin.color,
        value: change,
    };
    let change_commitment = coin_commitment_to_contract(c, &change_coin, &me);
    c.when(has_change, |c| {
        kernel::claim_zswap_coin_spend(c, &change_commitment);
        kernel::claim_zswap_coin_receive(c, &change_commitment);
    });
    // The unused Maybe payload must remain all-zero, including exact spends.
    let nonce = change_coin.nonce.bytes();
    let color = change_coin.color.bytes();
    let change_value = ShieldedCoinInfo3 {
        nonce: CoinNonce::from_limbs([
            c.cond_select(spent_all, 0u64, nonce.hi),
            c.cond_select(spent_all, 0u64, nonce.lo),
        ]),
        color: CoinColor::from_limbs([
            c.cond_select(spent_all, 0u64, color.hi),
            c.cond_select(spent_all, 0u64, color.lo),
        ]),
        value: c.cond_select(spent_all, 0u64, change),
    };
    ShieldedSendResult {
        sent: output,
        change: Maybe {
            is_some: Bool::from_field_unchecked(has_change),
            value: change_value,
        },
    }
}

fn successor_nonce<const N: usize>(
    c: &mut Circuit3,
    domain: &[u8; N],
    nonce: CoinNonce<Public>,
) -> CoinNonce<Public> {
    let domain = Bytes::<N, Public>::constant(c, domain);
    let nonce = hash::degrade_to_transient(c, &nonce.bytes());
    let hash = c.transient_hash(&[domain.field().erase(), nonce.erase()]);
    let bytes = hash::upgrade_from_transient(c, hash);
    CoinNonce::from_limbs([bytes.hi, bytes.lo])
}

pub type Change = Maybe<ShieldedCoinInfo3<Public>, Public>;
pub struct SentAndChange(pub ShieldedCoinInfo3<Public>, pub Change);
impl CircuitOut for SentAndChange {
    const SLOTS: usize = 11;
    fn emit(self, c: &mut Circuit3, label: &str) {
        self.0.emit(c, label);
        self.1.emit(c, label);
    }
}

pub fn add_device(c: &mut Circuit3, entry: B32<Private>) {
    let entry = entry.disclose_as::<Mutation>(c);
    let known = ACCOUNT.devices.member(c, &entry).stale(c);
    let fresh = c.not(known.field());
    c.assert(fresh);
    ACCOUNT.devices.insert(c, &entry);
    increment(c, &ACCOUNT.device_count);
}

pub fn remove_device(c: &mut Circuit3, auth: &Auth, counter: Uint<64>, entry: B32<Private>) {
    let next = crate::auth::next_counter(c, counter.field());
    let caller = auth.entry(c, next);
    let entry = entry.disclose_as::<Mutation>(c);
    let count = ACCOUNT.device_count.read(c).stale(c);
    c.assert(greater_than(count, 1u64));
    let same = bytes_eq(c, entry.private(), caller);
    let other = c.not(same);
    c.assert(other);
    let known = ACCOUNT.devices.member(c, &entry).stale(c);
    c.assert(known.field());
    ACCOUNT.devices.remove(c, &entry);
    // The reference reads the count again for the assignment.
    let count = ACCOUNT.device_count.read(c).stale(c);
    let one = c.constant(1u64);
    let next = count.sub(c, Uint::<8, Public>::from_field_unchecked(one));
    ACCOUNT.device_count.write(c, &next);
}
