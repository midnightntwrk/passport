//! JSON-RPC client for the Midnight node.
//!
//! The Midnight node is Substrate-based and expects SCALE-encoded extrinsics.
//! A Midnight transaction (the `tagged_serialize`d bytes from the proof server)
//! must be wrapped in a Substrate unsigned extrinsic that calls:
//!
//!   `midnight.sendMnTransaction(midnight_tx: Vec<u8>)`
//!
//! The extrinsic format is:
//!   - Compact SCALE length prefix (total bytes that follow)
//!   - Version byte: 0x04 (unsigned extrinsic, format v4)
//!   - Pallet index: 0x05 (Midnight pallet)
//!   - Call index:   0x00 (sendMnTransaction)
//!   - SCALE-encoded Vec<u8>: compact length + raw bytes

use anyhow::{Context, Result};
use serde::Deserialize;

/// Midnight pallet index in the runtime (from runtime metadata).
const MIDNIGHT_PALLET_INDEX: u8 = 5;
/// `sendMnTransaction` is call variant 0 in the Midnight pallet.
const SEND_MN_TRANSACTION_CALL_INDEX: u8 = 0;

/// Client for the Midnight node JSON-RPC API.
pub struct NodeClient {
    http_url: String,
    client: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse<T> {
    #[allow(dead_code)]
    jsonrpc: String,
    result: Option<T>,
    error: Option<JsonRpcError>,
    #[allow(dead_code)]
    id: u64,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
    data: Option<serde_json::Value>,
}

impl NodeClient {
    /// Create a new node client. Accepts ws:// or http:// URLs;
    /// converts ws:// to http:// for JSON-RPC over HTTP.
    pub fn new(url: &str) -> Self {
        let http_url = url
            .replace("ws://", "http://")
            .replace("wss://", "https://");
        Self {
            http_url,
            client: reqwest::Client::new(),
        }
    }

    /// Check node health via HTTP.
    pub async fn health(&self) -> bool {
        let url = format!("{}/health", self.http_url);
        reqwest::get(&url)
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// Submit a raw JSON-RPC request.
    async fn rpc_call<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });

        let resp = self
            .client
            .post(&self.http_url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .context("failed to reach node")?;

        let json: JsonRpcResponse<T> = resp.json().await.context("invalid node response")?;

        if let Some(err) = json.error {
            anyhow::bail!(
                "JSON-RPC error {}: {} (data: {:?})",
                err.code,
                err.message,
                err.data
            );
        }

        json.result.context("missing result in JSON-RPC response")
    }

    /// Submit a proven Midnight transaction to the node.
    ///
    /// Wraps the raw transaction bytes in a Substrate unsigned extrinsic
    /// calling `midnight.sendMnTransaction(tx)`, then submits via
    /// `author_submitExtrinsic`.
    pub async fn submit_transaction(&self, midnight_tx: &[u8]) -> Result<String> {
        let extrinsic = encode_unsigned_extrinsic(midnight_tx);
        let hex = format!("0x{}", hex::encode(&extrinsic));
        let tx_hash: String = self
            .rpc_call("author_submitExtrinsic", serde_json::json!([hex]))
            .await?;
        Ok(tx_hash)
    }

    /// Get the current block number.
    pub async fn block_number(&self) -> Result<u64> {
        let hex: String = self
            .rpc_call("chain_getHeader", serde_json::json!([]))
            .await
            .and_then(|v: serde_json::Value| {
                v["number"]
                    .as_str()
                    .map(String::from)
                    .context("missing block number")
            })?;

        u64::from_str_radix(hex.trim_start_matches("0x"), 16).context("invalid block number hex")
    }

    /// Get the chain name.
    pub async fn system_chain(&self) -> Result<String> {
        self.rpc_call("system_chain", serde_json::json!([])).await
    }

    /// Get the node version.
    pub async fn system_version(&self) -> Result<String> {
        self.rpc_call("system_version", serde_json::json!([])).await
    }

    /// Dry-run a transaction to get detailed validation errors.
    pub async fn dry_run(&self, extrinsic_hex: &str) -> Result<String> {
        self.rpc_call("system_dryRun", serde_json::json!([extrinsic_hex]))
            .await
    }
}

