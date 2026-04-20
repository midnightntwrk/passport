# 🤖👱 Chain Abstraction vs. Bridges: Capabilities and Midnight Applicability

**Date:** 2026-04-07
**Context:** NEARFall feasibility study — evaluating NEAR's Chain Signatures capability and its relationship to traditional bridging, and assessing how either the implementation or approach could be adapted to Midnight.

---

## Background: NEAR Chain Signatures

Launched on mainnet **August 8, 2024**. Chain Signatures gives a NEAR account direct control of native addresses on foreign chains via a threshold MPC signing network.

### Architecture

- **On-chain contract:** `v1.signer` (NEAR mainnet) — accepts signing requests, returns completed signatures
- **MPC node network:** 8 independent nodes, secured by NEAR staking and Eigenlayer ETH restaking
- **Key scheme:** Additive Key Derivation (AKD) — deterministic derivation of foreign-chain addresses

### Signing Flow

1. A NEAR account (or smart contract) calls `v1.signer.sign(payload, path, domain_id)` on-chain
2. Each MPC node computes a signature share using a jointly-held master key and the derivation parameters
3. Shares are aggregated — no single node ever holds the full key — to produce a valid signature
4. The signature is returned on-chain for submission to the target chain

### Additive Key Derivation

```
foreign_address = derive(MPC_master_public_key, near_account_id, path)
```

The same `(account_id, path)` pair always produces the same foreign-chain address — a single NEAR account stably controls addresses on many chains without ever exposing a private key.

### Supported Curves and Chains

| `domain_id` | Curve | Chains |
|---|---|---|
| 0 | Secp256k1 (ECDSA) | Ethereum, EVM chains, Bitcoin, Cosmos, DOGE, XRP |
| 1 | Ed25519 (EdDSA) | Solana, NEAR, Stellar, TON, Cardano (theoretically) |
| TBD | BLS12-381 | Planned via governance vote |

### Privacy on NEAR

Every chain signature request — including the derivation `path` and the message being signed — is a **public on-chain event**. Any observer can reconstruct which target chain is being addressed and what is being signed.

---

## What a Traditional Bridge Does

A bridge moves value or messages between chains by maintaining a trusted committee (or ZK proof) on both sides. The canonical pattern is **lock-and-mint**: lock an asset on the source chain, mint a wrapped representation on the destination chain. Wrapped assets carry custodial risk — if the bridge is compromised, the backing is gone. Bridges require deployed infrastructure on both chains.

### Bridge Taxonomy

| Type | Trust model | Scope |
|---|---|---|
| Multi-sig bridge | Trusted committee | Asset transfers only |
| Optimistic bridge | Fraud proofs + time delay | Asset transfers, some messages |
| ZK bridge | ZK proof of source chain state | Asset transfers, messages |
| IBC / XCM | Light client on each chain | Arbitrary message passing |

---

## Chain Abstraction vs. Bridges: Comparison

Chain Signatures and bridges address overlapping but distinct problems. They are complementary, not substitutes.

| Capability | Traditional bridge | Chain Signatures (NEAR) |
|---|---|---|
| Move assets source → destination | ✅ | ✅ (signs native tx on target chain) |
| Move assets destination → source | ✅ | ❌ (no inbound path) |
| Counterparty contract on target chain | Required | **Not required** |
| Asset model on target chain | Wrapped (custodial risk) | **Native** (no wrapping) |
| Works on non-smart-contract chains (Bitcoin) | Rarely | ✅ |
| Arbitrary contract calls on target chain | Sometimes (IBC/XCM) | ✅ |
| Trust assumption | Committee / ZK / light client | MPC threshold (8 nodes) |
| Signing request visibility on source chain | Public | Public (NEAR) |

### More powerful than a bridge in:
- **Scope** — can authorize *any* transaction on the target chain (DeFi, NFTs, staking), not just asset transfers
- **Asset model** — native assets with no wrapping, de-peg risk, or custodial intermediary
- **Target chain requirements** — nothing needs to be deployed on the target chain; works on Bitcoin where arbitrary contracts are impractical

### Less powerful than a bridge in:
- **Return flows** — Chain Signatures handles outbound authorization only. Bringing assets *back* to the source chain requires a separate bridge or a DEX swap on the target chain followed by a bridge

### Not equivalent to a bridge:
A complete cross-chain product typically needs both. Chain Signatures handles outbound signing; a bridge (or target-chain DEX + bridge) handles the return leg. The two capabilities are complementary layers in a chain-abstraction stack.

