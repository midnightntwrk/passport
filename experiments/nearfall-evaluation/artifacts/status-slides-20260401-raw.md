---
title: MidnightOS Status
subtitle: NEARFall Feasibility Study — Project Increment 1
author: IOG/ARC
date: 1 April 2026
---

# Agenda

## Goals for This Meeting

1. Discuss scope and goals
   - Why NEAR? — Charles's motivations and the three options
   - Timeline — 100-day double-diamond engagement plan
2. Summarize the last four weeks of work
   - Experiments — 8 hands-on prototypes across Midnight, NEAR, Starstream, and Paima
   - Technical assessments — key management, modularity, state mapping, throughput
3. Collect candid feedback on progress so far
   - Assessment scope — what was covered and what was not started or deferred
4. Plan tighter collaboration, course corrections, and next increment
   - Discussion — open floor

# Why NEAR?

## Goals for the Evaluation

| Goal | Description | Note |
|------|-------------|------|
| **Key management** | NEAR's key system as a model for Midnight identity | |
| **Chain abstraction** | Derive keys for Cardano, Ethereum, Solana, etc. from a single root key | |
| **TPS gains** | NEAR's networking layer could improve Midnight throughput | ⚠️ Pushback: bottleneck is block size, not protocol |
| **TEE privacy** | NEAR's heavy TEE use as a fast path to adding privacy | |
| **Midnight OS platform** | NEAR as the substrate for Starstream, Nightstream, and Paima | Major surgery if pursued as full port |
| **Feature identification** | Identify NEAR capabilities that could benefit Midnight regardless of platform choice | Relevant under all three options |

# Three Options

## How Far Do We Go with NEAR?

| Option | Description | Cost |
|--------|-------------|------|
| **1 — Port** | Full re-platforming onto the NEAR stack | Very high |
| **2 — Take Software** | Extract specific NEAR components (e.g. `cait-sith` MPC, FROST DKG) | Medium–high |
| **3 — Take Ideas** | Rebuild NEAR-inspired patterns natively in Substrate | Medium |

All three paths remain in scope.

- **Option 1** reflects Charles's direction; it is the cost/risk ceiling.
- **Options 2 and 3** may offer better risk-adjusted returns.
- Without a **ledger migration**, Option 1 cannot proceed — and migration is itself a massive technical risk.

# Timeline

## Double Diamond — 100 Days from 12 March 2026

| Diamond | Phase | Days | Dates | Focus |
|---------|-------|------|-------|-------|
| 1 — Foundation | **Discover** ← *today* | 1–25 | Mar 12 – Apr 5 | Broad exploration of the problem space |
| 1 — Foundation | **Define** | 26–50 | Apr 6 – Apr 30 | Narrow to key constraints and opportunities |
| 2 — Architecture | **Develop** | 51–75 | May 1 – May 25 | Generate and prototype solution options |
| 2 — Architecture | **Deliver** | 76–100 | May 26 – Jun 16 | Converge on architectural recommendations |

Repository: <https://github.com/input-output-hk/arc-nearfall-evaluation>

Findings, experiments, and a daily journal written for LLM-assisted analysis are maintained there throughout the engagement.

# Experiments

## What We Have Built and Tested

| Experiment | Platform | Key Finding |
|------------|----------|-------------|
| `test-contract-1` | Midnight preprod | Basic wallet operations (mnemonic → sync → transfer) work end-to-end; documentation is incomplete and partly obsolete |
| `midnight-env` | Midnight preprod | Node deployment requires piecing together multiple outdated sources; official docs are incorrect in several aspects |
| `node-lan` | Midnight (local 7-node cluster) | Consensus is fragile: nodes self-equivocated even with distinct keys; BEEFY keys cannot be pre-loaded — must be inserted after the pallet comes online |
| `shielding-contracts` | Midnight preprod | Shielded mint and transfer work, but the SDK has multiple non-obvious bugs requiring workarounds (notably a WASM panic in `ZswapChainState.tryApply`) |
| `compact-named-accounts` | Midnight preprod | Stealth meta-address registry works end-to-end; however, publishing the ephemeral key on-chain leaks payment events — neither path provides full graph privacy |
| `near-exploration` | NEAR testnet | NEAR developer tooling is significantly smoother than Midnight's; account creation, contract deployment, and RPC node setup all work with minimal friction |
| `starstream-compile` | Starstream (local) | Starstream compiler produces valid WASM from `.star` source; the language is functional but early-stage |
| `paima-game-templates` | Paima engine | Paima is a real, usable multi-chain rollup engine; templates are game/app oriented, not ZK-proof-based settlement |

# Assessment Scope

## What Was and Was Not Assessed

| Area | Status | Note |
|------|--------|------|
| **Key management** | Explored | Capability survey and initial Midnight applicability analysis |
| **Modularity** | Explored | Substrate vs. NEAR comparison; findings preliminary |
| **Throughput** | Explored | TPS constraints, Substrate techniques, NEAR vs. Midnight comparison |
| **Feature identification** | Explored | Catalogue of NEAR capabilities potentially applicable to Midnight across all three options |
| TEE integration | Not yet started | Flagged as a Charles motivation; referenced in feature catalogue but no independent analysis undertaken |
| Chain signatures | Not yet started | Referenced throughout; no independent analysis undertaken |
| Starstream / Nightstream | Experiment only | Compiler experiment run; architecture documented from public sources; no deep analysis |
| Paima | Experiment only | Template exploration run; architecture documented from public sources; no deep analysis |

# Assessments

## Technical Deep-Dives

