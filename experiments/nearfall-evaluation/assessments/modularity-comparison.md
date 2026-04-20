# 🤖 Modularity Comparison: NEAR Protocol vs. Midnight (Substrate/Polkadot)

> **Scope:** This document compares the modularity characteristics of NEAR Protocol's `nearcore` stack and Midnight's Substrate/FRAME-based architecture. It is intended to inform the three-option evaluation framework (port to NEAR, take software from NEAR, take ideas from NEAR) by identifying where architectural boundaries are clean enough to permit selective adoption.

---

## 1. Design Philosophies

| Attribute | Substrate/Midnight | NEAR Protocol |
|---|---|---|
| **Stated goal** | Modular blockchain framework | High-performance sharded L1 |
| **Primary modularity axis** | Vertical component decomposition (pallets) | Horizontal state decomposition (sharding) |
| **Codebase structure** | Framework (`substrate`) + application (`midnight-node`) | Monolithic (`nearcore`) + contract layer |
| **Customization model** | First-class: swap pallets, runtimes, consensus | Second-class: extend via smart contracts only |
| **Core design tension** | Modularity vs. performance | Performance vs. customizability |

The fundamental contrast is this: Substrate was **designed** to be decomposed; NEAR was designed to be **fast at scale**. These are not opposing goals, but they produce very different internal architectures and very different answers to the question "how easy is it to replace a component?"

---

## 2. Layer Decomposition

### 2.1 Substrate/Midnight

Substrate decomposes the blockchain vertically into well-defined, swappable layers:

```
┌────────────────────────────────────────────────┐
│ Application Layer (Midnight-specific)           │
│  Hoarfrost · ZSwap · Impact · Compact · ZKIR   │
├────────────────────────────────────────────────┤
│ FRAME Pallet Layer                              │
│  Consensus Pallet · Session · Staking · Sudo   │
├────────────────────────────────────────────────┤
│ Substrate Runtime                               │
│  WASM Runtime · SCALE Encoding · Host API      │
├────────────────────────────────────────────────┤
│ Substrate Client                                │
│  Networking (devp2p) · RPC · Block Import      │
└────────────────────────────────────────────────┘
```

Each layer communicates through stable, versioned interfaces:

- **FRAME pallets** are the primary extension point. They are Rust crates with defined storage items, dispatchable calls, and hooks. Pallets can be composed arbitrarily and reconfigured at compile time.
- **Consensus is pluggable**: AURA, BABE, and GRANDPA are each independent pallets. Midnight uses AURA (block production) + GRANDPA (finality) + BEEFY/MMR (bridging proofs). Swapping GRANDPA for Jolteon (planned in Hua 3.0) is a targeted upgrade, not a rewrite.
- **The WASM runtime boundary** is the key modularity seam: the host (native client) and the runtime (WASM) communicate through a defined host API, enabling **forkless runtime upgrades**. New ledger versions can be shipped without a hard fork.
- **The ledger host API is versioned**: Midnight's `Hoarfrost` ledger implementation is wired into the Substrate runtime via a versioned host API, meaning the ledger can in principle be replaced independently of the consensus layer.

**Midnight-specific coupling:** Despite Substrate's framework-level modularity, Midnight's own application-layer components are more tightly coupled than the pallet model suggests:

- `ZSwap` depends on BLS12-381 / JubJub curves and Plonk/KZG commitments baked into the transaction kernel.
- `Impact` is tightly coupled to the `Compact`/`ZKIR` circuit format.
- `Hoarfrost` is built on top of Substrate's SCALE-encoded storage, making it non-trivially portable to a non-SCALE environment.

### 2.2 NEAR Protocol

NEAR decomposes into two formally separated layers within a single codebase (`nearcore`):

```
┌────────────────────────────────────────────────┐
│ Chain Abstraction Layer (on-chain services)     │
│  NEAR Intents · Chain Signatures · OmniBridge  │
├────────────────────────────────────────────────┤
│ Runtime Layer                                   │
│  WASM Contract Execution · Gas Metering        │
│  Account Management · Receipt Processing       │
├────────────────────────────────────────────────┤
│ Blockchain Layer                                │
│  Nightshade Consensus · Sharding · Networking  │
│  Block/Chunk Production · State Sync           │
└────────────────────────────────────────────────┘
```

The clean separation principle is explicit and formally enforced:

- **Blockchain Layer is oblivious to business logic**: it routes, shards, and orders; it does not interpret.
- **Runtime Layer is unaware of sharding**: it executes receipts against local account state in isolation.

This is a genuine and well-engineered internal boundary. However, it is an **internal** boundary within a monolithic Rust project, not an **external** interface boundary like Substrate's pallet registry:

- There is no NEAR equivalent of FRAME. You cannot add a "pallet" to NEAR. New protocol features require modifying `nearcore` itself.
- **Consensus is not pluggable**: Nightshade sharding and the Doomslug/TPoS consensus mechanism are integral to the Blockchain Layer. Replacing either would require forking `nearcore`.
- **The Chain Abstraction Layer** (Intents, Chain Signatures) achieves a degree of application-layer extensibility by implementing high-level services *as smart contracts or as external services backed by smart contracts*, sidestepping the need to modify `nearcore` for new cross-chain capabilities. This is NEAR's primary extensibility story.

