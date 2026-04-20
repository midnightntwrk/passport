//! Circuit execution and Schnorr signature computation in pure Rust.
//!
//! Uses midnight-onchain-vm for state queries and midnight-transient-crypto
//! + midnight-base-crypto for hashing and JubJub curve operations.

use anyhow::Result;
use midnight_base_crypto::hash::PersistentHashWriter;
use midnight_base_crypto::repr::MemWrite;
use midnight_coin_structure::contract::ContractAddress;
use midnight_onchain_runtime::context::QueryContext;
use midnight_onchain_state::state::ContractState;
use midnight_onchain_vm::cost_model::INITIAL_COST_MODEL;
use midnight_onchain_vm::ops::Op;
use midnight_onchain_vm::result_mode::{GatherEvent, ResultModeGather};
use midnight_storage::db::InMemoryDB;
use midnight_transient_crypto::curve::{EmbeddedGroupAffine, Fr};
use midnight_transient_crypto::fab::{AlignedValueExt, ValueReprAlignedValue};

/// Read a state slot via the onchain VM.
pub fn vm_read_state_slot(
    contract_state: &ContractState<InMemoryDB>,
    contract_address: ContractAddress,
    slot_index: u64,
) -> Result<VmReadResult> {
    let context = QueryContext::new(contract_state.data.clone(), contract_address);
    let ops: Vec<Op<ResultModeGather, InMemoryDB>> = vec![
        Op::Dup { n: 0 },
        Op::Idx {
            cached: false,
            push_path: false,
            path: vec![midnight_onchain_vm::ops::Key::Value(slot_index.into())]
                .into_iter()
                .collect(),
        },
        Op::Popeq {
            cached: false,
            result: (),
        },
    ];
    let result = context
        .query(&ops, None, &INITIAL_COST_MODEL)
        .map_err(|e| anyhow::anyhow!("VM query failed: {e:?}"))?;
    let mut read_value = String::from("(no result)");
    for event in &result.events {
        if let GatherEvent::Read(val) = event {
            read_value = format!("{val:?}");
        }
    }
    Ok(VmReadResult {
        slot_index,
        value: read_value,
    })
}

pub struct VmReadResult {
    pub slot_index: u64,
    pub value: String,
}

/// Compute the Schnorr withdrawal challenge using the same hash as the contract.
///
/// The Compact `persistentHash` on field-aligned data uses SHA-256 via
/// `PersistentHashWriter` on the binary representation of the aligned values.
/// This is the same code path used by `onchain-runtime-wasm::persistentHash`.
pub fn compute_withdraw_challenge(
    sig_r: &EmbeddedGroupAffine,
    owner_pk: &EmbeddedGroupAffine,
    color: &[u8; 32],
    amount: u128,
    recipient: &[u8; 35],
    tx_count: u64,
    nonce: u64,
) -> [u8; 32] {
    // Build the AlignedValue for each parameter and hash them together
    // using PersistentHashWriter (SHA-256 on binary repr).
    //
    // The Compact type signature is:
    //   persistentHash<[JubjubPoint, JubjubPoint, Bytes<32>, Uint<128>,
    //                    UserAddress, Uint<64>, Uint<64>]>(...)
    let mut hasher = PersistentHashWriter::new();

    // Each value is converted to its binary hash repr via the Aligned trait
    // JubjubPoint: serialize as compressed group encoding
    use midnight_serialize::Serializable;
    let mut sig_r_bytes = Vec::new();
    sig_r.serialize(&mut sig_r_bytes).unwrap();
    MemWrite::write(&mut hasher, &sig_r_bytes);

    let mut pk_bytes = Vec::new();
    owner_pk.serialize(&mut pk_bytes).unwrap();
    MemWrite::write(&mut hasher, &pk_bytes);

    // Bytes<32>
    MemWrite::write(&mut hasher, color.as_slice());

    // Uint<128>
    MemWrite::write(&mut hasher, &amount.to_le_bytes());

    // UserAddress (35 bytes)
    MemWrite::write(&mut hasher, recipient.as_slice());

    // Uint<64>
    MemWrite::write(&mut hasher, &tx_count.to_le_bytes());

    // Uint<64>
    MemWrite::write(&mut hasher, &nonce.to_le_bytes());

    hasher.finalize().0
}

