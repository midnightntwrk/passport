//! GraphQL client for the Midnight indexer.
//!
//! The indexer exposes a GraphQL API at `/api/v4/graphql`.
//!
//! Key query: `contractAction(address)` returns the latest contract state
//! as a hex-encoded blob in the `state` field.

use anyhow::{Context, Result};
use serde::Deserialize;

/// Client for the Midnight indexer GraphQL API.
pub struct IndexerClient {
    url: String,
    client: reqwest::Client,
}

#[derive(Debug, Deserialize)]
pub struct GraphQlResponse<T> {
    pub data: Option<T>,
    pub errors: Option<Vec<GraphQlError>>,
}

#[derive(Debug, Deserialize)]
pub struct GraphQlError {
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractActionResponse {
    pub contract_action: Option<ContractActionData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractActionData {
    /// Hex-encoded serialised contract state.
    pub state: String,
    /// Hex-encoded serialised zswap state.
    pub zswap_state: String,
    /// Unshielded token balances held by the contract.
    pub unshielded_balances: Vec<UnshieldedBalance>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnshieldedBalance {
    pub token_type: String,
    pub amount: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionResponse {
    pub transactions: Vec<TransactionData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionData {
    pub hash: String,
    pub block_height: u64,
}

impl IndexerClient {
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_string(),
            client: reqwest::Client::new(),
        }
    }

    /// Execute a raw GraphQL query and return the JSON response.
    async fn query_raw(
        &self,
        query: &str,
        variables: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let body = serde_json::json!({
            "query": query,
            "variables": variables,
        });

        let resp = self
            .client
            .post(&self.url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .context("failed to reach indexer")?;

        let json: serde_json::Value = resp.json().await.context("invalid indexer response")?;

        if let Some(errors) = json.get("errors") {
            if let Some(arr) = errors.as_array() {
                if !arr.is_empty() {
                    let msgs: Vec<String> = arr
                        .iter()
                        .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                        .map(String::from)
                        .collect();
                    anyhow::bail!("GraphQL errors: {}", msgs.join("; "));
                }
            }
        }

        Ok(json)
    }

    /// Check that the indexer is healthy.
    pub async fn health(&self) -> bool {
        let body = serde_json::json!({
            "query": "{ __typename }"
        });
        self.client
            .post(&self.url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// Query the latest contract action for an address.
    ///
    /// Returns the hex-encoded contract state, zswap state, and unshielded
    /// balances — or None if the contract has not been deployed.
    pub async fn contract_action(&self, address: &str) -> Result<Option<ContractActionData>> {
        let query = r#"
            query ContractAction($address: HexEncoded!) {
                contractAction(address: $address) {
                    state
                    zswapState
                    unshieldedBalances { tokenType amount }
                }
            }
        "#;
        let variables = serde_json::json!({ "address": address });
        let resp = self.query_raw(query, variables).await?;

        let data = match resp.get("data").and_then(|d| d.get("contractAction")) {
            Some(v) if !v.is_null() => v,
            _ => return Ok(None),
        };

        let action: ContractActionData =
            serde_json::from_value(data.clone()).context("failed to parse contractAction")?;

        Ok(Some(action))
    }

    /// Query the latest block info.
    pub async fn latest_block(&self) -> Result<serde_json::Value> {
        let query = "{ block { height hash timestamp } }";
        let resp = self.query_raw(query, serde_json::json!({})).await?;
        Ok(resp
            .get("data")
            .and_then(|d| d.get("block"))
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    /// Poll for a transaction by hash until it appears or timeout.
    pub async fn wait_for_transaction(&self, tx_hash: &str, timeout_secs: u64) -> Result<bool> {
        let query = r#"
            query Transactions($offset: TransactionOffset!) {
                transactions(offset: $offset) {
                    hash
                    blockHeight
                }
            }
        "#;

        let start = std::time::Instant::now();
        loop {
            // Search recent transactions for our hash
            let variables = serde_json::json!({
                "offset": { "hash": tx_hash }
            });
            let resp = self.query_raw(query, variables).await;

            if let Ok(json) = resp {
                if let Some(txs) = json
                    .get("data")
                    .and_then(|d| d.get("transactions"))
                    .and_then(|t| t.as_array())
                {
                    if !txs.is_empty() {
                        return Ok(true);
                    }
                }
            }

            if start.elapsed().as_secs() > timeout_secs {
                return Ok(false);
            }

            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    }
}