| Assessment | Topic | Key Finding |
|------------|-------|-------------|
| `midnight-pallets` | Architecture | Midnight combines standard Substrate pallets with custom ones (Kachina, Dust, Minotaur) for ZK verification, fee batteries, and Cardano anchoring |
| `modularity-comparison` | Architecture | Substrate is more modular than NEAR on virtually every axis; Option 1 (full port) carries highest risk due to unvalidated 300 TGas ZK-verification limit |
| `contract-to-contract-calls` | Architecture | Midnight supports synchronous intra-transaction contract calls; NEAR uses asynchronous inter-block receipts — a fundamental architectural difference |
| `midnight-to-near-mapping` | State mapping | Per-UTXO/note accounts (Options A/B) rank highest for throughput; coarse-grained options shift the 500+ TPS problem entirely to a bespoke off-chain sequencer |
| `midnight-vs-near-tps` | Throughput | Midnight's binding constraint is block size, not proof verification; 500+ TPS is achievable within Substrate via block-size increases and proof folding |
| `substrate-throughput-techniques` | Throughput | No existing Substrate chain demonstrates >50 TPS for ZK-proof-bearing transactions; Midnight as a parachain with async backing and folding could reach 750–1,000 TPS |
| `throughput-constraint-comparison` | Throughput | NEAR and Midnight have inverse architectures: NEAR is overhead-heavy with per-shard parallelism; Midnight is payload-efficient with no horizontal scaling |
| `near-key-management` | Cryptography | NEAR uses human-readable hierarchical accounts with multiple fine-grained access keys per account, stored directly in the state trie |
| `near-scheduling` | Validator ops | NEAR's multi-role validator model distributes load finely but requires significantly higher hardware (48 GB RAM, 2–3 TB storage) than Midnight validators |
| `starstream-nightstream` | Execution/proving | Starstream provides UTXO-native WASM execution via coroutines; Nightstream is post-quantum lattice IVC; together they form MidnightOS, but the Nightstream outer SNARK is still WIP *(based on public sources and compiler experiment — no deep analysis)* |
| `paima-on-midnight` | Integration | Paima can run on Midnight's public layer with moderate effort; privacy integration via ZK attestations is hard due to tension between deterministic re-execution and private state *(based on public sources and template experiment — no deep analysis)* |

# Key Management

## Key Management Capabilities — Definitions

| Capability | Definition |
|------------|------------|
| **Named accounts** | Human-readable string account IDs (e.g. `alice.near`) with a hierarchical namespace; a parent account controls creation of sub-accounts (e.g. `app.alice.near`) |
| **FullAccess keys** | Root keypair with authority over all account operations including key rotation, contract deployment, and fund transfer; loss is catastrophic |
| **FunctionCall / session keys** | Scoped keypair restricted to a specific contract and method set with an optional NEAR spending allowance; isolates the root key from day-to-day dApp interaction |
| **DelegateAction / meta-tx** | User signs an inner transaction payload; a relayer wraps it in an outer transaction and pays the gas; enables gasless onboarding without trusting the relayer with the user's key |
| **HD key derivation** | Hierarchical deterministic derivation of an account keypair from a BIP-39 master seed; in NEAR all paths are hardened (Ed25519 limitation), so only the wallet layer benefits — no on-chain derivation |
| **Implicit accounts** | Account ID is the hex-encoding of an Ed25519 or secp256k1 public key; the account can receive funds before it is explicitly initialised on-chain, simplifying exchange deposits |
| **Promise-based key mgmt** | Contracts can add or delete keys on their *own* account as a promise action; enables social recovery contracts, DAO-controlled custody, and factory-deployed sub-accounts |
| **Chain signatures / MPC** | Threshold MPC network (FROST / `cait-sith`) that holds a distributed key and signs transactions on *other* chains (Ethereum, Bitcoin, etc.) on behalf of a NEAR account; cross-chain execution without bridging assets |

## NEAR Key Capabilities

*(11 columns — may need splitting in Google Slides)*

| Capability | User Value | Corp/Finance Value | App Areas | Implementation Locus | Usage Freq. | Fundamental vs. Cosmetic | NEAR Fit | Security Posture | On-Chain Complexity | Off-Chain Complexity |
|---|---|---|---|---|---|---|---|---|---|---|
| Named accounts | ★★★★★ | ★★★★ | All | Protocol | Universal | Fundamental | High | Unicode homoglyphs eliminated; 0/o and 1/l still confusable | Low | Low |
| FullAccess keys | ★★★ | ★★★ | All | Protocol | Universal | Fundamental | High | Catastrophic if lost | Low | Low |
| FunctionCall keys | ★★★★★ | ★★★★ | dApps, DeFi, enterprise | Protocol | High | Fundamental | High | Scoped blast radius | Low | Low |
| DelegateAction / meta-tx | ★★★★ | ★★★★ | Onboarding, all | Protocol + relayer | Growing | Fundamental | High | Relayer trust | Medium | Medium |
| Validator / node keys | — | — | Infrastructure | Protocol + node | Universal (validators) | Fundamental | High | Key separation sound | Low | Low |
| ETH-implicit accounts | ★★★ | ★★★ | EVM interop | Protocol + contract | Moderate | Ad-hoc | Low | Contract bug surface | High | Medium |
| Secp256k1 access keys | ★★ | ★★★ | Institutional, cross-chain | Protocol | Low | Cosmetic | Low | Gas-cost penalty | Low | Low |
| HD key derivation | ★★★★ | ★★★ | All wallets | Wallet only | Universal | Fundamental | High | No public child keys | None | Low |
| Ed25519 implicit accounts | ★★★ | ★★ | Onboarding, exchanges | Protocol | Moderate | Useful | Moderate | Refund receipt footgun | Low | Low |
| Promise-based key mgmt | ★★ | ★★★ | Recovery, DAO, factory | Protocol (contract-invoked) | Moderate | Fundamental | High | Self-only restriction sound | Medium | Medium |
| Multi-sig contract | ★★ | ★★★★ | Treasury, DAO, custody | Contract | Moderate | Useful | Moderate | Contract bug risk | Medium | Medium |
| Chain Signatures / MPC | ★★★★★ | ★★★★★ | Cross-chain DeFi, custody, bridges | Protocol + MPC network | Growing | Fundamental | High | Small committee; curve mismatch | High | High |
| Key enumeration (public) | N/A | N/A | — | Protocol | Universal | (Privacy liability) | Low | Privacy deficit | None | None |
| NEP-413 signed message | ★★★★ | ★★★ | Auth, Web3 login | Standard + wallet | Growing | Fundamental | High | Strong; FullAccess-only gap | Low | Low |
| FastAuth / email recovery | ★★★★ | ★★ | Onboarding | Off-chain relay | Moderate | Useful | Moderate | Centralization trade-off | None | High |

## Applicability to Midnight

*Off-chain / Contract / Ledger costs are **alternative integration approaches**, not additive — choose one level; lower levels avoid protocol changes.*

