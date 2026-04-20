//! Wallet key derivation using the midnight-zswap and midnight-ledger crates.
//!
//! Derives three key sets from a single seed:
//! - Zswap keys (coin + encryption) for shielded transactions
//! - NIGHT signing key for unshielded UTXOs
//! - Dust secret key for fee payments

use anyhow::{Context, Result};
use midnight_base_crypto::signatures::SigningKey;
use midnight_ledger::dust::DustSecretKey;
use midnight_zswap::keys::{SecretKeys, Seed};

/// A wallet derived from a 32-byte seed.
pub struct Wallet {
    pub secret_keys: SecretKeys,
    pub night_key: SigningKey,
    pub dust_key: DustSecretKey,
}

impl Wallet {
    /// Create a wallet from a hex-encoded 32-byte seed.
    pub fn from_hex_seed(seed_hex: &str) -> Result<Self> {
        let seed_bytes = hex::decode(seed_hex).context("invalid hex seed")?;
        let seed_arr: [u8; 32] = seed_bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("seed must be exactly 32 bytes"))?;

        Self::from_seed(seed_arr)
    }

    /// Create a wallet from a raw 32-byte seed.
    pub fn from_seed(seed: [u8; 32]) -> Result<Self> {
        let zswap_seed = Seed::from(seed);
        let secret_keys = SecretKeys::from(zswap_seed);

        // Derive dust key from the same seed using midnight-ledger's derivation
        let dust_seed = midnight_ledger::dust::Seed::from(seed);
        let dust_key = DustSecretKey::derive_secret_key(&dust_seed);

        // For the NIGHT signing key, derive deterministically from the seed.
        // The TS SDK uses HD wallet derivation, but for this experiment we
        // derive a signing key from the seed bytes directly.
        let night_key = SigningKey::from_bytes(&seed)
            .map_err(|e| anyhow::anyhow!("failed to derive NIGHT signing key: {e}"))?;

        Ok(Self {
            secret_keys,
            night_key,
            dust_key,
        })
    }
}
