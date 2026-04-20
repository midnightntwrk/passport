---
name: near-protocol-guide
description: NEAR Protocol architecture reference for the NEARFall feasibility study. Use when analysing nearcore components, evaluating porting or extraction options, researching NEAR's sharding/TPS approach, Chain Signatures, account model, or smart contract SDK. Triggers on "NEAR", "nearcore", "Nightshade", "Chain Signatures", "near-sdk-rs", "NEAR runtime", "DOOMSLUG", or "Rainbow Bridge".
---

# NEAR Protocol — Architecture Reference for NEARFall

This skill is scoped to the NEARFall feasibility study (Options 1–3: port, extract, adapt).
For production NEAR dApp development, also consult the official docs at https://docs.near.org.

---

## 1. nearcore Architecture Overview

`nearcore` is a **monolithic Rust workspace** — all consensus, runtime, networking, and storage
live in one repository. This is the primary coupling risk for Option 2 (component extraction).

### Key crates

| Crate | Role | Extraction difficulty |
|-------|------|-----------------------|
| `chain/` | Block production, fork choice | High — deeply coupled to runtime |
| `runtime/` | Transaction execution, gas, state | Medium — has internal trait boundary |
| `network/` | P2P (libp2p-based) | Medium — assessments suggest similar to Ouroboros networking |
| `store/` | RocksDB state storage | Low — relatively clean interface |
| `crypto/` | Key types, signatures | Low — re-exportable |
| `node-runtime/` | Wasm VM (near-vm, wasmer) | Medium |
| `chain/epoch-manager/` | Validator set / epoch logic | High — intertwined with Nightshade |

### Monolith coupling assessment

NEAR's codebase does not expose stable internal APIs between crates — integration points
are implicit. Extracting a single component (e.g., Nightshade sharding logic) requires
either:
- Carrying a large transitive dependency surface, OR
- Rewriting the component against a new interface boundary (effectively Option 3)

This is the central ⚠️ RISK for Option 2.

---

## 2. Nightshade Sharding (500+ TPS Path)

NEAR's approach to horizontal scaling. Relevant to the 500+ TPS mandate.

### How it works

1. **Static shards** — the network is partitioned into N shards (currently 4 on mainnet).
2. **State sharding** — each shard owns a disjoint partition of account state.
3. **Single-shard blocks** — validators produce *chunks* (shard blocks); the beacon chain
   assembles them into a block. Each validator tracks only their assigned shard(s).
4. **Cross-shard calls** — async receipts routed across shard boundaries; no synchronous
   cross-shard state.

### TPS arithmetic

| Config | Theoretical TPS |
|--------|----------------|
| 1 shard (current Midnight) | ~3–10 TPS |
| 4 shards (NEAR mainnet) | ~100–200 TPS |
| 8+ shards (target) | 500+ TPS |

⚠️ **RISK:** Midnight's TPS bottleneck has been identified as **block size**, not protocol
throughput (Jon Rossie). Nightshade sharding may not address the root cause without
also changing block structure.

### Extraction viability

The sharding logic is tightly coupled to `epoch-manager` and the chunk validation
pipeline. Extracting Nightshade into Substrate would require reimplementing:
- Chunk production and validation
- Cross-shard receipt routing
- Epoch-level validator assignment

This is closer to Option 3 (take ideas) than Option 2 (take software).

---

## 3. DOOMSLUG Consensus

NEAR's block finality protocol. Relevant for Option 1 (full port) and Option 3 (adapt).

- **Single-round finality** — blocks are "doomslug-final" after one round of endorsements
  (a supermajority of stake-weighted validators).
- **BFT safety** — a second round achieves Tendermint-style Byzantine fault tolerance.
- Validators produce blocks on a fixed schedule; no leader election per block.

**Comparison to Midnight:** Midnight uses AURA (block production) + GRANDPA (finality) +
BEEFY (bridge finality). DOOMSLUG collapses these into a single protocol with weaker
asynchrony guarantees than GRANDPA.

---

## 4. Chain Signatures (MCS) — Cross-Chain Key Management

The most relevant NEAR feature for Midnight interoperability and bridge continuity
(cNIGHT ↔ mNIGHT).

### What it is

NEAR's **Multi-Party Computation Signing** service: a network of MPC nodes collectively
holds a root key and produces ECDSA/EdDSA signatures on behalf of NEAR smart contracts,
for *any* target chain.

### How it works

```
NEAR contract calls sign(payload, path, key_version)
    → MPC network computes signature share
    → threshold signature assembled
    → signature valid on target chain (Ethereum, Bitcoin, etc.)
```

The `path` parameter enables **hierarchical key derivation**: a single root MPC key
produces distinct child keys per (contract, path) pair — enabling one NEAR contract to
control addresses on multiple chains.

### Relevance to NEARFall

- Enables Midnight ↔ NEAR bridge continuity without a trusted bridge operator.
- Could replace the current cNIGHT ↔ mNIGHT bridge with a trust-minimised MCS relay.
- Hierarchical key derivation satisfies the stakeholder request for
  "derive keys for Cardano, Ethereum, Solana from a single root key."

### Key contracts and repos

| Resource | Location |
|----------|----------|
| MCS contract (Rust) | `github.com/near/mpc` |
| Chain Signatures docs | `docs.near.org/concepts/abstraction/chain-signatures` |
| Near-multichain examples | `github.com/near-examples/near-multichain` |

---

## 5. Account Model

Relevant for smart contract experiments and understanding state layout differences
vs Midnight.

### Named accounts