| Capability | Midnight has it? | Off-chain cost | Contract cost | Ledger cost | Philosophy fit | Privacy impact | Security impact |
|---|---|---|---|---|---|---|---|
| Named accounts | No | Low | Moderate | High | Poor | High degradation | Neutral |
| FullAccess keys | Yes (equivalent) | — | — | — | High | Avoid public key events | Neutral |
| FunctionCall / session keys | No | Moderate | Moderate-high | Very high | High (redesign for ZK) | Enhancement if ZK-private | High improvement |
| DelegateAction / meta-tx | No | Moderate | Moderate | High | High | Low risk (public layer) | Low risk |
| HD key derivation | Wallet-layer only | Very low | N/A | N/A | High | Enhancement (diversified addrs) | High improvement |
| Implicit accounts | No | Low (voucher alt.) | Moderate | High | Poor | High degradation | Introduces footgun |
| Promise-based key mgmt | No | N/A | High | Very high | High (redesign for ZK) | Enhancement if ZK-private | High improvement |
| Chain signatures / MPC | No (bilateral Cardano only) | High (MPC infra) | Moderate (interface) | Very high | Very high | Enhancement (private requests) | BN254/BLS12-381 to clarify |

# Modularity

## Design Philosophies

| Attribute | Substrate / Midnight | NEAR Protocol |
|-----------|---------------------|---------------|
| **Stated goal** | Modular blockchain framework | High-performance sharded L1 |
| **Primary modularity axis** | Vertical component decomposition (pallets) | Horizontal state decomposition (sharding) |
| **Codebase structure** | Framework (`substrate`) + application (`midnight-node`) | Monolithic (`nearcore`) + contract layer |
| **Customization model** | First-class: swap pallets, runtimes, consensus | Second-class: extend via smart contracts only |
| **Core design tension** | Modularity vs. performance | Performance vs. customizability |

## Layer Decomposition

*To be formatted side-by-side in Google Slides.*

```
Substrate / Midnight                     NEAR Protocol
┌────────────────────────────────────┐   ┌────────────────────────────────────┐
│ Application Layer                  │   │ Chain Abstraction Layer            │
│  Hoarfrost · ZSwap · Impact ·      │   │  NEAR Intents · Chain Signatures · │
│  Compact · ZKIR                    │   │  OmniBridge                        │
├────────────────────────────────────┤   ├────────────────────────────────────┤
│ FRAME Pallet Layer                 │   │ Runtime Layer                      │
│  Consensus · Session · Staking ·   │   │  WASM Contract Execution ·         │
│  Sudo                              │   │  Gas Metering · Account Mgmt ·     │
├────────────────────────────────────┤   │  Receipt Processing                │
│ Substrate Runtime                  │   ├────────────────────────────────────┤
│  WASM Runtime · SCALE Encoding ·   │   │ Blockchain Layer                   │
│  Host API                          │   │  Nightshade Consensus · Sharding · │
├────────────────────────────────────┤   │  Networking · Block/Chunk          │
│ Substrate Client                   │   │  Production · State Sync           │
│  Networking · RPC · Block Import   │   │                                    │
└────────────────────────────────────┘   └────────────────────────────────────┘
```

## Consensus Pluggability

| | Substrate / Midnight | NEAR |
|---|---|---|
| **Mechanism** | Independent pallets (AURA, BABE, GRANDPA, BEEFY) | Integrated Nightshade/Doomslug — not swappable |
| **Swap cost** | Low: reconfigure FRAME, recompile | Very high: fork `nearcore` |
| **Midnight example** | Replacing GRANDPA with Jolteon (planned, contained) | N/A |
| **Assessment** | ✅ Genuinely modular | ❌ Monolithic |

## Runtime / Execution Pluggability

| | Substrate / Midnight | NEAR |
|---|---|---|
| **Mechanism** | WASM runtime, forkless upgrades via on-chain governance | WASM contract execution within fixed runtime |
| **Upgrade path** | Runtime logic upgradeable without hard fork | Protocol upgrades require node software release |
| **Custom VMs** | Possible: new pallet can introduce new host functions | Not supported at protocol level |
| **Midnight example** | `Impact` interpreter lives in WASM runtime, upgradeable | An `Impact`-equivalent would be a gas-constrained WASM contract |
| **Assessment** | ✅ Strong forkless upgrade path | ⚠️ Contract-layer extensible; protocol-layer rigid |

## State Storage Pluggability

| | Substrate / Midnight | NEAR |
|---|---|---|
| **Storage model** | SCALE-encoded Merkle-Patricia Trie; Hoarfrost wraps it | Merkle Patricia Trie, partitioned by shard |
| **State isolation** | Single global trie (no native sharding) | Per-shard tries composing a global trie |
| **Custom state structures** | Possible via pallet storage items and host API | Fixed per-account key-value store |
| **ZK-specific state** | Hoarfrost adds commitment trees, nullifier sets, O(1) cloning | Not natively supported; would require contract-level state |
| **Assessment** | ✅ Extensible via host API versioning | ⚠️ Rigid per-account model; ZK structures non-trivial to add |

## Scaling Model

| | Substrate / Midnight | NEAR |
|---|---|---|
| **Native approach** | Single-shard L1; scaling via co-chains and L2 (Midnight City via Paima) | Native sharding: Nightshade splits state/execution across shards |
| **Shard count** | N/A at L1; co-chains are separate Substrate nodes | Currently 4+ shards, planned to scale dynamically |
| **Cross-shard latency** | N/A at L1; co-chain settlement adds multi-block latency | ~1 second per shard hop via receipt routing |
| **State partitioning** | Manual (each co-chain has its own state) | Automatic (accounts assigned to shards by ID) |
| **Assessment** | ⚠️ Scaling requires explicit co-chain architecture | ✅ Native; sharding is a first-class protocol feature |

## Cross-Chain / Interoperability Extension

| | Substrate / Midnight | NEAR |
|---|---|---|
| **Bridge model** | BEEFY + MMR light-client proofs; protocol bridge pallet | OmniBridge; hub-and-spoke; Chain Signatures (MPC threshold) |
| **Chain Signatures** | Planned (MCS): external service backed by Compact contracts | Native: NEAR MPC contract (`v1.signer`) using `cait-sith`/FROST |
| **Extensibility** | New bridge pallets; requires Substrate expertise | New signature schemes deployable as contracts without fork |
| **Assessment** | ⚠️ Capable but requires pallet development | ✅ Chain Signatures are the most portable NEAR component |

## Application / Contract Layer Extensibility

| | Substrate / Midnight | NEAR |
|---|---|---|
| **Extension mechanism** | New FRAME pallets (Rust, compile-time) | Smart contracts (WASM, runtime-deployed) |
| **Deployment friction** | High: requires node software update and governance | Low: contracts deployed permissionlessly |
| **Gas / resource model** | DUST (renewable, generated from staked NIGHT) | 300 TGas/tx limit; 30% of gas fees to contract developers |
| **Privacy integration** | First-class: ZK proofs verified in transaction kernel | Not native; ZK verification must fit within gas limits |
| **Assessment** | ✅ Native ZK support at protocol level | ⚠️ ZK within gas constraints is an unvalidated assumption |

