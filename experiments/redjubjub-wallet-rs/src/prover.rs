//! Local proof generation using midnight-zkir.
//!
//! Proves circuits locally without the proof server, using the same
//! `LocalProvingProvider` that the proof server wraps.

use anyhow::{Context, Result};
use midnight_base_crypto::data_provider::{FetchMode, MidnightDataProvider, OutputMode};
use midnight_transient_crypto::proofs::{
    KeyLocation, ProvingKeyMaterial, Resolver as ResolverTrait,
};
use midnight_zkir::LocalProvingProvider;
use rand::rngs::OsRng;

use crate::contract::SchnorrWalletArtifacts;

/// A resolver that returns proving keys from our local contract artifacts.
pub struct LocalResolver {
    keys: std::collections::HashMap<String, ProvingKeyMaterial>,
}

impl LocalResolver {
    pub fn from_artifacts(artifacts: &SchnorrWalletArtifacts) -> Self {
        let mut keys = std::collections::HashMap::new();
        for (name, art) in [
            ("deposit", &artifacts.deposit),
            ("query_balance", &artifacts.query_balance),
            ("register_owner", &artifacts.register_owner),
            ("withdraw", &artifacts.withdraw),
        ] {
            keys.insert(name.to_string(), art.to_proving_material());
        }
        Self { keys }
    }
}

impl ResolverTrait for LocalResolver {
    fn resolve_key(
        &self,
        key: KeyLocation,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = std::io::Result<Option<ProvingKeyMaterial>>>
                + Send
                + '_,
        >,
    > {
        let result = self.keys.get(key.0.as_ref()).cloned();
        Box::pin(std::future::ready(Ok(result)))
    }
}

/// Check a proof preimage locally (witness generation check, no proof).
pub async fn check_preimage(
    preimage: &midnight_transient_crypto::proofs::ProofPreimage,
    resolver: &LocalResolver,
) -> Result<Vec<Option<usize>>> {
    let params = MidnightDataProvider::new(FetchMode::OnDemand, OutputMode::Log, vec![])
        .context("failed to create params provider")?;

    let provider = LocalProvingProvider {
        rng: OsRng,
        resolver,
        params: &params,
    };

    use midnight_transient_crypto::proofs::ProvingProvider;
    provider
        .check(preimage)
        .await
        .context("preimage check failed")
}

/// Prove a circuit locally and return the proof.
pub async fn prove_preimage(
    preimage: &midnight_transient_crypto::proofs::ProofPreimage,
    resolver: &LocalResolver,
) -> Result<midnight_transient_crypto::proofs::Proof> {
    let params = MidnightDataProvider::new(FetchMode::OnDemand, OutputMode::Log, vec![])
        .context("failed to create params provider")?;

    let provider = LocalProvingProvider {
        rng: OsRng,
        resolver,
        params: &params,
    };

    use midnight_transient_crypto::proofs::ProvingProvider;
    provider
        .prove(preimage, None)
        .await
        .context("local proving failed")
}