```
alice.near          ← top-level (mainnet)
alice.testnet       ← testnet
sub.alice.near      ← sub-account (alice controls creation)
```

### Access keys

Each account has one or more keys with distinct permissions:

| Key type | Permission | Use |
|----------|-----------|-----|
| Full access | All actions | Account management |
| Function call | Specific contract + methods | dApp sessions |

This is architecturally distinct from Midnight's ZK-based identity — a useful
comparison point for Option 3 adaptation.

### Storage staking

Accounts pay a rent deposit (`storage_deposit`) proportional to bytes used.
Relevant for state growth analysis (cf. Midnight's proof state growth problem).

---

## 6. NEAR Runtime — Transaction Execution

### Transaction lifecycle

```
SignedTransaction
  → Access key validation
  → Action execution (Transfer, FunctionCall, DeployContract, …)
  → Receipt generation (async cross-contract calls)
  → Receipt processing (next block or across shards)
```

### Gas model

- Gas is pre-paid; unused gas is refunded.
- `prepaid_gas` cap prevents infinite loops.
- Cross-contract calls attach gas explicitly.

**Comparison to Midnight:** Midnight uses ZK proof generation as the primary cost
model — no direct gas equivalent. A port would require mapping proof cost → gas.

### Wasm VM

NEAR uses a custom fork of Wasmer (`near-vm`) with deterministic gas metering.
The VM interface is defined in `near-vm-runner`. This is the most extractable
runtime component for Option 2.

---

## 7. Smart Contracts (near-sdk-rs)

For writing contract experiments in `/experiments/`.

### Minimal Rust contract

```rust
use near_sdk::{near, PanicOnDefault, AccountId, NearToken};
use near_sdk::store::LookupMap;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Counter {
    value: i64,
    owner: AccountId,
}

#[near]
impl Counter {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { value: 0, owner }
    }

    pub fn increment(&mut self) {
        self.value += 1;
    }

    pub fn get(&self) -> i64 {
        self.value
    }
}
```

### Key macros

| Macro | Purpose |
|-------|---------|
| `#[near(contract_state)]` | Marks the state struct |
| `#[near]` | Generates boilerplate for impl block |
| `#[init]` | Constructor (called once at deploy) |
| `#[payable]` | Allows attached NEAR tokens |
| `#[private]` | Restricts to self-calls only |

### Storage collections (prefer over `std`)

```rust
use near_sdk::store::{LookupMap, UnorderedMap, Vector};
// These serialize lazily — only touched keys hit storage
```

### Cross-contract calls

```rust
use near_sdk::ext_contract;

#[ext_contract(ext_other)]
trait OtherContract {
    fn some_method(&self, arg: String) -> String;
}

// In impl:
ext_other::ext(contract_id)
    .with_static_gas(Gas::from_tgas(5))
    .some_method("hello".to_string());
```

### Build and deploy

```bash
# Build
cargo build --target wasm32-unknown-unknown --release

# Deploy to testnet
near deploy --accountId mycontract.testnet \
  --wasmFile target/wasm32-unknown-unknown/release/mycontract.wasm
```

---

## 8. Rainbow Bridge (Ethereum ↔ NEAR)

Reference for understanding NEAR's existing bridge architecture before evaluating
a Midnight bridge.

- **Trust model:** Light-client based — Ethereum light client runs on NEAR and vice versa.
- **Latency:** ~10 min (Ethereum finality bound).
- **Components:** `eth-connector`, `bridge-token-factory`, `rainbow-bridge` relayers.
- **Relevance:** The Rainbow Bridge design pattern (on-chain light client verification)
  is a candidate pattern for a Midnight ↔ NEAR bridge, though Midnight's BEEFY
  finality gadget provides a more efficient proving mechanism.

---

## 9. Feasibility Study Checklist

Quick lookup for the three evaluation options:

### Option 1 — Full Port to NEAR

- [ ] Map all Midnight OS components (Starstream, Nightstream, Paima, Kachina) to NEAR equivalents
- [ ] Assess ledger migration cost (account state, ZK state, token balances)
- [ ] Evaluate bridge continuity: cNIGHT ↔ mNIGHT during migration window
- [ ] Assess ZK privacy layer replacement (Midnight's Compact circuits → ?)
- [ ] Evaluate DOOMSLUG vs GRANDPA finality guarantees

### Option 2 — Extract NEAR Software

- [ ] Identify which nearcore crates have stable interface boundaries
- [ ] Assess Nightshade extraction cost (epoch-manager coupling)
- [ ] Assess near-vm extraction as Substrate pallet
- [ ] Assess MCS (Chain Signatures) extraction as standalone service

### Option 3 — Take Ideas from NEAR

- [ ] Design Nightshade-inspired sharding for Substrate
- [ ] Design DOOMSLUG-inspired single-round finality for Substrate
- [ ] Design MCS-inspired MPC signing for Midnight bridge
- [ ] Design hierarchical key derivation for Midnight account model

---

## 10. Key References

- [NEAR Docs](https://docs.near.org)
- [nearcore GitHub](https://github.com/near/nearcore)
- [Nightshade whitepaper](https://near.org/papers/nightshade)
- [Chain Signatures docs](https://docs.near.org/concepts/abstraction/chain-signatures)
- [near-sdk-rs](https://github.com/near/near-sdk-rs)
- [Rainbow Bridge](https://github.com/aurora-is-near/rainbow-bridge)
- [NEAR MPC repo](https://github.com/near/mpc)

## Rules

See `/rules/` directory:
- `nearcore-codebase.md` — crate map and extraction guidance
- `chain-signatures.md` — MCS deep-dive for bridge/interop design