## Where NEAR Is Less Modular than Substrate

- **Consensus is not extractable.** Nightshade is deeply integrated into `nearcore`'s block production and shard management — it cannot run independently.
- **No pallet equivalent.** There is no standard mechanism for extending the NEAR protocol with new host functions, state types, or transaction variants without forking `nearcore`.
- **Protocol upgrades require node releases.** Unlike Substrate's forkless WASM runtime upgrades, NEAR protocol changes require all node operators to upgrade software.

## Where NEAR Has Genuine Modularity Advantages

*The previous slide's rigidity applies to the NEAR **protocol layer**. The contract and library layers are a different story:*

- **The Blockchain/Runtime split is clean and enforced.** The runtime is unaware of sharding; the blockchain layer is unaware of business logic — these two components could in principle evolve somewhat independently.
- **Chain Signatures are architecturally separable.** The MPC contract (`v1.signer`) runs as an ordinary NEAR contract; the `cait-sith`/FROST library can be taken and run independently. **Strongest candidate for Option 2.**
- **Intents/Chain Abstraction Layer is contract-native.** Implemented as smart contracts rather than protocol modifications, the Intents architecture pattern is independently portable without forking `nearcore`.

## Implications for the Three Options

| Option | Modularity Assessment | Key Risks |
|--------|-----------------------|-----------|
| **1 — Port to NEAR** | ⛔ Entire application layer must be rebuilt within NEAR's WASM gas constraints; Midnight's ZK, state (Hoarfrost), and consensus have no NEAR equivalents | Ledger migration; ZK within 300 TGas limit; loss of forkless upgrades; bespoke `nearcore` fork required |
| **2 — Take Software** | ✅ Best candidates: Chain Signatures (`cait-sith`/FROST), NEAR SDK (WASM tooling), OmniBridge relayer logic — all have clean external interfaces and do not require running `nearcore` | Substrate host API integration; curve compatibility (BN254 vs. BLS12-381) |
| **3 — Take Ideas** | ✅ Best candidates: Nightshade sharding model (Midnight City / Paima L2 design); receipt-based async execution; Chain Abstraction Layer pattern | None structural; depends only on engineering judgment |

> 🛑 **BLOCKER (Option 1):** Executing Midnight's Plonk/KZG verification within NEAR's 300 TGas transaction limit is an unvalidated assumption — a critical feasibility gate for any full re-platforming.

> ⚠️ **RISK (Option 2):** NEAR Chain Signatures use BN254 (via Sirius) for proof aggregation; Midnight uses BLS12-381. Any adoption of the NEAR MPC stack must resolve this curve incompatibility.

> 🏛️ **ADR candidate:** Option 2 (take Chain Signatures software) combined with Option 3 (take sharding and chain abstraction ideas) appears to dominate Option 1 on cost/risk grounds.

## NEAR Archival Storage: Snapshot Dominance

❓ **Caveat:** Storage figures below are LLM-generated estimates (March 2026); no primary source has been verified.

| Storage category | Mainnet archival | Testnet archival | Notes |
|-----------------|-----------------|-----------------|-------|
| **Total** | ~118 TB | ~16 TB | Split-storage architecture (nearcore 1.35.0+) |
| Cold storage | ~115 TB | ~15 TB | Spinning disk / cheap persistent volumes |
| Hot storage | ~3 TB SSD | ~1.5 TB SSD | Recent epochs; fast random access |
| **Transaction/receipt data** | **~5–10 TB** | — | ~1–2 KB/tx × 5.25 B transactions |
| **State snapshot overhead** | **~108–113 TB** | — | **Dominant cost — not transaction history** |

**Why so large?** NEAR stores a full snapshot of the state trie for every shard at every epoch boundary (~12 snapshots/day across 6 shards). Each snapshot captures all account balances, contract code, and contract storage. Popular contracts alone can reach hundreds of GB of state. This is a **storage-for-latency tradeoff**: pre-computed snapshots allow historical queries in milliseconds rather than hours of replay.

**Per-transaction ratio:** ~22 KB of archival storage per transaction, of which only ~1–2 KB is the transaction itself.

**Implications for Midnight:** Midnight's monotonically growing ZK commitment trees and nullifier sets exhibit the same structural pressure. Adopting NEAR's tiered retention policy — validators prune state older than 5 epochs (~2.5 days), archival nodes retain full history — would bound validator storage requirements. State-sync snapshots make new node onboarding tractable without full history replay.

## Cryptography and Threshold Security

*"Option" column refers to the three main options: 1 = Port to NEAR, 2 = Take Software, 3 = Take Ideas. Applies to all feature-catalogue slides.*

| Item | Option | Design Inspiration | Rationale for Midnight |
|------|--------|--------------------|------------------------|
| MPC / FROST threshold signing (`cait-sith`) | 2 | Standalone Rust library for threshold-ECDSA and threshold-Schnorr | Directly powers Midnight Chain Signatures (MCS) without building a new MPC stack |
| FROST distributed key generation | 2/3 | Key-generation epochs separate from signing epochs; proactive re-sharing | Applicable to Midnight committee bridge and validator key management |
| TEE + MPC hybrid attestation | 3 | TEE as execution environment; MPC as trust anchor preventing enclave-forking | Generalise across proof-server, prover network, and sequencer — not only Intents *(pattern identified; no independent TEE analysis undertaken this increment)* |
| Threshold BLS signatures for consensus | 3 | Single aggregated BLS signature per finalized block | Reduces on-chain proof sizes for light clients and bridges |
| Hierarchical key derivation for multi-chain addresses | 2/3 | Account + derivation path → child key per target chain | Single Midnight identity key generating address credentials for Cardano, Ethereum, Solana |

## Scalability and State Architecture