---

## Analogy

A bridge is like a **currency exchange counter**: you surrender asset A and receive asset B, mediated by the exchanger — you no longer hold the original.

Chain Signatures is like a **power of attorney**: you authorize a trusted party (the MPC network) to sign on your behalf on another chain, but the native address remains yours, the native asset remains yours, and you are not dependent on a counterparty holding the asset in custody.

---

## Adaptation to Midnight

### What Midnight Has Today

Only a **bilateral Cardano integration** (cNIGHT ↔ mNIGHT token bridge) — asset transfer between Midnight and Cardano only. Not a general-purpose signing service; not applicable to Bitcoin, Ethereum, or other chains.

### The Privacy Enhancement Opportunity

This is the most important observation: Midnight's ZK architecture allows a strictly *stronger* version of Chain Signatures than NEAR can offer.

On NEAR, every signing request is a public on-chain event — the target chain, derivation path, and payload are all visible. On Midnight, a signing request can live entirely in **private Compact contract state**: on-chain observers never see which target chain is being addressed, which path is being derived, or what is being signed. A ZK proof establishes that the request is valid without revealing its contents.

No bridge architecture offers this. A ZK bridge proves source-chain state on the destination chain; it does not hide *which* destination chain is involved from source-chain observers.

### Three Integration Levels

**(a) Off-chain oracle bridge** *(moderate complexity — most tractable near-term path)*

```
Midnight Compact contract (private signing request in ZK state)
        │
        ▼
Oracle / relayer (reads request, forwards to NEAR's v1.signer)
        │
        ▼
NEAR MPC network (signs for target chain)
        │
        ▼
Signed transaction submitted to target chain
        │
        ▼
Oracle posts confirmation back to Midnight contract
```

No new MPC infrastructure is required. NEAR's production network is reused as a signing service. The oracle bridge is the engineering work; the Compact contract interface is tractable.

**(b) Via Compact contract alone** *(moderate complexity)*

A Compact contract manages the request/response interface and private state. The oracle bridge performs the actual relay. The contract enforces access control and records which addresses have been derived for which paths — all in private state.

---

### The Role of the Oracle

The oracle is the critical component that connects two otherwise isolated systems, and it carries the main trust and liveness assumptions of the integration. Its role is worth making explicit.

**The problem it solves.** Midnight contracts cannot make outbound calls to external systems. A Compact contract running on Midnight has no way to directly submit a transaction to NEAR's `v1.signer` — the two chains are completely isolated. Similarly, NEAR's MPC network has no way to observe Midnight contract state. The oracle bridges the gap in both directions.

**Detailed flow:**

```
Midnight contract                Oracle                    NEAR / target chain
      │                            │                              │
      │  emits signing request     │                              │
      │  (public or private state) │                              │
      │──────────────────────────▶ │                              │
      │                            │  reads request               │
      │                            │  holds NEAR account          │
      │                            │  calls v1.signer.sign(       │
      │                            │    payload, path, domain_id) │
      │                            │─────────────────────────────▶│
      │                            │                              │
      │                            │  ◀─ MPC network signs ──────│
      │                            │     returns signature        │
      │                            │                              │
      │                            │  submits signed tx to        │
      │                            │  target chain (e.g. ETH)     │
      │                            │─────────────────────────────▶│
      │                            │                              │
      │  ◀─ posts confirmation ────│                              │
      │     back to contract       │                              │
```

The oracle specifically:
1. **Monitors** the Midnight chain (via the GraphQL indexer) for new signing requests in the contract
2. **Reads** the request details — target chain, payload, derivation path, `domain_id`
3. **Holds a NEAR account** with sufficient NEAR tokens to pay gas for `v1.signer.sign()`
4. **Submits** the signing request to NEAR's MPC network on behalf of the Midnight user
5. **Waits** for the signature to be returned on NEAR by the MPC nodes
6. **Delivers** the completed signature — posts it back to the Midnight contract, submits the signed transaction directly to the target chain, or both

The oracle is not part of the Midnight protocol, not a Midnight pallet, and not part of NEAR's MPC network. It is a trusted off-chain service — conceptually similar to a Chainlink oracle, a LayerZero relayer, or NEAR's own meta-transaction relayer infrastructure.

**Division of responsibility between contract and oracle:**