---

## 3. Key Modularity Dimensions Compared

### 3.1 Consensus Pluggability

| | Substrate/Midnight | NEAR |
|---|---|---|
| **Mechanism** | Independent pallets (AURA, BABE, GRANDPA, BEEFY) | Integrated Nightshade/Doomslug (not swappable) |
| **Swap cost** | Low: reconfigure FRAME, recompile | Very high: fork nearcore |
| **Midnight example** | Replacing GRANDPA with Jolteon (planned, contained) | N/A |
| **Assessment** | ✅ Genuinely modular | ❌ Monolithic |

### 3.2 Runtime/Execution Pluggability

| | Substrate/Midnight | NEAR |
|---|---|---|
| **Mechanism** | WASM runtime, forkless upgrades via on-chain governance | WASM contract execution within fixed runtime |
| **Upgrade path** | Runtime logic can be upgraded without hard fork | Protocol upgrades require node software release |
| **Custom VMs** | Possible: new pallet can introduce new host functions | Not supported at protocol level; must run within standard WASM |
| **Midnight example** | `Impact` interpreter lives in WASM runtime, upgradeable | An `Impact`-equivalent would be a WASM contract (gas constrained) |
| **Assessment** | ✅ Strong forkless upgrade path | ⚠️ Contract-layer extensible; protocol-layer rigid |

### 3.3 State Storage Pluggability

| | Substrate/Midnight | NEAR |
|---|---|---|
| **Storage model** | SCALE-encoded Merkle-Patricia Trie; Hoarfrost wraps it | Merkle Patricia Trie, partitioned by shard |
| **State isolation** | Single global trie (no native sharding) | Per-shard tries composing a global trie |
| **Custom state structures** | Possible via pallet storage items and host API | Fixed per-account key-value store |
| **ZK-specific state** | Hoarfrost adds commitment trees, nullifier sets, O(1) cloning | Not natively supported; would require contract-level state |
| **Assessment** | ✅ Extensible via host API versioning | ⚠️ Rigid per-account model; ZK structures non-trivial to add |

### 3.4 Scaling Model

| | Substrate/Midnight | NEAR |
|---|---|---|
| **Native approach** | Single-shard L1; scaling via co-chains (Nightclob) and L2 (Midnight City via Paima) | Native sharding: Nightshade splits state/execution across shards |
| **Shard count** | Not applicable to L1; co-chains are separate Substrate nodes | Currently 4+ shards, planned to scale dynamically |
| **Cross-shard latency** | N/A at L1; co-chain settlement adds multi-block latency | ~1 second per shard hop via receipt routing |
| **State partitioning** | Manual (each co-chain has its own state) | Automatic (accounts assigned to shards by ID) |
| **Assessment** | ⚠️ Scaling requires explicit co-chain architecture | ✅ Native; sharding is a first-class protocol feature |

### 3.5 Cross-Chain/Interoperability Extension

| | Substrate/Midnight | NEAR |
|---|---|---|
| **Bridge model** | BEEFY + MMR light-client proofs; protocol bridge pallet | OmniBridge; Hub-and-spoke; Chain Signatures (MPC threshold) |
| **Chain Signatures** | Planned (MCS): external service backed by Compact contracts | Native: NEAR MPC contract (`v1.signer`) using cait-sith/FROST |
| **Extensibility** | New bridge pallets; requires Substrate expertise | New signature schemes deployable as contracts without fork |
| **Assessment** | ⚠️ Capable but requires pallet development | ✅ Chain Signatures are the most portable NEAR component |

### 3.6 Application/Contract Layer Extensibility

| | Substrate/Midnight | NEAR |
|---|---|---|
| **Extension mechanism** | New FRAME pallets (Rust, compile-time) | Smart contracts (WASM, runtime-deployed) |
| **Deployment friction** | High: requires node software update and governance | Low: contracts deployed permissionlessly |
| **Gas/resource model** | DUST (renewable, generated from staked NIGHT) | 300 TGas/tx limit; 30% of gas to contract developers |
| **Privacy integration** | First-class: ZK proofs verified in transaction kernel | Not native; ZK verification must fit within gas limits |
| **Assessment** | ✅ Native ZK support at protocol level | ⚠️ ZK within gas constraints is a known risk (see HYPOTHESIS) |

---

## 4. The "Major Surgery" Assessment

The project background explicitly flags that "NEAR is not modular so this is likely major surgery, not a simple port." This comparison confirms that characterization, with important nuance:

**Where NEAR is genuinely less modular than Substrate:**

1. **Consensus is not extractable.** Nightshade is deeply integrated into `nearcore`'s block production and shard management. You cannot take Nightshade and run it without the rest of nearcore.
2. **No pallet equivalent.** There is no standard mechanism for extending the NEAR protocol with new host functions, new state types, or new transaction variants without forking `nearcore`.
3. **Protocol upgrades require node releases.** Unlike Substrate's forkless WASM runtime upgrades, NEAR protocol changes require all node operators to upgrade software.

**Where NEAR has genuine modularity advantages:**

