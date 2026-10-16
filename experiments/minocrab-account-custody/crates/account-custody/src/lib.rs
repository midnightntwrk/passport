//! Minocrab implementation of the account custody reference.
pub mod auth;
pub mod constructor;
pub mod custody;
pub mod entrypoints;
pub mod grant_entrypoints;
pub mod grants;
pub mod p256;
pub mod p256_entrypoints;
pub mod recovery;

use minocrab::v3::Circuit3;
use minocrab::{Private, Public};
use minocrab_std::v3::{
    B32, Bool, BytesN, CircuitArg, CoinColor, CoinNonce, Disclose, Discloses, Ledger, LedgerCell,
    LedgerMap, LedgerSet, ShieldedCoinInfo3, Uint, coin_commitment_to_contract, contract, is_true,
    kernel, label,
};

#[derive(Clone, Copy, minocrab_std::v3::LedgerRepr)]
pub struct GrantScope {
    pub op_withdraw_unshielded: Bool<Public>,
    pub op_withdraw_shielded: Bool<Public>,
    pub op_withdraw_shielded_to_contract: Bool<Public>,
    pub read: Bool<Public>,
    pub object_commit: B32<Public>,
    pub per_call_cap: Uint<128, Public>,
    pub cap: Uint<128, Public>,
    pub expires_at: Uint<64, Public>,
    pub rp_commit: B32<Public>,
    pub read_pk_hash: B32<Public>,
    pub window_len: Uint<64, Public>,
    pub window_cap: Uint<128, Public>,
    pub caller_commit: B32<Public>,
}

#[derive(Clone, Copy, minocrab_std::v3::LedgerRepr)]
pub struct GrantRecord {
    pub epoch: Uint<32, Public>,
    pub generation: Uint<32, Public>,
    pub issued_at: Uint<64, Public>,
    pub nonce: Uint<64, Public>,
    pub spent_commit: B32<Public>,
    pub window_start: Uint<64, Public>,
    pub window_spent: Uint<128, Public>,
    pub active: Bool<Public>,
    pub scope: GrantScope,
}

/// Declaration order is the reference ledger ABI, including scoped grants.
#[derive(Ledger)]
pub struct Account {
    pub round: LedgerCell<Uint<64, Public>>,
    pub enc_key: LedgerCell<B32<Public>>,
    pub inbox: LedgerMap<Uint<64, Public>, BytesN<Public, 192>>,
    pub inbox_count: LedgerCell<Uint<64, Public>>,
    pub unshielded_balances: LedgerMap<CoinColor<Public>, Uint<128, Public>>,
    pub spec_version: LedgerCell<Uint<32, Public>>,
    pub devices: LedgerSet<B32<Public>>,
    pub device_epoch: LedgerCell<Uint<32, Public>>,
    pub device_count: LedgerCell<Uint<8, Public>>,
    pub auth_nonce: LedgerCell<Uint<64, Public>>,
    pub boot: LedgerCell<B32<Public>>,
    pub booted: LedgerCell<Bool<Public>>,
    pub grants: LedgerMap<B32<Public>, GrantRecord>,
    pub grant_generation: LedgerCell<Uint<32, Public>>,
    pub recovery_pk: LedgerCell<minocrab_std::v3::JubjubPoint<Public>>,
    // MerkleTreeDigest supplies the unbounded Field ABI; no Merkle semantics here.
    pub recovery_phi: LedgerMap<Uint<8, Public>, minocrab_std::v3::MerkleTreeDigest<Public>>,
    pub recovery_phi_len: LedgerCell<Uint<8, Public>>,
    pub recovery_session: LedgerCell<B32<Public>>,
    pub recovery_wrap: LedgerCell<BytesN<Public, 64>>,
    pub recovery_version: LedgerCell<Uint<32, Public>>,
    pub pending_recovery: LedgerCell<Bool<Public>>,
    pub pending_entry: LedgerCell<B32<Public>>,
    pub pending_recovery_pk: LedgerCell<minocrab_std::v3::JubjubPoint<Public>>,
    pub pending_not_before: LedgerCell<Uint<64, Public>>,
    pub veto_window: LedgerCell<Uint<64, Public>>,
}

pub const ACCOUNT: Account = Account::new();

#[derive(CircuitArg)]
pub struct CoinArg {
    pub nonce: CoinNonce<Private>,
    pub color: CoinColor<Private>,
    pub value: Uint<128>,
}

label! {
    DepositColour = "deposit colour";
    DepositAmount = "deposit amount";
    DepositCoin = "deposit coin";
    InboxEntry = "encrypted inbox entry";
    Mutation = "reference operation disclosures";
}

fn increment<const BITS: u32>(c: &mut Circuit3, slot: &LedgerCell<Uint<BITS, Public>>) {
    let prior = slot.read(c).stale(c);
    let one = c.constant(1u64);
    let next = c.add(prior.field(), one);
    let next = Uint::<BITS, Public>::from_field_checked(c, next);
    slot.write(c, &next);
}

pub struct Deposits;

#[contract]
impl Deposits {
    #[circuit]
    pub fn deposit_unshielded(
        c: &mut Circuit3,
        color: CoinColor<Private>,
        amount: Uint<128>,
    ) -> Discloses<(DepositColour, DepositAmount)> {
        let color = color.disclose_as::<DepositColour>(c);
        let amount = amount.disclose_as::<DepositAmount>(c);
        kernel::receive_unshielded(c, color, amount);
        let exists = ACCOUNT.unshielded_balances.member(c, &color).stale(c);
        c.when(is_true(exists), |c| {
            let prior = ACCOUNT.unshielded_balances.lookup(c, &color).stale(c);
            let sum = c.add(prior.field(), amount.field());
            let sum = Uint::<128, Public>::from_field_checked(c, sum);
            ACCOUNT.unshielded_balances.insert(c, &color, &sum);
        })
        .otherwise(|c| {
            ACCOUNT.unshielded_balances.insert(c, &color, &amount);
        });
        increment(c, &ACCOUNT.round);
        Discloses::of(())
    }

    #[circuit]
    pub fn deposit_shielded(
        c: &mut Circuit3,
        coin: CoinArg,
        entry: BytesN<Private, 192>,
    ) -> Discloses<(DepositCoin, InboxEntry)> {
        let coin = ShieldedCoinInfo3 {
            nonce: coin.nonce.disclose_as::<DepositCoin>(c),
            color: coin.color.disclose_as::<DepositCoin>(c),
            value: coin.value.disclose_as::<DepositCoin>(c).field(),
        };
        let me = kernel::self_address(c);
        let commitment = coin_commitment_to_contract(c, &coin, &me.bytes());
        kernel::claim_zswap_coin_receive(c, &commitment);
        let count = ACCOUNT.inbox_count.read(c).stale(c);
        let entry = entry.disclose_as::<InboxEntry>(c);
        ACCOUNT.inbox.insert(c, &count, &entry);
        increment(c, &ACCOUNT.inbox_count);
        increment(c, &ACCOUNT.round);
        Discloses::of(())
    }
}

/// Complete state-changing circuit registry; pure signer helpers are host code.
pub type CircuitRegistration = (&'static str, fn() -> minocrab::v3::Compiled3);

pub fn circuits() -> Vec<CircuitRegistration> {
    Deposits::CIRCUITS
        .into_iter()
        .chain(entrypoints::DeviceCalls::CIRCUITS)
        .chain(grant_entrypoints::GrantCalls::CIRCUITS)
        .chain(recovery::RecoveryCalls::CIRCUITS)
        .chain(p256_entrypoints::P256Calls::CIRCUITS)
        .collect()
}