| Item | Option | Design Inspiration | Rationale for Midnight |
|------|--------|--------------------|------------------------|
| Nightshade sharding for L2 design | 3 | Global state trie partitioned into independently-executed chunks; cross-shard via receipts | Design input for Midnight City / Paima L2 cross-domain state transitions |
| Flat storage for trie performance | 2/3 | Secondary KV store mirroring trie leaf layer; eliminates trie traversal on hot reads | Reduces state-access latency for nullifier set and commitment tree lookups in Hoarfrost |
| Receipt-based asynchronous execution | 3 | Cross-contract calls explicitly take at least one block | Redesign Midnight contract-to-contract messaging with first-class ordering guarantees |
| Chunk-only producers | 3 | Validators produce shard chunks without validating full blocks | Separate proof generation (compute-heavy) from block validation (I/O-heavy) |
| NEAR DA (data availability layer) | 2 | Calldata published to NEAR sharded storage at low cost | DA layer for Midnight City rollup; lower cost than Ethereum |
| Cold / warm / hot state tiering | 3 | Node storage tiered by recency; cold state on cheap media | Bounds validator storage as commitment trees and nullifier sets grow monotonically |

## Account Model and Identity

| Item | Option | Design Inspiration | Rationale for Midnight |
|------|--------|--------------------|------------------------|
| Named account system | 3 | Human-readable IDs (e.g. `alice.near`) with hierarchical namespace | Improve UX for wallets and DApps — analogous to ENS but native; significant privacy trade-off (see Key Management applicability table for full cost/philosophy analysis) |
| Sub-accounts as organisational units | 3 | `treasury.company.near`, `payroll.company.near` as related independent accounts | Organisational identity with selective disclosure; maps to enterprise use cases |
| Function call access keys (session keys) | 2/3 | Restricted signing keys scoped to specific contract + method set with spending cap | DApp-specific session keys; privacy-preserving alternative to blanket approvals |
| Implicit accounts | 3 | Account ID = hex-encoded public key; receivable before on-chain creation | Reduce onboarding friction — receive NIGHT/DUST before full key registration |
| Account abstraction / meta-transactions | 2/3 | User signs intent; relayer submits and pays gas without seeing private content | Fully gasless UX for end users while preserving privacy |

## Economic Design

| Item | Option | Design Inspiration | Rationale for Midnight |
|------|--------|--------------------|------------------------|
| 30% of gas fees to contract developers | 3 | Protocol distributes 30% of transaction gas fees to called contract developers | Create sustainable incentive for third-party DApp and contract development on Midnight |
| Storage staking / state rent | 3 | ~1 NEAR per 100 KB of state held as returnable stake | Incentivise pruning of stale state; bound node storage for growing commitment trees |
| Dynamic gas price floor | 3 | Gas price adjusts by block utilisation with a market-rate floor | Informs whether Midnight should introduce a market-rate component to DUST pricing under load |
| Protocol treasury and ecosystem funding | 3 | Portion of block rewards flows to a treasury for ecosystem grants | Portion of NIGHT issuance funding grants for ZK tooling, privacy research, bridge integrations |

## Cross-Chain Interoperability

| Item | Option | Design Inspiration | Rationale for Midnight |
|------|--------|--------------------|------------------------|
| OmniBridge token factory pattern | 2 | Canonical factory contract minting bridged token representations on demand | Replace/complement ad-hoc bridge token management for cNIGHT, mNIGHT, USDC |
| Chain Abstraction Layer pattern | 3 | User-intent layer decoupled from chain-specific execution; solvers handle routing | Midnight as chain-agnostic transaction surface; users express outcome, not chain steps |
| Intent-based transaction model | 3 | Signed outcome statements with solver/relayer price discovery and partial fills | Intent layer above DUST/ZSwap for common DeFi operations without the full NEAR stack |
| Hub-and-spoke bridge topology | 3 | NEAR as hub; all bridged chains as spokes; cross-chain traffic routes through hub | Midnight as privacy hub; all cross-chain privacy operations settle through Midnight |
| Relayer networks as first-class infrastructure | 3 | Competitive relayers for cross-chain message forwarding; no protocol-level trust | Reduce trust footprint; relayers compete on price and speed rather than by grant of authority |

## Consensus and Finality

| Item | Option | Design Inspiration | Rationale for Midnight |
|------|--------|--------------------|------------------------|
| Tiered / probabilistic finality (Doomslug) | 3 | Fast probabilistic finality (~1 s) before slower deterministic finality | Improve UX for low-value transfers while preserving deterministic finality for high-value ops |
| Epoch-based validator set rotation | 3 | 12-hour epochs for stable, predictable validator assignment | Batch validator-set changes to epoch boundaries; improve block-production stability |
| Slashing and accountability | 3 | Well-specified on-chain slashing for equivocation and unavailability | Strengthen security guarantees compared to Cardano's current soft-accountability model |

## Developer Experience and Tooling

| Item | Option | Design Inspiration | Rationale for Midnight |
|------|--------|--------------------|------------------------|
| Workspaces / sandbox testing framework | 2 | Sandboxed NEAR environment for contract integration testing against a local node | Significantly lower Midnight development friction — a recurring theme in the journal |
| SDK read / write path separation | 3 | View calls (free, read-only) vs. change calls (gas-costing) made explicit | Reduce developer confusion about which Midnight operations require DUST |
| Contract standard process (NEP-like) | 3 | Formal standards process for fungible token, NFT, and other contract interfaces | Midnight Enhancement Proposals for ZK-token interfaces and attestation schemas |
| Rust SDK simulation testing | 2 | In-process unit testing without a running node | Adapt for Compact or the Impact interpreter's Rust testing layer |
| Progressive tooling decentralisation | 3 | "Works out of the box" against both mainnet and local nodes | Direct model for Midnight's DX investment; extensive tooling friction documented |

## Application Delivery and Decentralised Frontends

| Item | Option | Design Inspiration | Rationale for Midnight |
|------|--------|--------------------|------------------------|
| NEAR BOS / component model | 3 | UI components stored on-chain and rendered in browsers; decentralised frontends | Directly mirrors MidnightOS vision — WASM apps served from a decentralised content store |
| Decentralised frontend hosting with reputation | 3 | Reputation-scored hosts; users verify content hashes | Critical for a privacy platform: a compromised frontend could silently leak private inputs |
| WASM component model integration | 3 | Production experience with WASM versioning, hot-swap, code-size limits, AOT compilation | Applicable to MidnightOS WASM component delivery pipeline |

## Data, Indexing, and Availability

| Item | Option | Design Inspiration | Rationale for Midnight |
|------|--------|--------------------|------------------------|
| NEAR Lake indexing framework | 2/3 | Stream blocks and receipts to S3-compatible object storage for external indexers | Improve indexer resilience; enable third-party analytics without running a full node |
| Selective state sync | 3 | New validators join by downloading a state snapshot rather than replaying full history | Critical for Midnight: ZK commitment trees grow monotonically; snapshot sync makes node onboarding tractable |
| Historical data and chain pruning policy | 3 | Validators prune blocks older than 5 epochs; archival nodes retain full history | Tiered retention policy for Midnight; bound validator storage for nullifier tree history |