1. **The Blockchain/Runtime split is clean and enforced.** The runtime being unaware of sharding, and the blockchain layer being unaware of business logic, means these two components could in principle be evolved somewhat independently.
2. **Chain Signatures are architecturally separable.** The MPC contract (`v1.signer`) runs as an ordinary NEAR contract. Its FROST/cait-sith library can be taken and run independently. This is the strongest candidate for Option 2 ("take software from NEAR").
3. **Intents/Chain Abstraction Layer is contract-native.** Because it is implemented as smart contracts rather than protocol modifications, the Intents architecture pattern is independently portable.

---

## 5. Implications for the Three-Option Evaluation

| Option | Modularity Assessment | Key Risks |
|---|---|---|
| **Option 1: Port to NEAR** | ⛔ Requires replacing Substrate's pallet architecture with nearcore's monolithic internals. Midnight's ZK, state (Hoarfrost), and consensus (AURA+GRANDPA) have no NEAR equivalents. The entire application layer must be rebuilt from scratch within NEAR's WASM gas constraints. | Ledger migration; ZK within 300 TGas limit; loss of forkless upgrades; bespoke `nearcore` fork required |
| **Option 2: Take software from NEAR** | ✅ Best candidates: Chain Signatures (MPC/FROST stack), NEAR SDK (WASM contract tooling), OmniBridge relayer logic. These components have clean external interfaces and do not require running nearcore. | Integration with Substrate host API; cryptographic curve compatibility (BN254 vs BLS12-381) |
| **Option 3: Take ideas from NEAR** | ✅ Best candidates: Nightshade sharding model (inspires Midnight City / Paima L2 design); receipt-based async execution (inspires cross-contract messaging design); Chain Abstraction Layer pattern (inspires Compact contract interface for cross-chain asset control). | None structural; depends only on engineering judgment in design |

---

## 6. Speculative Opportunity Catalogue: What NEAR Could Contribute to Midnight

> **Design-thinking note:** This section is intentionally expansive and divergent. It maps a broad possibility space for stakeholder, product, and engineering review — not a narrowed recommendation. Items are not pre-filtered for feasibility or current project scope. Each entry identifies whether the opportunity is primarily about **code reuse (Option 2)** or **design inspiration (Option 3)**, though many span both.

---

### 6.1 Cryptography and Threshold Security

**MPC / FROST Threshold Signing Library (`cait-sith`)**
*Option 2 — code reuse*
NEAR's `cait-sith` library implements a modern, audited threshold-ECDSA and threshold-Schnorr scheme. It is a standalone Rust library with no `nearcore` dependency. Midnight could adopt it directly to power its Chain Signatures (MCS) feature without building a new MPC stack from scratch.

**FROST-based Distributed Key Generation (DKG)**
*Option 2/3 — code reuse and design*
NEAR's DKG protocol for rotating MPC committee keys has been designed for liveness under partial committee failure. The design approach — separating key generation epochs from signing epochs, with threshold proactive re-sharing — is transferable to Midnight's committee-based bridge and future validator key management.

**TEE + MPC Hybrid Attestation**
*Option 3 — design inspiration*
The NearFall Technical Specification already explores a hybrid model where TEEs handle computation and MPC handles signing (preventing enclave-forking attacks). This pattern — TEE as execution environment, MPC as the trust anchor — could be generalized across Midnight's proof-server, prover network, and sequencer designs, not only for the Intents use case.

**Threshold BLS Signatures for Consensus**
*Option 3 — design inspiration*
NEAR uses threshold signatures for validator set aggregation. Applied to Midnight, this could replace GRANDPA's individual-signature finality model with a single aggregated BLS signature per finalized block, dramatically reducing on-chain proof sizes for light clients and bridges.

**Key Derivation for Multi-Chain Addresses**
*Option 2/3 — code and design*
NEAR Chain Signatures uses a hierarchical key derivation path (account + derivation path → child key per chain). This same scheme could provide Midnight users with a single identity key that deterministically generates address credentials for Cardano, Ethereum, Solana, and Midnight itself — a unified keychain across the multi-chain economy.

---

### 6.2 Scalability and State Architecture

**Nightshade Sharding as an Inspiration for Midnight City L2 Design**
*Option 3 — design inspiration*
Nightshade's core idea — that a global state trie can be partitioned into independently-executed chunks, with cross-shard operations serialized via receipts — is applicable to Midnight City's L2 architecture even without adopting NEAR's specific implementation. The receipt-routing pattern can inform how Paima or a bespoke L2 manages cross-domain state transitions.

**Flat Storage for Trie Performance**
*Option 2/3 — code and design*
NEAR introduced "flat storage" — a secondary key-value store that mirrors the trie's leaf layer, eliminating repeated trie traversal on hot reads. Hoarfrost currently traverses its Merkle-Patricia Trie for every state access. Adopting NEAR's flat storage pattern could significantly reduce state-access latency for Midnight's nullifier set and commitment tree lookups.

**Receipt-Based Asynchronous Execution**
*Option 3 — design inspiration*
NEAR's receipt model enforces that cross-contract calls take at least one block, making the asynchronous nature of distributed execution explicit and safe. Midnight's current committed message passing for contract-to-contract communication could be redesigned around a similar explicit-receipt abstraction, making the latency and ordering guarantees of cross-contract calls first-class rather than implementation details.