/// Encode a Midnight transaction as a Substrate unsigned extrinsic.
///
/// Format:
///   [compact_len] [0x04] [pallet_idx] [call_idx] [compact_vec_len] [tx_bytes...]
///
/// - 0x04 = unsigned extrinsic, extrinsic format version 4
/// - pallet_idx = 5 (Midnight)
/// - call_idx = 0 (sendMnTransaction)
/// - The tx_bytes argument is SCALE-encoded as Vec<u8> (compact length prefix + raw bytes)
pub fn encode_unsigned_extrinsic_public(midnight_tx: &[u8]) -> Vec<u8> {
    encode_unsigned_extrinsic(midnight_tx)
}

fn encode_unsigned_extrinsic(midnight_tx: &[u8]) -> Vec<u8> {
    // Build the call payload: pallet_idx | call_idx | SCALE Vec<u8>
    let mut call = Vec::new();
    call.push(MIDNIGHT_PALLET_INDEX);
    call.push(SEND_MN_TRANSACTION_CALL_INDEX);
    // SCALE-encode the tx bytes as Vec<u8>: compact length + raw bytes
    scale_compact_encode(&mut call, midnight_tx.len() as u64);
    call.extend_from_slice(midnight_tx);

    // Build the extrinsic: version byte + call
    let mut body = Vec::new();
    body.push(0x04); // unsigned, extrinsic format v4
    body.extend_from_slice(&call);

    // Wrap with SCALE compact length prefix
    let mut extrinsic = Vec::new();
    scale_compact_encode(&mut extrinsic, body.len() as u64);
    extrinsic.extend_from_slice(&body);

    extrinsic
}

/// SCALE compact integer encoding.
fn scale_compact_encode(buf: &mut Vec<u8>, value: u64) {
    if value <= 0x3F {
        // Single-byte mode
        buf.push((value as u8) << 2);
    } else if value <= 0x3FFF {
        // Two-byte mode
        let v = ((value as u16) << 2) | 0x01;
        buf.extend_from_slice(&v.to_le_bytes());
    } else if value <= 0x3FFF_FFFF {
        // Four-byte mode
        let v = ((value as u32) << 2) | 0x02;
        buf.extend_from_slice(&v.to_le_bytes());
    } else {
        // Big-integer mode
        let bytes_needed = ((64 - value.leading_zeros() + 7) / 8) as u8;
        buf.push(((bytes_needed - 4) << 2) | 0x03);
        let le = value.to_le_bytes();
        buf.extend_from_slice(&le[..bytes_needed as usize]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_compact_small() {
        let mut buf = Vec::new();
        scale_compact_encode(&mut buf, 0);
        assert_eq!(buf, vec![0x00]);

        buf.clear();
        scale_compact_encode(&mut buf, 1);
        assert_eq!(buf, vec![0x04]);

        buf.clear();
        scale_compact_encode(&mut buf, 63);
        assert_eq!(buf, vec![0xFC]);
    }

    #[test]
    fn scale_compact_two_byte() {
        let mut buf = Vec::new();
        scale_compact_encode(&mut buf, 64);
        assert_eq!(buf, vec![0x01, 0x01]);

        buf.clear();
        scale_compact_encode(&mut buf, 16383);
        assert_eq!(buf, vec![0xFD, 0xFF]);
    }

    #[test]
    fn scale_compact_four_byte() {
        let mut buf = Vec::new();
        scale_compact_encode(&mut buf, 16384);
        assert_eq!(buf, vec![0x02, 0x00, 0x01, 0x00]);
    }

    #[test]
    fn extrinsic_wraps_call() {
        let tx = vec![0xAA, 0xBB];
        let ext = encode_unsigned_extrinsic(&tx);
        // Length prefix + 0x04 (version) + 0x05 (pallet) + 0x00 (call) + compact(2) + 0xAA 0xBB
        // Body is: [0x04, 0x05, 0x00, 0x08, 0xAA, 0xBB] = 6 bytes
        // compact(6) = 0x18
        assert_eq!(ext[0], 0x18); // compact length of 6
        assert_eq!(ext[1], 0x04); // unsigned extrinsic v4
        assert_eq!(ext[2], 0x05); // midnight pallet
        assert_eq!(ext[3], 0x00); // sendMnTransaction
        assert_eq!(ext[4], 0x08); // compact(2) = 2 << 2 = 8
        assert_eq!(ext[5], 0xAA);
        assert_eq!(ext[6], 0xBB);
    }
}