## Protocol Governance and Upgrade Processes

| Item | Option | Design Inspiration | Rationale for Midnight |
|------|--------|--------------------|------------------------|
| Protocol versioning via validator voting | 3 | New version activates only when a supermajority of validators have upgraded | Compare against Substrate's governance pallets for Midnight's SPO validator structure |
| Protocol treasury and developer grants | 3 | Portion of NEAR inflation to a protocol treasury for ecosystem grants | NIGHT-issuance-funded grants for ZK tooling, privacy research, bridge integrations |
| Formal specification process | 3 | Single canonical versioned protocol spec (`nomicon.io`) written for implementers | Single canonical Midnight protocol spec to reduce documentation friction — a recurring blocker |

## Privacy-Specific Opportunities

*NEAR patterns applied to ZK contexts that Midnight is uniquely positioned to pioneer.*

| Item | Option | Design Inspiration | Rationale for Midnight |
|------|--------|--------------------|------------------------|
| Private solver networks | 3 | Competitive solver networks for intent execution | Solvers run inside TEEs with ZK-verified bids; prevents solver front-running and information leakage |
| ZK-verified access keys | 3 | Function-call access keys scoped to contract + method | Delegation constraint enforced by ZK proof; constraint itself not visible to validators |
| Shielded receipts / private cross-contract calls | 3 | NEAR receipt model makes all cross-contract communication visible on-chain | Encrypt receipt contents; only routing metadata public — private contract-to-contract composition |
| Privacy-preserving relayer incentives | 3 | Meta-transaction relayers compensated via gas payment | ZK-shielded mempool + relayer compensation without exposing or front-running the transaction |

# State Mapping

## Naive Approaches to Mapping Midnight to NEAR

*Grades A–F: A = best, F = worst.*

| Option | Description | TPS grade | On-chain TPS ceiling | TPS work goes to | Storage grade | On-chain storage growth | Storage overflow goes to |
|--------|-------------|-----------|---------------------|------------------|---------------|------------------------|--------------------------|
| Per-UTXO account | Each unshielded UTXO is a NEAR sub-account | A | High | NEAR validators | D | Unbounded, moderate | All on-chain |
| Per-note account | Each shielded commitment is a NEAR account | A | High | NEAR validators | F | Unbounded, fast | All on-chain |
| Sharded nullifier set | Nullifier set partitioned by prefix across accounts | C | Moderate–high | NEAR validators | C | Unbounded, moderate | All on-chain |
| Partitioned commitment tree | Merkle tree split into subtrees; root aggregator is a chokepoint | D | Moderate | NEAR validators (bottleneck) | C | Unbounded, moderate | All on-chain |
| Single account + validity proof | One account holds state root updated by ZK batch proof | C | Low (one proof per batch) | Off-chain sequencer/prover ⚠️ | A | Near-zero on-chain | Off-chain sequencer/prover ⚠️ |
| Three-account split | Separate accounts for commitments, nullifiers, and proof log | D | Low–moderate | NEAR validators | D | Unbounded, maximum raw volume | All on-chain |
| Per-contract account | Each Midnight contract maps to one NEAR account | F | Lowest | NEAR validators | B | Bounded by ecosystem size | All on-chain |
| Epoch snapshot rollup | One small account per epoch holds state root + aggregated proof | B | Very low (one proof per epoch) | Off-chain sequencer/prover ⚠️ | A | Near-zero, prunable | Off-chain sequencer/prover ⚠️ |

⚠️ The two options with the best storage grades (single account + validity proof, epoch snapshot rollup) achieve low on-chain cost by relocating the 500+ TPS problem to a bespoke off-chain sequencer — liveness and fault tolerance are not provided by NEAR.

# Throughput

## Throughput: Primary Metrics

| Symbol | Name | Unit | Definition |
|--------|------|------|------------|
| β_txs | Transaction-bytes per second | T-B/s | Rate of actual transaction payload bytes reaching the ledger; excludes headers, proofs, consensus data |
| β_blk | Block-bytes per second | BB/s | Total rate of block data participants must store and propagate, including all overhead; β_blk ≥ β_txs always |
| γ_txs | Per-transaction compute-ms per second | T-ms/s | Rate of work scaling with transaction count: WASM execution, ZK proof verification, signature checks, nullifier lookups; 1000 ms/s = one full CPU core |
| γ_blk | Block-level fixed overhead ms per second | BL-ms/s | Rate of work that does **not** scale with TPS: consensus authority checks, state/extrinsic root hashing, MMR updates; approximately constant regardless of TPS |

## Throughput: Contextual Measures and Derived Ratios

| Symbol | Name | Definition |
|--------|------|------------|
| Δ_idle | Network idle time (ms/s) | Time per second a validator waits on network I/O; γ_txs + γ_blk + Δ_idle ≈ slot budget; high Δ_idle → network-bound (faster hardware does not help) |
| π_shard | Shard parallelism (dimensionless) | Number of independent compute streams; single-chain: π_shard = 1; sharded: aggregate throughput scales as π_shard × per-shard capacity |
| ρ_β = β_txs / β_blk | Transaction payload fraction | Fraction of block data carrying user transactions; 0 < ρ_β ≤ 1; higher is better |
| ρ_γ = γ_txs / γ_blk | Per-transaction/block compute ratio | Ratio of TPS-scaling work to fixed block overhead; ρ_γ > 1 means per-transaction work exceeds fixed overhead at observed TPS |

## Lessons from Leios (Cardano Throughput Research)

| Area | Finding |
|------|---------|
| **Full Leios sharding** | Community found required features undesirable: failed transactions recorded in blocks; fees/collateral forfeit on conflict; DoS risks from sharding; shard-selection tokens or flavored UTxOs; cascading impacts to indexers, wallets, and backends |
| **TCP multiplexing** | Praos's multiplexing of mini-protocols over TCP created problems with timely delivery of Praos blocks in the Leios prototype |
| **Simulator optimism** | Two Leios simulators (low-fidelity and medium-fidelity for TCP) may be overly optimistic about throughput achievable in a more realistically engineered prototype |
| **Testing infrastructure** | Either actual large-scale deployments or sophisticated network-emulation infrastructure (e.g. Antithesis) is needed to study real node behavior at high throughput; simple network-manipulation tools are inadequate |
| **Tail risk** | Latency/bandwidth tail risks are significant for maintaining throughput and/or consensus |
| **Design space** | Both network and CPU resources are involved in the design space; such tradeoffs can be studied with constraint modeling |