**Chunk-Only Producers (Lightweight Validator Role)**
*Option 3 — design inspiration*
NEAR introduced "chunk-only producers" — validators that produce shard chunks without validating full blocks, reducing hardware requirements. An analogous role for Midnight could separate proof generation (compute-heavy) from block validation (I/O-heavy), enabling a more diverse and economically accessible validator ecosystem.

**Data Availability Layer (NEAR DA)**
*Option 2 — code reuse*
NEAR has developed a data availability layer for L2 rollups that publishes calldata to NEAR's sharded storage at significantly lower cost than Ethereum. Midnight City, if designed as a rollup, could use NEAR DA as its data availability layer rather than posting data to Cardano or Ethereum, taking advantage of NEAR DA's cost structure and throughput.

**Cold/Warm/Hot State Tiering**
*Option 3 — design inspiration*
NEAR's node architecture distinguishes hot state (recent blocks, fast access), warm state (recent epochs), and cold storage (archival, potentially on external storage). Midnight's growing commitment trees and nullifier sets are a natural fit for a similar tiered approach, with only the most recent additions kept in hot storage and older state moved to cheaper, slower tiers.

---

### 6.3 Account Model and Identity

**Named Account System**
*Option 3 — design inspiration*
NEAR accounts have human-readable names (e.g., `alice.near`) with a hierarchical namespace (e.g., `app.alice.near` as a sub-account). Midnight currently uses cryptographic addresses. A named account layer above Midnight's existing address model could dramatically improve UX for end users, wallet providers, and DApp developers — analogous to ENS on Ethereum but native rather than retrofitted.

**Sub-Accounts as Organizational Units**
*Option 3 — design inspiration*
NEAR's sub-account structure allows organizations to maintain `product.company.near`, `treasury.company.near`, and `governance.company.near` as related but independent accounts. For Midnight, this maps naturally to organizational identity with selective disclosure — a company could have sub-accounts for KYC attestations, treasury, and public-facing contracts, all under a single organizational namespace.

**Function Call Access Keys**
*Option 2/3 — code and design*
NEAR allows accounts to grant restricted signing keys that can only call specified contract methods up to a gas allowance. For Midnight, this pattern enables DApp-specific session keys: a user could authorize a DApp to perform limited actions on their behalf without exposing their master key, a privacy-preserving alternative to the blanket approvals common in EVM wallets.

**Implicit Accounts**
*Option 3 — design inspiration*
NEAR implicit accounts let users receive funds to a public-key-derived address before explicitly creating an account. This reduces onboarding friction — a new Midnight user could receive NIGHT or DUST to an implicit address before going through the full key registration and DUST generation flow.

**Account Abstraction and Meta-Transactions**
*Option 2/3 — code and design*
NEAR supports meta-transactions: a user signs a transaction but a relayer submits and pays gas. For Midnight, this is especially powerful — a relayer could pay DUST on behalf of a user, enabling fully gasless UX for end users while preserving privacy (the relayer cannot see what the user is doing, only that a transaction is being submitted).

---

### 6.4 Economic Design

**30% of Gas to Contract Developers**
*Option 3 — design inspiration*
NEAR distributes 30% of transaction gas fees directly to the developers of contracts that are called. Midnight's current economic model (DUST for gas, NIGHT for staking) does not include a direct developer revenue stream from protocol-level transaction fees. Introducing a similar mechanism would create a sustainable incentive for third-party DApp and contract development on Midnight.

**Storage Staking / State Rent**
*Option 3 — design inspiration*
NEAR charges accounts approximately 1 NEAR per 100KB of state, held as a stake that is returned if the state is deleted. This disciplines state growth without ongoing "rent" payments. Midnight's commitment trees and nullifier sets grow monotonically and unboundedly. A storage-staking model for contract state could incentivize developers to prune stale state and keep overall node storage requirements manageable.

**Gas Price Floor with Dynamic Adjustment**
*Option 3 — design inspiration*
NEAR's gas price adjusts dynamically based on block utilization but has a floor (1 TGas = 0.0001 NEAR). Midnight's DUST model is renewable rather than market-priced. Understanding how NEAR's dynamic floor model has performed under load could inform whether Midnight should introduce any market-rate component to DUST generation or fee pricing.

**Protocol Treasury and Ecosystem Funding**
*Option 3 — design inspiration*
A portion of NEAR's block rewards flows to a protocol treasury for ecosystem grants and development. Midnight could implement a similar mechanism where a portion of NIGHT staking rewards or DUST fees funds a privacy-ecosystem treasury — grants for ZK tooling, bridge integrations, and DApp development.

---

### 6.5 Cross-Chain Interoperability

**OmniBridge Token Factory Pattern**
*Option 2 — code reuse*
NEAR's OmniBridge uses a "token factory" contract that mints bridged representations of foreign tokens on demand. The same pattern — a canonical factory that tracks bridged token metadata and minting authority — could replace or complement Midnight's ad-hoc bridge token management for the growing number of assets (cNIGHT, mNIGHT, USDC, etc.) that need bridged representations.

