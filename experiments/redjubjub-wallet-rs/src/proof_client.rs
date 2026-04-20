//! HTTP client for the Midnight proof server.
//!
//! The proof server exposes:
//!   GET  /version       — server version string
//!   GET  /health        — health check
//!   GET  /ready         — readiness (job queue status)
//!   POST /k             — circuit k value from ZKIR
//!   POST /check         — check a proof preimage
//!   POST /prove         — generate a ZK proof for a single circuit
//!   POST /prove-tx      — prove a full transaction
//!
//! Wire format: all POST bodies use `midnight-serialize::tagged_serialize`
//! (a length-prefixed binary format), not JSON.

use anyhow::{Context, Result};
use std::path::Path;

/// Client for the Midnight proof server HTTP API.
pub struct ProofClient {
    base_url: String,
    client: reqwest::Client,
}

impl ProofClient {
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client: reqwest::Client::new(),
        }
    }

    /// GET /version — returns the proof server version string.
    pub async fn version(&self) -> Result<String> {
        let url = format!("{}/version", self.base_url);
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .context("failed to reach proof server")?;
        let text = resp.text().await?;
        Ok(text)
    }

    /// GET /health — returns true if healthy.
    pub async fn health(&self) -> Result<bool> {
        let url = format!("{}/health", self.base_url);
        let resp = self.client.get(&url).send().await;
        Ok(resp.map(|r| r.status().is_success()).unwrap_or(false))
    }

    /// POST /k — get the circuit k value from a ZKIR file.
    ///
    /// The proof server expects the raw ZKIR bytes as the POST body.
    pub async fn get_k(&self, zkir_path: &Path) -> Result<u32> {
        let zkir_bytes = std::fs::read(zkir_path)
            .with_context(|| format!("failed to read {}", zkir_path.display()))?;

        let url = format!("{}/k", self.base_url);
        let resp = self
            .client
            .post(&url)
            .body(zkir_bytes)
            .send()
            .await
            .context("failed to POST /k")?;

        let text = resp.text().await?;
        let k: u32 = text.trim().parse().context("invalid k value from server")?;
        Ok(k)
    }

    /// POST /prove — send a proof preimage and receive a proof.
    ///
    /// The body is `tagged_serialize((ProofPreimageVersioned, Option<ProvingKeyMaterial>, Option<Fr>))`.
    /// Returns the raw response bytes (a `tagged_serialize`d `ProofVersioned`).
    pub async fn prove_raw(&self, body: Vec<u8>) -> Result<Vec<u8>> {
        let url = format!("{}/prove", self.base_url);
        let resp = self
            .client
            .post(&url)
            .body(body)
            .send()
            .await
            .context("failed to POST /prove")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("proof server /prove returned {status}: {text}");
        }

        let bytes = resp.bytes().await?;
        Ok(bytes.to_vec())
    }

    /// POST /check — check a proof preimage without generating a proof.
    ///
    /// The body is `tagged_serialize((ProofPreimageVersioned, Option<WrappedIr>))`.
    /// Returns the raw response bytes.
    pub async fn check_raw(&self, body: Vec<u8>) -> Result<Vec<u8>> {
        let url = format!("{}/check", self.base_url);
        let resp = self
            .client
            .post(&url)
            .body(body)
            .send()
            .await
            .context("failed to POST /check")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("proof server /check returned {status}: {text}");
        }

        let bytes = resp.bytes().await?;
        Ok(bytes.to_vec())
    }

    /// POST /prove-tx — prove a full transaction.
    ///
    /// The body is `tagged_serialize((Transaction<Signature, ProofPreimageMarker, ...>, HashMap<String, ProvingKeyMaterial>))`.
    /// Returns the raw response bytes (a `tagged_serialize`d proven transaction).
    pub async fn prove_transaction_raw(&self, body: Vec<u8>) -> Result<Vec<u8>> {
        let url = format!("{}/prove-tx", self.base_url);
        let resp = self
            .client
            .post(&url)
            .body(body)
            .send()
            .await
            .context("failed to POST /prove-tx")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("proof server /prove-tx returned {status}: {text}");
        }

        let bytes = resp.bytes().await?;
        Ok(bytes.to_vec())
    }
}