## High-Throughput Substrate Chains

| Chain | Consensus | TPS (measured/claimed) | Block time | Notes |
|-------|-----------|------------------------|------------|-------|
| **Aleph Zero** | AlephBFT (DAG+BFT) | ~89,600 (2021 prototype, 112 nodes) | ~0.4 s finality | Golang prototype; ZK-shielded (LIMINAL) ~10–50 TPS |
| **Polkadot + parachains** | BABE+GRANDPA+Parachain | 143,343 aggregate (Spammening 2024, ~23% of cores) | ~6 s relay | On Kusama canary network; single parachain ~1,000–2,000 TPS |
| **Acala** | AURA+GRANDPA (parachain) | ~200 TPS | ~12 s | DeFi ops; relay-chain bound pre-async-backing |
| **Moonbeam** | AURA+GRANDPA (parachain) | ~30–60 TPS max; ~0.7 TPS mainnet avg | ~6 s | EVM compatibility traded for throughput |
| **Astar** | AURA+GRANDPA (parachain) | ~1,000 TPS claimed WASM; mainnet ~100–500 | ~6 s | EVM + WASM; ZK Dapp support planned |

**No existing Substrate chain demonstrates >50 TPS for ZK-proof-bearing transactions.**

## Midnight's Binding Constraint

| Resource | Limit per block | Ceiling at 6 s slot |
|----------|----------------|---------------------|
| **Block size** | 200 KB | ~3.3 TPS (200 KB ÷ ~10 KB/tx) ← **binding** |
| Compute budget | 1 s (single-threaded) | ~49 TPS (1,000 ms ÷ 3.4 ms/proof) |
| Proof verification | ~3.4 ms constant + ~3.4 μs/unit | — |

Block size is the binding constraint — roughly **15× tighter** than the compute ceiling.

This confirms that switching to NEAR's networking does not address the bottleneck (Jon Rossie, Background 6): the problem is bytes per block, not the consensus protocol.

> ⚠️ **Empirical observation:** No ZK blockchain is known to sustain more than ~50 TPS for ZK-proof-bearing transactions in production. Midnight's current ~3 TPS and its unmodified compute ceiling of ~49 TPS both fall within this observed range.

## Paths to 500+ TPS

| Path | Mechanism | Expected gain | Notes |
|------|-----------|---------------|-------|
| **1. Block size increase** | Raise limit from 200 KB toward ~5 MB | ~80 TPS | Block propagation becomes the new binding constraint at this scale |
| **2. ZK proof folding** | ProtoGalaxy k-folding aggregates k proofs; on-chain proof size shrinks by ~k× | ~k× current TPS | Relaxes the byte constraint proportionally; no consensus change needed |
| **3. L2 rollup** | Batch many L2 transactions into a single L1 entry | Decouples L2 TPS from L1 block size entirely | Separates execution scale from settlement scale |

Paths 1 + 2 in combination are estimated to reach 500+ TPS within the existing Substrate architecture — no platform migration required. Indicative arithmetic: ~80 TPS (5 MB blocks) × 10× ProtoGalaxy folding = ~800 TPS ceiling, subject to the BLOCKER below.

> 🛑 **BLOCKER:** ProtoGalaxy k-folding (Path 2) is cited in the NearFall Technical Specification as the key scaling mechanism, but security analysis for Midnight's specific circuit compositions is not yet complete.

## Applicability of Substrate Throughput Techniques

| Technique | Impact on β_txs | ZK-compatible? | Cost | Verdict |
|-----------|-----------------|----------------|------|---------|
| **Block size increase** (parameter) | ~3–25× | Yes | Trivial | Immediate win; already identified |
| **Shorter AURA slot time** (parameter) | ~2–3× | Yes | Low | Multiplies block-size gain; evaluate jointly |
| **ZK proof aggregation** (ProtoGalaxy) | ~10× on compute ceiling | Yes (ZK-native) | High | High ROI; non-trivial; blocked pending security audit |
| **Batch proof verification host function** | ~N× on compute ceiling | Yes (native Rust) | Medium | Architecturally clean for Midnight; not yet in Substrate |
| **AlephBFT consensus** | ~3–5× (slot reduction) | Yes (consensus only) | Medium–High | Open-source; subsecond finality; no runtime changes |
| **Polkadot parachain** (Cumulus + Async Backing + Elastic) | ~10–30× combined | Yes (runtime unchanged) | High | Most powerful lever; effectively Option 3 via Polkadot |
| **L2 rollup** (Paima/Nightstream) | L1-decoupled | Yes (settlement only) | High | Orthogonal to on-chain TPS |
| **Parallel extrinsic execution** | Potentially large | N/A | N/A — does not exist | Not available in Substrate |
| **External ZK pallet** (pallet-plonk, zkVerify) | Negative (slower) | Inferior | — | Do not adopt; native host function is faster |

## Liveness and Safety Risk Definitions

For evaluating throughput technique risks:

- **Liveness risk:** valid transactions fail to be included in blocks in a timely way — empty slots, stalled chains, indefinitely queued transactions
- **Safety risk:** an invalid state transition is accepted as final — a forged proof passes verification, an equivocating block is finalised, or a protocol bug is exploitable
- **Centralisation pressure:** conditions that make it advantageous or necessary to be a well-resourced validator, eroding decentralisation — the basis for both safety and censorship resistance

## ProtoGalaxy Folding: Risks

🧪 **HYPOTHESIS:** Replacing AURA+GRANDPA with AlephBFT and increasing block size to 5 MB achieves ~250 TPS with ~1 s finality — improving both throughput and UX without changing any Midnight pallet or ZK circuit.

**Liveness risks:**

- Aggregator is a new single point of failure; fallback to single-proof mode needed
- Batching latency at low traffic: waiting for k=10 proofs multiplies per-tx latency; timeout mechanism required
- Circuit-type fragmentation: ProtoGalaxy folds same-circuit proofs only; mixed blocks limit effective fold factor

**Safety risks:**

- 🛑 **BLOCKER:** Formal security analysis of Midnight circuit compositions to be folded is required before production deployment — distinct from soundness of ProtoGalaxy itself
- Folded proof size may not be smaller than individual proofs; must be measured
- Soundness relies on KZG commitment hardness; the specific Midnight composition has not been independently audited