**Chain Abstraction Layer as a Design Pattern**
*Option 3 — design inspiration*
NEAR's Chain Abstraction Layer separates the user-intent layer from the chain-specific execution layer. Applied to Midnight, this pattern suggests that Midnight could offer a "chain-agnostic" transaction surface: users express what they want (e.g., "swap ETH for NIGHT with privacy") and a solver/relayer network handles the multi-chain execution, hiding chain-specific complexity from the user entirely.

**Intent-Based Transaction Model**
*Option 3 — design inspiration*
NEAR Intents allows users to submit signed statements of desired outcomes (e.g., "I want X of token A → Y of token B") rather than specific transaction instructions. This intent model is more expressive than traditional transactions: it enables batching, partial fills, and solver-network price discovery. Midnight could expose an intent layer above its DUST/ZSwap model for common DeFi operations, making Midnight competitive with intent-based L2s without requiring the full NEAR stack.

**Hub-and-Spoke Bridge Topology**
*Option 3 — design inspiration*
NEAR uses a hub-and-spoke model where NEAR is the hub and all bridged chains are spokes. Cross-chain transfers go through NEAR rather than chain-to-chain. Midnight could adopt this topology using itself as the hub — all cross-chain transactions involving privacy would settle through Midnight, establishing it as a privacy hub in the multi-chain economy rather than a destination chain.

**Relayer Networks as First-Class Infrastructure**
*Option 3 — design inspiration*
NEAR's bridge and intent systems rely on competitive relayer networks rather than trusted validators for cross-chain message forwarding. Adopting this pattern for Midnight's protocol bridge and chain signatures infrastructure would reduce the trust footprint — relayers compete on price and speed rather than being granted protocol-level authority.

---

### 6.6 Consensus and Finality

**Tiered / Probabilistic Finality (Doomslug)**
*Option 3 — design inspiration*
NEAR uses Doomslug for fast probabilistic finality (~1 second) before the slower, deterministic Nightshade finality. Midnight currently uses AURA (block production) + GRANDPA (deterministic finality), with no intermediate probabilistic confirmation. A tiered model could improve UX for applications that can tolerate probabilistic finality (e.g., low-value transfers) while preserving deterministic finality for high-value or irreversible operations.

**Epoch-Based Validator Set Rotation**
*Option 3 — design inspiration*
NEAR uses 12-hour epochs for stable, predictable validator assignment. Midnight's SPO committee structure could adopt a similar epoch model, where validator-set changes are batched to epoch boundaries rather than applied continuously, improving stability and predictability of block production and finality.

**Slashing and Accountability**
*Option 3 — design inspiration*
NEAR has a well-specified slashing model for equivocation and unavailability. Midnight's current SPO model inherits Cardano's soft-accountability model (no on-chain slashing). NEAR's stricter slashing design — applied carefully to Midnight's validator economics — could strengthen security guarantees and improve the credible commitment not to equivocate.

---

### 6.7 Developer Experience and Tooling

**Workspaces / Sandbox Testing Framework**
*Option 2 — code reuse*
NEAR's `workspaces-rs` provides a sandboxed NEAR environment for integration testing, allowing contracts to be deployed and tested against a local node with full state. An analogous tool for Midnight — a sandboxed Midnight environment for Compact contract integration testing — would significantly lower the development friction identified repeatedly in the journal.

**SDK Design: Separation of Read and Write Paths**
*Option 3 — design inspiration*
NEAR's JavaScript SDK cleanly separates view calls (read-only, free, no transaction) from change calls (state-modifying, requires gas). Midnight.js could adopt an analogous explicit separation, making it immediately clear to developers which operations require DUST and which are free — reducing the confusion seen in the current developer documentation.

**Contract Standard Process (NEP-like)**
*Option 3 — design inspiration*
NEAR has a formal standards process (NEAR Enhancement Proposals — NEPs) for defining fungible token, NFT, and other contract-level standards. Midnight lacks a formal process for defining contract interface standards. A Midnight Enhancement Proposal (MEP) process would enable community-driven standardization of ZK-token interfaces, selective-disclosure attestation schemas, and cross-contract interaction patterns.

**Rust SDK with Simulation Testing**
*Option 2 — code reuse*
NEAR's Rust SDK includes a unit-testing simulation mode where contract code runs in-process without a node. The testing infrastructure and design patterns from `near-sdk-rs` could be adapted for Compact or for the Impact interpreter's Rust testing layer.

**Progressive Decentralization of Tooling**
*Option 3 — design inspiration*
NEAR's developer toolchain (CLI, indexer, explorer) is designed to work against both mainnet and local nodes without special configuration. Midnight's tooling — as documented extensively in the journal — requires significant undocumented configuration. NEAR's "works out of the box" design philosophy, especially around node configuration and testnet bootstrapping, is a direct model for Midnight's developer experience investment.

---

### 6.8 Application Delivery and Decentralized Frontends

**NEAR Blockchain Operating System (BOS) / Components**
*Option 3 — design inspiration*
NEAR's BOS enables UI components to be stored on-chain and rendered in browsers, enabling fully decentralized frontends. This pattern closely mirrors Seba's MidnightOS vision — docker-delivered WASM applications served from a decentralized content-addressed store. NEAR's BOS implementation, its component composition model, and its approach to decentralized CDN caching are all directly relevant to MidnightOS design.