/// The JUBJUB_R constant — the order of the JubJub scalar field.
pub const JUBJUB_R: [u8; 32] = [
    0xb7, 0x2c, 0xf7, 0xd6, 0x5e, 0x0e, 0x97, 0xd0, 0x82, 0x10, 0xc8, 0xcc, 0x93, 0x20, 0x68, 0xa6,
    0x00, 0x3b, 0x34, 0x01, 0x01, 0x3b, 0x67, 0x06, 0xa9, 0xaf, 0x33, 0x65, 0xea, 0xb4, 0x7d, 0x0e,
];

/// Check if a hash value (little-endian bytes) is less than JUBJUB_R.
fn hash_is_valid_scalar(hash_bytes: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        match hash_bytes[i].cmp(&JUBJUB_R[i]) {
            std::cmp::Ordering::Less => return true,
            std::cmp::Ordering::Greater => return false,
            std::cmp::Ordering::Equal => continue,
        }
    }
    false
}

/// Compute a Schnorr signature for a withdrawal.
///
/// Iterates nonce values until the hash challenge is < JUBJUB_R,
/// then computes s = r + c * sk.
pub fn sign_withdrawal(
    sk: &midnight_curves::Fr,
    owner_pk: &EmbeddedGroupAffine,
    color: &[u8; 32],
    amount: u128,
    recipient: &[u8; 35],
    tx_count: u64,
) -> Result<WithdrawSignature> {
    use ff::Field;
    use group::Group;

    let r = midnight_curves::Fr::random(&mut rand::rngs::OsRng);
    let big_r_point = midnight_curves::JubjubSubgroup::generator() * r;
    let sig_r = EmbeddedGroupAffine(big_r_point.into());

    let mut nonce = 0u64;
    let challenge_bytes;
    loop {
        let h =
            compute_withdraw_challenge(&sig_r, owner_pk, color, amount, recipient, tx_count, nonce);
        if hash_is_valid_scalar(&h) {
            challenge_bytes = h;
            break;
        }
        nonce += 1;
        anyhow::ensure!(nonce < 1000, "no valid nonce found after 1000 attempts");
    }

    // Convert challenge bytes to JubJub scalar
    let c = midnight_curves::Fr::from_bytes(&challenge_bytes);
    anyhow::ensure!(
        bool::from(c.is_some()),
        "challenge is not a valid JubJub scalar"
    );
    let c = c.unwrap();

    let s = r + c * sk;

    Ok(WithdrawSignature {
        sig_r,
        sig_s: s,
        nonce,
        challenge_bytes,
        nonce_attempts: nonce + 1,
    })
}

pub struct WithdrawSignature {
    pub sig_r: EmbeddedGroupAffine,
    pub sig_s: midnight_curves::Fr,
    pub nonce: u64,
    pub challenge_bytes: [u8; 32],
    pub nonce_attempts: u64,
}

/// Verify a Schnorr signature: s*G == R + c*pk
pub fn verify_schnorr(
    pk: &EmbeddedGroupAffine,
    challenge_bytes: &[u8; 32],
    sig_r: &EmbeddedGroupAffine,
    sig_s: &midnight_curves::Fr,
) -> bool {
    use group::Group;

    let c = midnight_curves::Fr::from_bytes(challenge_bytes);
    if bool::from(c.is_none()) {
        return false;
    }
    let c = c.unwrap();

    let lhs = midnight_curves::JubjubSubgroup::generator() * *sig_s;
    let pk_sub: midnight_curves::JubjubSubgroup = pk.0.into();
    let rhs = midnight_curves::JubjubSubgroup::from(sig_r.0) + pk_sub * c;
    lhs == rhs
}