## Throughput Technique Risk Summary

| Technique | Primary liveness risk | Primary safety risk | Centralisation pressure |
|-----------|----------------------|---------------------|------------------------|
| **Block size increase** | Diffusion failure at large sizes / short slots | DoS amplification; no native erasure coding | High (favours high-bandwidth validators) |
| **Shorter slot time** | Tightened diffusion window; higher fork rate | Higher steady-state fork exposure; bridge complexity | Moderate (requires low-latency nodes) |
| **(5 MB, 2 s) combined** | Marginal Δ_diff/Δ_slt ratio; tail validators excluded | Compounded fork + diffusion risks | High — consider (5 MB, 3 s) as safer initial target |
| **ProtoGalaxy folding** | Aggregator as new SPF; batching latency at low load; circuit fragmentation | Folding-relation soundness; independent audit required | Low (aggregator can be decentralised) |
| **Batch proof verification** | Thread contention with networking under full load | Batch randomness must be unpredictable to submitters; weight model re-calibration | Low (purely internal to node) |
| **AlephBFT consensus** | DAG round failure if committee members offline | <1/3 adversarial threshold; newer codebase | Moderate (rotating committee) |

## Kernel TCP Tuning for Validator Nodes

*`--sysctl` settings are per-container (Docker/Podman); `sysctl.d` settings require host root.*

| Setting | Apply now? | Apply at 5 MB blocks? | Scope |
|---------|------------|----------------------|-------|
| `tcp_slow_start_after_idle = 0` | **Yes — immediately** | Yes | Docker `--sysctl` |
| `tcp_congestion_control = bbr` | **Yes — immediately** | Yes | Docker `--sysctl` |
| `default_qdisc = fq` | **Yes — immediately** | Yes | Docker `--sysctl` (Linux ≥ 4.18) |
| `tcp_mtu_probing = 1` | Yes (hygiene) | Yes | Docker `--sysctl` |
| `tcp_max_syn_backlog = 8096` | Yes (hygiene) | Yes | Docker `--sysctl` |
| `tcp_rmem` / `tcp_wmem` max = 8 MB | Not required yet | **Yes — prerequisite** | Docker `--sysctl` (Linux ≥ 4.15) |
| `rmem_max` / `wmem_max` = 8 MB | Not required yet | Yes — if node calls `setsockopt` | **Host root (`sysctl.d`)** |
| `vm.swappiness = 1–10` | Yes (trie I/O stability) | Yes | **Host root (`sysctl.d`)** |
| `vm.dirty_ratio = 10–20` | Yes (trie I/O stability) | Yes | **Host root (`sysctl.d`)** |
| `net.core.netdev_max_backlog` increase | Yes (hygiene) | Yes | **Host root (`sysctl.d`)** |
| `fs.file-max` increase | Yes (operational) | Yes | **Host root (`sysctl.d`)** |
| `ulimit -n` (open file descriptors) | Yes (operational) | Yes | Docker `--ulimit nofile=65536:65536` |

## QUIC Transport for Midnight Nodes

| Property | TCP + Yamux (current) | QUIC (via litep2p) |
|----------|-----------------------|--------------------|
| Head-of-line blocking | All streams stall on any packet loss | Streams independent; lost packet blocks only its stream |
| Handshake latency | 2.5 RTT (TCP + TLS 1.3) | 1 RTT new; 0-RTT resumption for known peers |
| Slow start after idle | `tcp_slow_start_after_idle` resets CWND; ~700 ms penalty at 5 MB | Larger initial CWND + pacing; structurally absent |
| Stream multiplexing | Yamux over TCP; large block transfer delays GRANDPA votes | Native independent streams; GRANDPA unaffected by concurrent block download |
| NAT traversal | DCUtR hole punching | Connection migration via connection IDs; survives IP change |

🧪 **HYPOTHESIS:** QUIC is not a capability gap for Midnight. litep2p (default Substrate networking backend since stable2503, adopted in IOG partner-chains v1.8.0) supports QUIC as opt-in — enabling it is an **operational/configuration decision**, not an engineering project. Add `--listen-addr /ip4/0.0.0.0/udp/30333/quic-v1` to node launch arguments. Highest near-term value at 5 MB block sizes, where QUIC's larger initial CWND and stream independence directly address the two weakest points of TCP tuning.

## Hypotheses and Open Questions

🧪 **HYPOTHESIS 1:** Midnight's TPS ceiling is well-modelled as:

`TPS = (block_size_bytes ÷ avg_zk_tx_bytes) ÷ block_time_seconds × folding_factor`

Validating this formula against actual measurements is a concrete near-term experiment.

🧪 **HYPOTHESIS 2:** Block size increase + ProtoGalaxy folding achieves 500+ TPS within the existing Substrate architecture, making platform migration unnecessary for the throughput goal alone.

**Key uncertainties remaining:**

- ZK transaction size assumed at ~10 KB; Midnight proof blobs elsewhere cited as 1–2 KB — the composition of the remaining bytes is not documented and affects both hypotheses
- The 500+ TPS claim carries the ProtoGalaxy BLOCKER above as a caveat
- No rigorous public benchmark exists for Midnight's ZK transaction throughput; the ~1,000 TPS marketing target is unvalidated

# Next Steps

## Possible Next Steps

1. **Scalability experiments** — measure actual Midnight ZK transaction size and TPS on preprod; benchmark block propagation at larger block sizes; validate the throughput model against real numbers
2. **Broaden assessment** — chain signatures (BN254/BLS12-381 compatibility question), TEE integration, Starstream/Nightstream blockers, Paima L2 path
3. **Deep dive** — select one or two topics for more detailed design and prototyping (candidates: ProtoGalaxy folding, Chain Signatures Option 2, AlephBFT consensus replacement)
4. **Define decision criteria** — agree in advance what evidence would be sufficient to recommend Option 1, 2, or 3; without this the Define phase may produce analysis without a path to a recommendation
5. **Pivot?** — reconsider scope, framing, or which options remain live given findings to date

# Discussion

## Feedback, Collaboration, and Next Increment

1. **Candid feedback** — What is most and least useful from the work so far? What is missing?
2. **Tighter collaboration** — Who else should be involved? What access, context, or artefacts would accelerate the next increment?
3. **Course corrections** — Are the three options still the right frame? Are any assessment areas over- or under-weighted?
4. **Next increment** — What should be prioritised for the Define phase (Apr 6 – Apr 30)?