**Decentralized Frontend Hosting with Reputation**
*Option 3 — design inspiration*
NEAR's ecosystem has explored reputation-scored frontend hosting, where multiple hosts serve the same frontend and users can verify content hashes. For MidnightOS, a similar reputation-scored delivery network would allow users to trust that the WASM DApp they receive matches what was published by the developer — critical for a privacy platform where a compromised frontend could silently leak private inputs.

**WASM Component Model Integration**
*Option 3 — design inspiration*
Both NEAR's contract execution and Nightstream's container model use WASM as the delivery and execution format. NEAR's experience deploying, versioning, and hot-swapping WASM contract code in a production environment is directly applicable to MidnightOS's WASM component delivery pipeline — especially around code size limits, AOT compilation, and gas/metering integration.

---

### 6.9 Data, Indexing, and Availability

**NEAR Lake Indexing Framework**
*Option 2/3 — code and design*
NEAR Lake streams blocks and receipts to S3-compatible object storage, enabling external indexers to consume blockchain data without running a full node. Midnight's indexer currently requires a direct node connection. Adopting the NEAR Lake pattern — stream to object storage, index asynchronously — would improve indexer resilience and enable a richer ecosystem of third-party analytics tools.

**Selective State Sync**
*Option 3 — design inspiration*
NEAR nodes support selective state sync, where new validators can join by downloading only the current state snapshot rather than replaying the full chain history. For Midnight, this is especially relevant because the ZK commitment trees grow monotonically. A snapshot-based sync mechanism would make new node onboarding tractable as the chain matures.

**Historical Data and Chain Pruning Policy**
*Option 3 — design inspiration*
NEAR validators prune blocks older than 5 epochs (~2.5 days) by default, with archival nodes retaining full history. Midnight currently has no documented pruning policy. Adopting a tiered retention policy — where validators prune old nullifier tree history and only archival nodes retain it — would bound validator storage requirements.

---

### 6.10 Protocol Governance and Upgrade Processes

**Protocol Versioning via Validator Voting**
*Option 3 — design inspiration*
NEAR protocol upgrades are gated by validator voting: a new protocol version activates only when a supermajority of validators have upgraded. This approach avoids hard forks without requiring on-chain governance overhead. Midnight's current upgrade path relies on Substrate's WASM runtime governance model. Comparing NEAR's validator-vote approach against Substrate's governance pallets could surface a simpler upgrade model for Midnight's specific validator structure (SPOs).

**Protocol Treasury and Developer Grants**
*Option 3 — design inspiration*
NEAR allocates a portion of inflation to a protocol treasury administered by the NEAR Foundation for ecosystem grants. A Midnight-native equivalent — funded by a portion of NIGHT issuance — could sustain ongoing grants for ZK tooling, privacy research, bridge integrations, and DApp development without depending on IOHK funding cycles.

**Formal Specification Process**
*Option 3 — design inspiration*
NEAR maintains `nomicon.io`, a formal specification of the NEAR protocol written for implementers. Midnight's protocol is partially specified across dispersed documents (ledger spec, ZKIR spec, etc.) with significant gaps (as documented in the journal). Adopting NEAR's practice of a single, canonical, versioned protocol specification would reduce the documentation friction that has been a recurring onboarding blocker.

---

### 6.11 Privacy-Specific Opportunities (NEAR Design Applied to ZK Contexts)

**Private Solver Networks**
*Option 3 — design inspiration*
NEAR Intents solvers are currently public — they can observe intent contents and potentially extract value. For Midnight, a solver network for cross-chain privacy intents could operate inside TEEs, with solver bids validated via ZK proofs, preventing solver-level front-running and information leakage — a design pattern NEAR has not yet implemented but Midnight is uniquely positioned to pioneer.

**ZK-Verified Access Keys**
*Option 3 — design inspiration*
NEAR's function-call access keys restrict what a key can sign. For Midnight, an analogous "ZK access key" could allow a user to delegate signing authority to a DApp for a specific contract and method, with the constraint enforced by a ZK proof rather than a protocol rule — enabling privacy-preserving delegation where the constraint itself is not visible to validators.

**Shielded Receipts / Private Cross-Contract Calls**
*Option 3 — design inspiration*
NEAR's receipt model makes all cross-contract communication visible on-chain. Adapting the receipt model for Midnight — where receipt contents are encrypted and only the routing metadata is public — could enable private cross-contract composition: one Midnight contract calls another without exposing the call arguments or return values to validators.

**Privacy-Preserving Relayer Incentives**
*Option 3 — design inspiration*
NEAR's meta-transaction relayers are compensated via gas payment from the user's perspective but are exposed to front-running by mempool observers. For Midnight's meta-transaction/relayer model, combining NEAR's relayer economic model with ZK-shielded mempool submissions could create a privacy-preserving relayer market where relayers are compensated without being able to identify or front-run the transactions they submit.

---

## 7. Summary

Substrate is more modular than NEAR by virtually every measure relevant to Midnight's re-platforming question. Its pallet system, forkless runtime upgrades, pluggable consensus, and versioned host API provide the kind of vertical decomposition that supports targeted component replacement. NEAR's modularity is primarily **horizontal** (sharding) and **application-layer** (contract extensibility), with the protocol core being substantially less decomposable.

The most pragmatic interpretation of Charles's three-option framework, given this analysis, is:

