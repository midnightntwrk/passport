# Chain Signatures (MCS) — Deep Dive

Relevant to: bridge continuity (cNIGHT ↔ mNIGHT), hierarchical key derivation,
chain abstraction design pattern.

## What Chain Signatures Solves

Traditional bridges require a trusted multisig or a light-client relay with high latency.
Chain Signatures replaces the trusted signer with a **threshold MPC network** that is
economically secured by NEAR stake.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  NEAR Smart Contract (any chain target)                 │
│                                                         │
│  sign(payload: Vec<u8>, path: String, key_version: u32) │
└────────────────────┬────────────────────────────────────┘
                     │ cross-contract call
                     ▼
┌─────────────────────────────────────────────────────────┐
│  MPC Contract (v1.signer.near)                          │
│  - Receives sign request                                │
│  - Emits SignRequest event                              │
└────────────────────┬────────────────────────────────────┘
                     │ event
                     ▼
┌─────────────────────────────────────────────────────────┐
│  MPC Node Network (threshold-t-of-n)                    │
│  - Each node holds a key share                          │
│  - Nodes compute partial signatures                     │
│  - t shares assembled into full ECDSA/EdDSA signature  │
└────────────────────┬────────────────────────────────────┘
                     │ callback
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Relayer / Caller Contract                              │
│  - Receives (big_r, s) signature                        │
│  - Submits to target chain                              │
└─────────────────────────────────────────────────────────┘
```

## Key Derivation (Hierarchical)

The MPC root key + `(predecessor_id, path)` → deterministic child key:

```
child_public_key = derive(root_key, sha256(predecessor_id + "," + path))
```

This means:
- `my-contract.near` + `path: "ethereum-1"` → stable Ethereum address
- `my-contract.near` + `path: "bitcoin-1"` → stable Bitcoin address
- `my-contract.near` + `path: "midnight-1"` → potential Midnight address

The address is **deterministic and permanent** — it doesn't change across key rotations
(only `key_version` changes, producing a new address for migration).

## Supported Signature Schemes

| Scheme | Target chains |
|--------|--------------|
| `secp256k1` (ECDSA) | Ethereum, Bitcoin, most EVM chains |
| `ed25519` | Solana, NEAR, Cardano (subset) |

**Note for Midnight:** Midnight uses BLS/Schnorr signatures (via Substrate/BEEFY).
MCS does not currently support BLS. This is a ⚠️ RISK for a direct MCS → Midnight
signing path; a relay contract converting MCS output to a Midnight-compatible format
would be needed.

## Latency Profile

| Phase | Time |
|-------|------|
| Sign request → MPC response | ~3–5 seconds (NEAR block time × 1–2) |
| Signature delivery to target | Depends on target chain finality |

For Midnight: BEEFY finality is ~10–30 seconds → total round-trip ~15–35 seconds.
Acceptable for bridge operations; too slow for real-time dApp flows.

## Cost Model

```rust
// Calling sign() costs ~0.005 NEAR in gas
// Plus a protocol fee (currently ~0.1 NEAR per signature)
// Fees are burned / distributed to MPC nodes
```

## Code Pattern — Calling Chain Signatures from a Contract

```rust
use near_sdk::{near, AccountId, Promise, Gas, NearToken};

const MPC_CONTRACT: &str = "v1.signer.near";
const SIGN_GAS: Gas = Gas::from_tgas(250);
const SIGN_DEPOSIT: NearToken = NearToken::from_millinear(100); // 0.1 NEAR

#[near]
impl MyBridgeContract {
    pub fn request_signature(
        &self,
        payload: Vec<u8>,        // 32-byte hash to sign
        path: String,            // e.g. "midnight-bridge-1"
        key_version: u32,        // 0 for current key
    ) -> Promise {
        // Payload must be exactly 32 bytes
        assert_eq!(payload.len(), 32, "Payload must be 32 bytes");

        Promise::new(MPC_CONTRACT.parse().unwrap())
            .function_call(
                "sign".to_string(),
                serde_json::json!({
                    "request": {
                        "payload": payload,
                        "path": path,
                        "key_version": key_version,
                    }
                }).to_string().into_bytes(),
                SIGN_DEPOSIT,
                SIGN_GAS,
            )
    }

    #[private]
    pub fn on_signature_received(
        &self,
        #[callback_result] result: Result<SignResult, near_sdk::PromiseError>,
    ) {
        match result {
            Ok(sig) => {
                // sig.big_r: AffinePoint (R component)
                // sig.s: Scalar (s component)
                // Reconstruct full ECDSA signature and relay to target chain
            }
            Err(e) => near_sdk::env::panic_str(&format!("MCS failed: {:?}", e)),
        }
    }
}
```

## Derivation of Midnight Address from MCS Key

Since Midnight uses different key types, the most practical integration pattern is:

1. Use MCS to sign a **Midnight transaction hash** (secp256k1 → adaptor signature)
2. A Midnight relay contract verifies the adaptor and maps it to a Midnight operation
3. OR: Run a ZK circuit that proves "this secp256k1 signature authorises this Midnight action"

The ZK-circuit approach aligns with Midnight's Compact model and could be a novel
contribution of the NEARFall study.

## Relevant Repositories

- MPC contract: `github.com/near/mpc` (Rust)
- Chain signatures docs: `docs.near.org/concepts/abstraction/chain-signatures`
- Multichain examples: `github.com/near-examples/near-multichain`
- FastAuth (key management layer above MCS): `github.com/near/fast-auth-signer`