| | Compact contract | Oracle |
|---|---|---|
| Lives | On-chain (Midnight) | Off-chain |
| Role | Access control, state management, request commitment | Cross-chain relay, gas payment, delivery |
| Enforces correctness | Yes — commits the payload before the oracle sees it | No — just forwards |
| Enforces privacy | Yes — keeps request in private ZK state | No — sees the request to forward it |
| Engineering complexity | Low–moderate | **This is where the work is** |

The contract is tractable precisely because it delegates all cross-chain complexity to the oracle. The oracle is where the non-trivial engineering lives: managing a NEAR account, handling NEAR gas, parsing MPC responses, submitting to target chains, and handling failures and retries.

**Trust assumptions introduced by the oracle:**

- **Correctness** — largely enforced by design. The payload is committed in Midnight contract state before the oracle sees it. The oracle cannot change what gets signed; it can only forward the committed payload. The returned signature is over the exact committed bytes, verifiable by anyone.

- **Privacy** — the sensitive dimension. If the signing request lives in Midnight's *private* contract state, the oracle must be an authorised party that can read that private state. It therefore knows the target chain, the derivation path, and the payload — even though on-chain observers do not. The oracle becomes a trusted party in the privacy model, not just the liveness model.

- **Liveness** — the main operational risk. If the oracle goes offline, signing requests are stuck indefinitely. Redundant oracle operators mitigate this, at the cost of each operator knowing the private request details.

- **Censorship** — a weaker concern. The oracle could decline to forward specific requests. This is the same risk carried by any relayer-based system (NEAR's DelegateAction relayers, bridge operators, etc.) and is mitigated by running multiple competing oracle operators.

---

**(c) As a Midnight ledger change** *(very high cost)*

Building a first-class MPC network comparable to NEAR's — with distributed key generation, threshold signing, re-sharing, and economic security via staking — is a multi-year infrastructure project. Not a near-term option.

### The Curve Incompatibility Question

NEAR's MPC network uses **BN254** (via Sirius) internally for proof aggregation. Midnight uses **BLS12-381**. These are incompatible at the proof-aggregation level.

However, the MPC **signing operations** — Secp256k1 for Ethereum/Bitcoin, Ed25519 for Cardano/Solana — are **independent of the internal aggregation curve**. The signing service is usable by Midnight without resolving the curve conflict, provided the MPC network's internal proofs do not need to be verified on Midnight's chain. The oracle bridge pattern avoids this problem entirely: Midnight never verifies the MPC's internal proofs; it only receives a completed signature.

**The most important near-term technical question:** confirm that the BN254/BLS12-381 incompatibility affects only the proof-aggregation path, not the signing path. If confirmed, no curve conflict blocks the oracle bridge approach.

### Capability Hierarchy for Midnight

| Capability | Status | Privacy |
|---|---|---|
| Cardano bilateral bridge (cNIGHT ↔ mNIGHT) | Exists today | Public |
| Chain Signatures via oracle bridge (arbitrary chains, outbound) | Feasible; no new MPC infrastructure | **Private on Midnight side** |
| Full return-leg solution | Requires bridge or DEX + bridge for inbound | Depends on return mechanism |
| Native Midnight MPC network | Multi-year infrastructure project | **Private** (best case) |

### Recommended Priority Actions

1. **Confirm the BN254/BLS12-381 signing-path independence** — determine whether the incompatibility affects only aggregation proofs or also the signing operations.
2. **Prototype the oracle bridge** — relay a Midnight contract signing request to NEAR's `v1.signer` on testnet; confirm end-to-end signing for at least one target chain (e.g., Ethereum Sepolia).
3. **Design the private signing request Compact contract pattern** — demonstrate Midnight's privacy enhancement over NEAR's public model as a proof-of-concept.

---

## Sources

- [`assessments/near-key-management.md`](./near-key-management.md) — §10.12 (Chain Signatures) and §11.8 (Midnight applicability); primary source for all NEAR-side technical claims
- [Chain Signatures — NEAR Documentation](https://docs.near.org/chain-abstraction/chain-signatures)
- [Chain Signatures launch announcement — NEAR](https://pages.near.org/blog/chain-signatures-launch-to-enable-transactions-on-any-blockchain-from-a-near-account/)
- [near/mpc — GitHub](https://github.com/near/mpc)
- NEAR MPC Chain Signatures System Summary — internal (`background/mpc-chain-signatures-summary.md`)
- NearFall Technical Specification v4.2 — internal (`background/NearFall_Technical_Specification_v4_2.pdf`); source for BN254/BLS12-381 curve incompatibility assessment
- Midnight Architecture Summary — internal (`background/midnight-architecture.md`)