- **Option 1** carries the highest risk and offers the fewest modularity benefits for Midnight's specific requirements (ZK-native state, selective disclosure, hybrid UTXO/account ledger).
- **Option 2** should focus narrowly on NEAR's Chain Signatures stack, which is the most architecturally separable NEAR component and directly addresses Midnight's cross-chain custody requirements.
- **Option 3** should focus on NEAR's sharding ideas (Nightshade) as design input for the Midnight City / Paima L2 architecture and on NEAR's Chain Abstraction Layer pattern as design input for Compact-contract-driven cross-chain interoperability.

> 🛑 **BLOCKER (Option 1):** NEAR provides no native ZK proof system. Executing Midnight's Plonk/KZG verification within NEAR's 300 TGas transaction limit is an unvalidated assumption that constitutes a critical feasibility gate for any full re-platforming scenario.

> ⚠️ **RISK (Option 2):** NEAR's Chain Signatures use BN254 (via Sirius) for proof aggregation, while Midnight uses BLS12-381. Any adoption of the NEAR MPC stack must resolve this curve incompatibility, either by implementing Sirius for Midnight or using Midnight's own folding scheme.

> 🏛️ **ADR candidate:** Given the modularity evidence, Option 2 (take Chain Signatures software) combined with Option 3 (take sharding and chain abstraction ideas) appears to dominate Option 1 on cost/risk grounds and should be the default recommendation unless a specific capability gap requires full re-platforming.

## Sources

