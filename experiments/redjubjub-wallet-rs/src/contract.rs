//! Contract artifact loading and state deserialisation.
//!
//! Loads pre-compiled Compact contract artifacts (.verifier, .prover, .zkir)
//! and deserialises on-chain contract state from the indexer.

use std::path::Path;

use anyhow::{Context, Result};
use midnight_onchain_state::state::ContractState;
use midnight_storage::db::InMemoryDB;
use midnight_transient_crypto::proofs::{ProvingKeyMaterial, VerifierKey};

/// Pre-compiled contract artifacts for a single circuit.
pub struct CircuitArtifacts {
    pub prover_key: Vec<u8>,
    pub verifier_key: Vec<u8>,
    pub zkir: Vec<u8>,
    pub bzkir: Vec<u8>,
}

/// All artifacts for the schnorr-wallet contract.
pub struct SchnorrWalletArtifacts {
    pub deposit: CircuitArtifacts,
    pub query_balance: CircuitArtifacts,
    pub register_owner: CircuitArtifacts,
    pub withdraw: CircuitArtifacts,
}

impl SchnorrWalletArtifacts {
    pub fn load(base_dir: &Path) -> Result<Self> {
        let keys_dir = base_dir.join("keys");
        let zkir_dir = base_dir.join("zkir");

        Ok(Self {
            deposit: CircuitArtifacts::load("deposit", &keys_dir, &zkir_dir)?,
            query_balance: CircuitArtifacts::load("query_balance", &keys_dir, &zkir_dir)?,
            register_owner: CircuitArtifacts::load("register_owner", &keys_dir, &zkir_dir)?,
            withdraw: CircuitArtifacts::load("withdraw", &keys_dir, &zkir_dir)?,
        })
    }
}

impl CircuitArtifacts {
    fn load(name: &str, keys_dir: &Path, zkir_dir: &Path) -> Result<Self> {
        Ok(Self {
            prover_key: std::fs::read(keys_dir.join(format!("{name}.prover")))
                .with_context(|| format!("failed to read {name}.prover"))?,
            verifier_key: std::fs::read(keys_dir.join(format!("{name}.verifier")))
                .with_context(|| format!("failed to read {name}.verifier"))?,
            zkir: std::fs::read(zkir_dir.join(format!("{name}.zkir")))
                .with_context(|| format!("failed to read {name}.zkir"))?,
            bzkir: std::fs::read(zkir_dir.join(format!("{name}.bzkir")))
                .with_context(|| format!("failed to read {name}.bzkir"))?,
        })
    }

    pub fn deserialize_verifier_key(&self) -> Result<VerifierKey> {
        midnight_serialize::tagged_deserialize(&self.verifier_key[..])
            .context("failed to deserialize verifier key")
    }

    pub fn to_proving_material(&self) -> ProvingKeyMaterial {
        ProvingKeyMaterial {
            prover_key: self.prover_key.clone(),
            verifier_key: self.verifier_key.clone(),
            ir_source: self.bzkir.clone(),
        }
    }
}

/// Deserialise on-chain contract state from the indexer's hex-encoded blob.
pub fn deserialize_contract_state(state_hex: &str) -> Result<ContractState<InMemoryDB>> {
    let bytes = hex::decode(state_hex).context("invalid hex in contract state")?;
    midnight_serialize::tagged_deserialize(&bytes[..])
        .context("failed to deserialize ContractState")
}

/// Extract the schnorr-wallet entry points from the deserialised contract state.
pub fn get_entry_points(state: &ContractState<InMemoryDB>) -> Vec<String> {
    state
        .operations
        .clone()
        .into_iter()
        .map(|(ep, _)| String::from_utf8_lossy(&ep).to_string())
        .collect()
}

/// Read the schnorr-wallet ledger state as a formatted summary.
///
/// The Compact contract stores 3 ledger fields as an Array:
///   [0] owner_pk: JubjubPoint (Cell or Null)
///   [1] registered: Boolean (Cell or Null)
///   [2] tx_count: Uint<64> (Cell or Null)
pub fn read_schnorr_wallet_state(state: &ContractState<InMemoryDB>) -> Result<SchnorrWalletLedger> {
    use midnight_onchain_state::state::StateValue;

    let data = state.data.get();
    let array = match &*data {
        StateValue::Array(arr) => arr,
        _ => anyhow::bail!("expected Array state, got non-array"),
    };

    let items: Vec<_> = array.iter_deref().collect();
    anyhow::ensure!(
        items.len() >= 3,
        "expected 3 ledger slots, got {}",
        items.len()
    );

    // Slot 0: owner_pk (JubjubPoint — Cell with aligned value, or Null)
    let owner_pk_repr = match &*items[0] {
        StateValue::Null => None,
        StateValue::Cell(aligned) => Some(format!("{aligned:?}")),
        _ => anyhow::bail!("owner_pk: unexpected state variant"),
    };

    // Slot 1: registered (Boolean — Cell or Null)
    let registered = match &*items[1] {
        StateValue::Null => false,
        StateValue::Cell(aligned) => {
            // Check if any byte in the value is nonzero (true)
            aligned
                .value
                .0
                .iter()
                .any(|atom| atom.0.iter().any(|&b| b != 0))
        }
        _ => anyhow::bail!("registered: unexpected state variant"),
    };

    // Slot 2: tx_count (Uint<64> — Cell or Null)
    let tx_count = match &*items[2] {
        StateValue::Null => 0u64,
        StateValue::Cell(aligned) => {
            if aligned.value.0.is_empty() {
                0u64
            } else {
                let chunk = &aligned.value.0[0].0;
                let mut buf = [0u8; 8];
                let len = chunk.len().min(8);
                buf[..len].copy_from_slice(&chunk[..len]);
                u64::from_le_bytes(buf)
            }
        }
        _ => anyhow::bail!("tx_count: unexpected state variant"),
    };

    Ok(SchnorrWalletLedger {
        owner_pk_repr,
        registered,
        tx_count,
    })
}

/// Decoded schnorr-wallet contract ledger state.
#[derive(Debug)]
pub struct SchnorrWalletLedger {
    pub owner_pk_repr: Option<String>,
    pub registered: bool,
    pub tx_count: u64,
}
