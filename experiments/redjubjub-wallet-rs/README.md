# Experiment: Schnorr Wallet — Pure Rust (RedJubJub on Midnight)

## Purpose

This experiment proves that Midnight's cryptographic primitives — JubJub
curve arithmetic, Poseidon hashing, wallet key derivation, Schnorr
signing, contract artifact handling, and devnet interaction — can all be
performed in **pure Rust** using the `midnight-ledger` crates directly,
without TypeScript, WASM, or npm dependencies.

Contract deployment requires the Compact runtime (a Scheme/JS toolchain),
so deployment is done via the TypeScript `redjubjub-wallet` experiment.
All subsequent operations are pure Rust.

## What It Demonstrates

1. **Wallet key derivation** — `midnight-zswap::keys::Seed` derives coin,
   encryption, NIGHT signing, and dust keys identically to the TypeScript SDK
2. **JubJub Schnorr signing** — uses `midnight-curves::Fr` and
   `midnight-curves::JubjubSubgroup` (the same types used in-circuit)
3. **Schnorr verification** — `s*G == R + c*pk` verified in pure Rust
4. **Contract artifact loading** — verifier keys deserialised from the
   tagged binary format via `midnight-serialize`
5. **Indexer interaction** — GraphQL queries for contract state using the
   real `contractAction` API
6. **Node interaction** — JSON-RPC for chain info (block height, chain name)
7. **Proof server interaction** — HTTP client for `/version`, `/k`, `/prove`

## Prerequisites

- Docker (for the local Midnight devnet)
- Rust toolchain (`cargo`, edition 2024)
- `openssl` (for `.env` secret generation)
- A deployed contract from the TypeScript experiment (`../redjubjub-wallet`)

## Quick Start

```bash
# 1. Deploy the contract via the TypeScript experiment
cd ../redjubjub-wallet
./test-e2e.sh

# 2. Run the Rust e2e against the deployed contract
cd ../redjubjub-wallet-rs
./test-e2e.sh
```

## Individual Commands

```bash
# Derive wallet keys from seed
cargo run -- keys --seed 0000...0001

# Schnorr signing demo (no devnet needed)
cargo run -- sign

# Full e2e against deployed contract
cargo run -- e2e --seed $WALLET_SEED

# With explicit contract address
cargo run -- e2e --seed $WALLET_SEED --contract <hex>

# Unit tests
cargo test
```

The e2e command resolves the contract address from (in order):
1. `--contract` CLI arg
2. `CONTRACT_ADDRESS` env var
3. `../redjubjub-wallet/deployment.json`

## Crate Dependencies

All crypto comes from the `midnight-ledger` workspace (Apache-2.0,
at `../midnight-ledger/`, checked out at tag `ledger-8.0.2` to match
the devnet):

| Crate | What it provides |
|---|---|
| `midnight-zswap` | Wallet key derivation |
| `midnight-transient-crypto` | Poseidon hash, JubJub curve ops, proofs |
| `midnight-base-crypto` | Persistent hash (SHA-256), signatures |
| `midnight-ledger` | Transaction types, dust/fee handling |
| `midnight-serialize` | Wire format (tagged binary) |
| `midnight-curves` (crates.io) | JubJub, BLS12-381 curve definitions |
| `midnight-circuits` (crates.io) | Poseidon, ECC circuit gadgets |
| `midnight-proofs` (crates.io) | Proving system |

## Architecture

```
redjubjub-wallet-rs/
  src/
    main.rs          — CLI and e2e orchestration
    schnorr.rs       — JubJub Schnorr signing/verification (4 tests)
    wallet.rs        — Wallet key derivation (zswap + NIGHT + dust)
    contract.rs      — Contract artifact loading
    indexer.rs       — Indexer GraphQL client
    node.rs          — Node JSON-RPC client (4 tests)
    proof_client.rs  — Proof server HTTP client
  contracts/
    schnorr-wallet.compact          — Compact source (reference)
    managed/schnorr-wallet/         — Pre-compiled artifacts
  infra/                            — Docker-compose for devnet
  test-e2e.sh                       — Full test script
```

## Key Findings

### What Works in Pure Rust

- **All cryptographic primitives** — the `midnight-curves`, `midnight-circuits`,
  and `midnight-proofs` crates are on crates.io and work natively
- **Wallet key derivation** — `midnight-zswap` derives keys identically to
  the TypeScript SDK's WASM module
- **Contract artifact handling** — verifier keys, prover keys, and ZKIR
  files can be loaded and deserialised
- **Proof server communication** — the `/prove` and `/prove-tx` endpoints
  accept `tagged_serialize`d Rust types directly
- **Substrate extrinsic encoding** — SCALE encoding for `sendMnTransaction`

### What Requires the Compact Toolchain

- **Contract deployment** — the Compact constructor circuit must be executed
  and proved, which requires the Compact runtime (Scheme/JS). The constructor
  produces a transcript that gets included in the deploy transaction.
- **Circuit execution** — calling contract circuits requires running the
  compiled Compact code to produce transcripts. The Compact compiler
  generates JavaScript, not Rust.

### Version Sensitivity

The `midnight-ledger` crate version must match the devnet. The serialization
tags changed between v8.0.2 and v8.1.0-rc.1 (`pedersen-randomness-v1` vs
`embedded-fr`). Always check out the tag matching the proof server version.

## Relationship to ARC Passport

This experiment validates that the passport's FROST threshold signing
network can be implemented entirely in Rust. The key finding is that all
Midnight cryptographic primitives are publicly available — on crates.io
and in the open-source `midnight-ledger` repository.

The gap between "pure Rust crypto" and "full Rust SDK" is the Compact
runtime — the contract execution layer that produces circuit transcripts.
A future path would be a Rust implementation of the Compact runtime, or
a ZKIR-level interface that bypasses the JavaScript layer entirely.