- [`cait-sith` threshold ECDSA library](https://github.com/cronokirby/cait-sith)
- [nearcore — NEAR Protocol node implementation](https://github.com/near/nearcore)
- [NEAR MPC / Chain Signatures contract](https://github.com/near/mpc)
- [NEAR nomicon — protocol specification](https://nomicon.io)
- [NEAR developer documentation](https://docs.near.org)
- background/midnight-architecture.md — internal Midnight architecture reference
- background/roadmap.md — internal Midnight roadmap reference (Hua 3.0, Jolteon)
- background/mpc-chain-signatures-summary.md — internal MPC and chain signatures summary
- background/NearFall_Technical_Specification_v4_2.pdf — internal NearFall technical specification

---

## Afterword: Quality Scrutiny

### 1. Sources Correspond to Retrievable URLs

- **The document contains no `## Sources` section**, violating the AGENTS.md convention.
- The document references "the project background" for the "major surgery" characterization and "the NearFall Technical Specification" for ProtoGalaxy k-folding, without citing file paths or URLs for either. Both are internal documents.
- The journal is cited inline twice but without specific entry dates or anchors.
- Of the NEAR-specific claims checked, all were verifiable through NEAR's public documentation and GitHub repositories, though the specific URLs are not cited:
  - `cait-sith`: `github.com/cronokirby/cait-sith` (accessible) ✅
  - 30% gas to contract developers: confirmed via NEAR docs ✅
  - Storage staking 1 NEAR per 100 KB: confirmed (`1E19 yoctoNEAR per byte` ≈ 1 NEAR / 100 KB) ✅
  - 5-epoch / 2.5-day pruning window: confirmed ✅
  - NEAR Lake / S3-compatible storage: confirmed ✅
  - Chunk-only producers as Nightshade feature: confirmed ✅
- The Midnight-specific claims (AURA + GRANDPA + BEEFY/MMR, Jolteon in Hua 3.0, Hoarfrost O(1) cloning, ZSwap BLS12-381/JubJub/Plonk/KZG) are all corroborated by `background/midnight-architecture.md` and `background/roadmap.md`, which are internal documents.
- The BN254/Sirius claim in the RISK note (§7) comes from internal background documents and was not independently verified against a public NEAR source in this review.

### 2. Internal Consistency

- The core comparative sections (§1–§5) are internally consistent and the assessments (✅/⚠️/❌) follow logically from the stated criteria.
- **Shard count discrepancy.** Section 3.4 states NEAR has "Currently 4+ shards." The companion assessment `midnight-vs-near-tps.md` (this repository) uses "9 shards" for the same "current mainnet" scenario. Both cannot be correct for the same date; the documents likely reflect different points in NEAR's Nightshade 2.0 rollout and the discrepancy should be reconciled.
- **Cross-shard latency.** Section 3.4 states "~1 second per shard hop via receipt routing" for NEAR. `midnight-to-near-mapping.md` states "one block of latency per hop." At NEAR's ~1-second block time these are consistent; at ~600ms block time (as stated in `midnight-vs-near-tps.md`) the figures diverge slightly.
- **Section 6 is explicitly speculative** and is self-labelled as "intentionally expansive and divergent" for stakeholder review, not a narrowed recommendation. This framing is applied consistently throughout the section.
- The BLOCKER note (§7) correctly flags the 300 TGas ZK verification constraint as "unvalidated" and treats it as a gate rather than a solved problem, consistent with how it is treated in other assessments.

### 3. Accuracy Against Sources

- **"NEAR's `cait-sith` library"** (§6.1) — ⚠️ Attribution imprecision. `cait-sith` was created by an independent developer (github.com/cronokirby/cait-sith), not by NEAR. NEAR built `near/threshold-signatures` on top of it and integrates it in the `near/mpc` project. The library is standalone with no `nearcore` dependency — this part is correct. The phrase "NEAR's `cait-sith` library" implies NEAR authorship, which is inaccurate; "the `cait-sith` library used by NEAR" would be precise.
- **"`cait-sith` implements threshold-ECDSA and threshold-Schnorr"** (§6.1) — ⚠️ Partially accurate. `cait-sith` itself implements threshold ECDSA via Beaver triples. Threshold-Schnorr is implemented in NEAR's `near/threshold-signatures` extension, not in `cait-sith` itself. Attributing both to `cait-sith` overstates the scope of the base library.
- **"Doomslug/TPoS consensus mechanism"** (§3.1) — ⚠️ Terminology note. "Doomslug" is NEAR's standard name for its block production mechanism. "TPoS" (presumably Threshold Proof-of-Stake or Thresholded PoS) is not standard NEAR documentation terminology and is not used in NEAR's own specification (`nomicon.io`). The slash-joined term may cause confusion.
- **BN254 (via Sirius) for NEAR Chain Signatures proof aggregation** (§7 RISK note) — ❓ Unverified externally. This claim comes from internal background documents (`background/mpc-chain-signatures-summary.md`) and was not confirmed against a public NEAR source during this review. Sirius is a BN254-based folding scheme; whether NEAR's current Chain Signatures deployment uses it specifically warrants external confirmation before treating the curve incompatibility as an established risk.
- **All Midnight-specific architectural claims** (consensus stack, Jolteon/Hua 3.0, Hoarfrost, ZSwap curves) — ✅ Corroborated by internal `background/` documents which are themselves sourced from official Midnight documentation.
- **NEAR Lake S3, chunk-only producers, storage staking, 30% gas, epoch/pruning parameters** — ✅ All verified against public NEAR documentation.

### 4. Areas of Greatest Uncertainty

- **BN254/Sirius curve incompatibility** — The RISK note in §7 is load-bearing for Option 2 evaluation (it implies the Chain Signatures stack cannot be adopted without curve-bridging work), yet the underlying claim is sourced only internally and not verified externally.
- **NEAR current shard count** — The "4+ shards" vs "9 shards" discrepancy across two companion documents means one or both figures is wrong; the correct number affects throughput and storage estimates cited across the repository.
- **Section 6 opportunity catalogue** — The 34 opportunities listed across §6.1–§6.11 are almost entirely unsourced. Many are well-motivated design analogies, but specific implementation claims (e.g., "NEAR BOS enables UI components to be stored on-chain," "NEAR's DKG protocol separates key generation epochs from signing epochs") are stated as facts without citations. The design-thinking framing mitigates this, but readers drawing on individual items should independently verify before acting on them.
- **"NearFall Technical Specification"** — Referenced in §6.1 for ProtoGalaxy k-folding and in §6.3 for TEE+MPC hybrid, but no path or URL is provided for this document. It is unclear whether it is an internal document, a draft specification, or a separate deliverable.
- **Option 3 "receipt-based async execution inspires cross-contract messaging design"** (§5) — The claim in `contract-to-contract-calls.md` (another repository assessment) is that Midnight already supports synchronous intra-transaction C2C calls, so NEAR's receipt model is not "filling a gap" but representing a different tradeoff. These two assessments have compatible but divergent framings that are not cross-referenced.

### 5. Robustness of Primary Conclusions

The document's primary conclusions are:

1. *Substrate is more modular than NEAR by every measure relevant to Midnight's re-platforming question.* **Robust.** The six-dimension comparison is systematic, and all factual underpinnings (AURA/GRANDPA pluggability, no FRAME equivalent in NEAR, forkless WASM upgrades) are corroborated. The conclusion holds even granting NEAR's genuine advantages in horizontal scaling and Chain Abstraction Layer extensibility.

2. *Option 1 (full port) carries the highest risk; the 300 TGas ZK verification limit is a critical feasibility gate.* **Robust.** The 300 TGas limit is verified from NEAR documentation. Its implication for ZK proof verification is correctly flagged as unvalidated rather than asserted as blocking — an appropriately conservative framing.

3. *Option 2's best candidate is Chain Signatures (cait-sith/FROST stack).* **Moderately robust.** The architectural separability of Chain Signatures is well-supported. The one qualification is that the curve incompatibility (BN254 vs BLS12-381) is cited as a RISK but its severity is based on unverified internal claims; if BN254/Sirius is not actually used, the integration path may be simpler than stated.

4. *Option 3's best candidates are Nightshade sharding (for L2 design) and Chain Abstraction Layer (for cross-chain UX).* **Moderately robust.** These are design-inspiration claims that do not depend on any quantitative figures and are plausible on architectural grounds. Their robustness is limited primarily by the absence of a competing analysis of what alternatives exist for Midnight's L2 architecture.

Overall this is one of the better-evidenced assessments in the repository: the core architectural comparison is systematic, the NEAR-specific factual claims are accurate, and the conclusions are calibrated (blocker vs. risk vs. ADR candidate). The main quality gaps are the missing Sources section, the cait-sith attribution imprecision, the unverified BN254/Sirius claim that underpins the curve-incompatibility RISK, and the shard-count inconsistency with companion assessments.
