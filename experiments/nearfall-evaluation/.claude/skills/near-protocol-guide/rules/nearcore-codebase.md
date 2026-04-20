# nearcore Codebase Map

Reference for navigating the nearcore monorepo during Option 2 extraction analysis.

## Repository Structure

```
nearcore/
├── chain/
│   ├── chain/          ← Block processing, fork choice, gc
│   ├── chunks/         ← Chunk (shard block) production and validation
│   ├── epoch-manager/  ← Validator set, epoch transitions, shard assignment
│   ├── network/        ← P2P layer (libp2p-based)
│   └── rosetta-rpc/    ← Rosetta API adapter
├── runtime/
│   ├── runtime/        ← Transaction execution, receipts, state transitions
│   ├── near-vm-runner/ ← Wasm VM interface and gas metering
│   └── near-vm/        ← Wasmer fork with deterministic execution
├── core/
│   ├── primitives/     ← Core types: Block, Chunk, Transaction, Receipt
│   ├── crypto/         ← Key types, Ed25519, secp256k1
│   ├── store/          ← RocksDB wrapper, trie interface
│   └── o11y/           ← Observability / metrics
├── tools/
│   ├── state-viewer/   ← Offline state inspection
│   └── replay/         ← Block replay for debugging
└── neard/              ← Binary entrypoint, config, node startup
```

## Coupling Heat Map

High coupling = hard to extract; Low = extractable standalone.

```
nearcore monolith coupling (approximate):

chain/chain          ████████████  HIGH  — calls epoch-manager, runtime, network
chain/epoch-manager  ██████████    HIGH  — coupled to chain, chunks, primitives
chain/chunks         ████████      HIGH  — coupled to epoch-manager, runtime
runtime/runtime      ██████        MED   — coupled to primitives, vm-runner
runtime/near-vm      ████          MED   — near-specific gas table, host functions
chain/network        ████          MED   — libp2p + NEAR protocol messages
core/store           ██            LOW   — RocksDB wrapper, generic trie
core/crypto          █             LOW   — key types, pure crypto
core/primitives      █             LOW   — data structures (but NEAR-specific)
```

## Best Extraction Candidates (Option 2)

### 1. `core/crypto` — Key types
Pure cryptographic primitives. Could be used in Midnight as-is or as reference.
No NEAR-specific logic beyond type names.

### 2. `runtime/near-vm` — Wasm VM
The most self-contained runtime component. Could be adapted as a Substrate pallet
for WASM execution. Requires replacing NEAR-specific host functions with Substrate
equivalents.

**Effort estimate:** Medium — 2–4 engineer-months to extract and adapt.

### 3. `core/store` — Storage layer
RocksDB trie implementation. Less relevant given Substrate has its own storage layer,
but the trie structure is worth studying for state layout comparison.

## Hardest Extraction Targets

### Nightshade (sharding)
Split across `chain/chunks`, `chain/epoch-manager`, and `chain/chain`.
No clean interface boundary — extraction requires carrying ~40% of nearcore.

**Assessment:** Option 3 (re-implement the ideas) is faster than Option 2 for sharding.

### DOOMSLUG (consensus)
Embedded in `chain/chain`. Tightly coupled to epoch-manager for validator set queries
and to network for vote propagation.

**Assessment:** Same conclusion as Nightshade — take ideas, not code.

## How to Read the Codebase

```bash
# Clone
git clone https://github.com/near/nearcore
cd nearcore

# Find a type definition
grep -r "struct Block " --include="*.rs" -l

# Trace transaction flow
# Start at: chain/chain/src/chain.rs :: process_block()
# Then: runtime/runtime/src/lib.rs :: apply()
# Then: runtime/near-vm-runner/src/lib.rs :: run()

# Check crate dependencies
cargo tree -p near-chain --depth 2
```

## Interface Stability

NEAR does not publish stable internal APIs. The `near-sdk-rs` (contract SDK) is stable,
but the runtime/chain interfaces change with protocol versions. Any extraction effort
must pin to a specific nearcore commit and own the upgrade path.
