# NEAR MPC Chain Signatures - System Summary

## Overview

The **NEAR MPC (Multi-Party Computation) Chain Signatures** system is a decentralized threshold signature network that enables NEAR accounts and smart contracts to sign transactions for any blockchain. It operates as a separate infrastructure layer that integrates with the NEAR blockchain through a smart contract interface.

**Key Capabilities:**

- **Threshold Signatures**: No single node possesses the complete private key; signatures require cooperation of a threshold of participants
- **Multi-Chain Support**: Signs transactions for Bitcoin, Ethereum, Solana, and any chain supporting ECDSA, EdDSA, or BLS signatures
- **Decentralized Key Management**: Keys are generated and reshared through distributed protocols
- **TEE Support**: Optional Trusted Execution Environment (TEE) mode for enhanced security

**Signature Schemes Supported:**

| Scheme | Curve | Use Cases |
|--------|-------|-----------|
| ECDSA | Secp256k1 | Bitcoin, Ethereum, EVM chains |
| V2 ECDSA | Secp256k1 | Enhanced fault-tolerant ECDSA |
| EdDSA | Ed25519 | Solana, Polkadot, Cosmos |
| CKD | BLS12-381 | Confidential Key Derivation for app-specific keys |

---

## How Users Use Chain Signatures

Chain Signatures allows a **NEAR account to control addresses on any blockchain** - Bitcoin, Ethereum, Solana, etc. - without needing to manage separate private keys for each chain.

```mermaid
graph LR
    subgraph "User's Single Identity"
        NEAR[alice.near<br/>NEAR Account]
    end

    subgraph "Derived Addresses (Controlled by alice.near)"
        BTC[bc1q...xyz<br/>Bitcoin Address]
        ETH[0x7a3...def<br/>Ethereum Address]
        SOL[Hk9...abc<br/>Solana Address]
    end

    NEAR -->|Derives & Controls| BTC
    NEAR -->|Derives & Controls| ETH
    NEAR -->|Derives & Controls| SOL

    style NEAR fill:#ccccff
    style BTC fill:#f9a825
    style ETH fill:#627eea
    style SOL fill:#00d4aa
```

### Example: Controlling Bitcoin from NEAR

**Scenario**: Alice wants to send Bitcoin, but she only has a NEAR account.

```mermaid
sequenceDiagram
    autonumber
    participant Alice as Alice (User)
    participant NEAR as alice.near
    participant MPC as MPC Contract<br/>v1.signer
    participant MPCNet as MPC Network
    participant BTC as Bitcoin Network

    Note over Alice,NEAR: Step 1: Get Bitcoin address

    Alice->>MPC: derived_public_key("bitcoin,1", alice.near)
    MPC-->>Alice: Bitcoin public key → address bc1q...xyz

    Note over Alice,BTC: Step 2: Receive Bitcoin to that address

    BTC-->>Alice: Someone sends 0.5 BTC to bc1q...xyz

    Note over Alice,MPCNet: Step 3: Sign a Bitcoin transaction

    Alice->>NEAR: Create unsigned BTC transaction
    Alice->>MPC: sign(btc_tx_hash, "bitcoin,1")
    MPC->>MPCNet: Request threshold signature

    MPCNet->>MPCNet: MPC nodes collaborate
    MPCNet->>MPC: Return signature

    MPC-->>Alice: Bitcoin signature

    Note over Alice,BTC: Step 4: Broadcast to Bitcoin

    Alice->>BTC: Submit signed transaction
    BTC-->>Alice: Transaction confirmed ✓
```

### Code Example

```javascript
// 1. Derive a Bitcoin address from NEAR account
const mpcContract = new Contract(account, "v1.signer", {
  viewMethods: ["derived_public_key"],
  changeMethods: ["sign"],
});

const btcPublicKey = await mpcContract.derived_public_key({
  path: "bitcoin,1",           // Derivation path
  predecessor: "alice.near",   // NEAR account
});
const btcAddress = publicKeyToBitcoinAddress(btcPublicKey);
// Result: bc1q7x8fp4z7n3...

// 2. Create and sign a Bitcoin transaction
const unsignedTx = createBitcoinTransaction({
  from: btcAddress,
  to: "bc1qRecipient...",
  amount: 0.1,
});

const signature = await mpcContract.sign({
  request: {
    payload: Array.from(hashTransaction(unsignedTx)),
    path: "bitcoin,1",
    key_version: 0,
  }
}, "300000000000000"); // 300 Tgas

// 3. Broadcast signed transaction
const signedTx = attachSignature(unsignedTx, signature);
await broadcastToBitcoin(signedTx);
```

### Common Use Cases

| Use Case | Description |
|----------|-------------|
| **Multi-chain Wallet** | Single NEAR account controls BTC, ETH, SOL addresses |
| **Cross-chain DeFi** | Deposit BTC into Ethereum DeFi protocols |
| **DAO Treasury** | DAO on NEAR controls assets on multiple chains |
| **Automated Trading** | Smart contract on NEAR executes trades on other chains |
| **NFT Bridges** | Move NFTs between chains using one identity |

### Key Benefits

- **One Account**: Manage all chains from your NEAR account
- **No Key Management**: No need to secure separate private keys per chain
- **Programmable**: Smart contracts can control cross-chain assets
- **Recoverable**: NEAR account recovery mechanisms protect all chain access

### Costs

| Item | Cost |
|------|------|
| Signature request (NEAR) | ~7 TGas (~$0.001) |
| Target chain fees | Standard (e.g., BTC miner fee) |

---

## Table of Contents

- [How Users Use Chain Signatures](#how-users-use-chain-signatures)
- [System Architecture](#system-architecture)
- [Core Components](#core-components)
  - [MPC Node](#mpc-node)
  - [MPC Contract](#mpc-contract)
  - [Network Layer](#network-layer)
  - [Storage Layer](#storage-layer)
- [Signature Request Flow](#signature-request-flow)
- [Key Generation & Resharing](#key-generation--resharing)
- [Background Operations](#background-operations)
- [Integration with NEAR Core Architecture](#integration-with-near-core-architecture)
- [Security Model](#security-model)
- [Key Modules Reference](#key-modules-reference)

---

## System Architecture

```mermaid
graph TB
    subgraph "User Applications"
        User[User/dApp/AI Agent]
        Wallet[Wallet]
    end

    subgraph "NEAR Blockchain"
        subgraph "NEAR Core Node"
            Runtime[Runtime Layer<br/>WASM Execution]
            Blockchain[Blockchain Layer<br/>Consensus & Sharding]
            Storage[Storage Layer<br/>State Trie]
        end

        Contract[MPC Contract<br/>v1.signer]
    end

    subgraph "MPC Network (Separate Infrastructure)"
        subgraph "MPC Node 1"
            Coord1[Coordinator]
            Provider1[Signature Providers]
            Net1[P2P Network]
            DB1[RocksDB Storage]
            Idx1[NEAR Indexer]
        end

        subgraph "MPC Node 2"
            Coord2[Coordinator]
            Provider2[Signature Providers]
            Net2[P2P Network]
            DB2[RocksDB Storage]
            Idx2[NEAR Indexer]
        end

        subgraph "MPC Node N"
            CoordN[Coordinator]
            ProviderN[Signature Providers]
            NetN[P2P Network]
            DBN[RocksDB Storage]
            IdxN[NEAR Indexer]
        end
    end

    subgraph "External Chains"
        BTC[Bitcoin]
        ETH[Ethereum]
        SOL[Solana]
        Other[Other Chains]
    end

    User -->|1. Sign Request| Contract
    Wallet -->|Submit Tx| Contract

    Contract -->|Executed by| Runtime
    Runtime --> Blockchain
    Blockchain --> Storage

    Idx1 -.->|Monitor Blocks| Blockchain
    Idx2 -.->|Monitor Blocks| Blockchain
    IdxN -.->|Monitor Blocks| Blockchain

    Idx1 --> Coord1
    Idx2 --> Coord2
    IdxN --> CoordN

    Coord1 --> Provider1
    Coord2 --> Provider2
    CoordN --> ProviderN

    Net1 <-->|TLS P2P| Net2
    Net2 <-->|TLS P2P| NetN
    Net1 <-->|TLS P2P| NetN

    Provider1 --> DB1
    Provider2 --> DB2
    ProviderN --> DBN

    Coord1 -->|2. Submit Response| Contract

    Contract -.->|3. Signature Result| User

    User -->|4. Use Signature| BTC
    User -->|4. Use Signature| ETH
    User -->|4. Use Signature| SOL
    User -->|4. Use Signature| Other

    style Contract fill:#ccccff,stroke:#333,stroke-width:2px
    style Runtime fill:#fff4e1
    style Blockchain fill:#e1f5ff
    style Coord1 fill:#ccffcc
    style Coord2 fill:#ccffcc
    style CoordN fill:#ccffcc
    style BTC fill:#f9a825
    style ETH fill:#627eea
    style SOL fill:#00d4aa
```

### Architecture Highlights

1. **Separation from NEAR Core**: MPC nodes are **not part of nearcore**. They run as separate processes with their own storage, networking, and compute.

2. **On-Chain Coordination**: The MPC Contract on NEAR serves as the coordination point:
   - Receives signature requests from users
   - Manages participant set and threshold parameters
   - Stores public keys and domain configurations
   - Delivers signature responses back to users

3. **Off-Chain Computation**: Actual cryptographic operations happen off-chain:
   - MPC nodes monitor the contract via their built-in indexers
   - Threshold protocols execute over P2P network
   - Results are submitted back to the contract

4. **Decentralized Network**: Multiple independent MPC nodes collaborate:
   - Each maintains its own keyshare
   - TLS-encrypted mesh network for communication
   - Threshold of participants required for any signature

---

## Core Components

### MPC Node

The MPC node is a Rust binary that performs threshold cryptographic operations. Each node in the network runs this software.

#### Coordinator (`coordinator.rs`)

The coordinator is the central state machine that orchestrates all MPC operations:

```mermaid
stateDiagram-v2
    [*] --> Idle: Node starts

    Idle --> MonitoringContract: Indexer connected

    MonitoringContract --> SpawningKeygenJobs: Contract in Initializing state
    MonitoringContract --> SpawningResharingJobs: Contract in Resharing state
    MonitoringContract --> ProcessingSignatures: Contract in Running state

    SpawningKeygenJobs --> VotingPublicKey: Keygen complete
    VotingPublicKey --> MonitoringContract: Votes submitted

    SpawningResharingJobs --> VotingReshared: Resharing complete
    VotingReshared --> MonitoringContract: Votes submitted

    ProcessingSignatures --> ProcessingSignatures: Handle requests
    ProcessingSignatures --> SubmittingResponse: Signature generated
    SubmittingResponse --> ProcessingSignatures: Response confirmed

    ProcessingSignatures --> MonitoringContract: State change detected
```

**Responsibilities:**

- Monitors contract state transitions
- Spawns appropriate protocol jobs (keygen, resharing, signing)
- Manages background operations (triple/presignature generation)
- Routes requests to signature providers
- Handles job interruption on state changes

#### Signature Providers

Providers implement the actual cryptographic protocols for different signature schemes:

| Provider | File | Signature Scheme | Protocol |
|----------|------|------------------|----------|
| ECDSA | `providers/ecdsa.rs` | Secp256k1 | FROST threshold ECDSA |
| Robust ECDSA | `providers/robust_ecdsa.rs` | V2Secp256k1 | Enhanced fault-tolerant ECDSA |
| EdDSA | `providers/eddsa.rs` | Ed25519 | FROST threshold EdDSA |
| CKD | `providers/ckd.rs` | BLS12-381 | Confidential Key Derivation |

#### Protocol Runner (`protocol.rs`)

Generic execution engine for any threshold protocol:

- Runs cait-sith/FROST protocols
- Manages message multiplexing across participants
- Separates computation and I/O into parallel tasks
- Tracks message counters for monitoring

### MPC Contract

The smart contract deployed on NEAR that serves as the public interface and coordination layer.

#### Contract State Machine

```mermaid
stateDiagram-v2
    [*] --> NotInitialized: Contract deployed

    NotInitialized --> Running: init() called

    Running --> Initializing: vote_add_domains()
    Running --> Resharing: vote_new_parameters()
    Running --> Running: sign(), respond()

    Initializing --> Running: Keygen votes reach threshold
    Initializing --> Running: vote_cancel_keygen()

    Resharing --> Running: Resharing votes reach threshold
```

#### Key Contract Methods

**User-Facing:**

| Method | Purpose | Cost |
|--------|---------|------|
| `sign(request)` | Submit ECDSA/EdDSA signature request | ~7 Tgas |
| `request_app_private_key(request)` | Submit CKD request | ~7 Tgas |
| `public_key(domain)` | Get public key (read-only) | Free |
| `derived_public_key(path, predecessor, domain)` | Generate derived key | Free |

**Participant Methods:**

| Method | Purpose |
|--------|---------|
| `vote_new_parameters(epoch_id, proposal)` | Change participants/threshold |
| `vote_add_domains(domains)` | Add new signature domains |
| `vote_pk(key_event_id, public_key)` | Vote for generated public key |
| `vote_reshared(key_event_id)` | Vote for resharing success |
| `respond(request, signature)` | Submit signature result |

### Network Layer

#### P2P Transport (`p2p.rs`)

TLS-based persistent connections between MPC nodes:

```mermaid
graph LR
    subgraph "Node A"
        SendA[TlsMeshSender]
        RecvA[TlsMeshReceiver]
    end

    subgraph "Node B"
        SendB[TlsMeshSender]
        RecvB[TlsMeshReceiver]
    end

    subgraph "Node C"
        SendC[TlsMeshSender]
        RecvC[TlsMeshReceiver]
    end

    SendA <-->|TLS 1.3| RecvB
    SendA <-->|TLS 1.3| RecvC
    SendB <-->|TLS 1.3| RecvA
    SendB <-->|TLS 1.3| RecvC
    SendC <-->|TLS 1.3| RecvA
    SendC <-->|TLS 1.3| RecvB

    style SendA fill:#ccffcc
    style SendB fill:#ccffcc
    style SendC fill:#ccffcc
```

**Key Features:**

- TLS 1.3 encryption for all peer communication
- TCP_NODELAY for low latency
- Keepalive mechanism (5-second intervals)
- Automatic reconnection on failure

#### Network Multiplexing (`network.rs`)

Manages multiple concurrent MPC protocol sessions:

- Each protocol run gets a unique `ChannelId`
- Messages routed to appropriate protocol instances
- LRU cache for handling out-of-order messages

### Storage Layer

#### SecretDB (RocksDB-based)

Persistent storage for cryptographic material:

| Column | Contents |
|--------|----------|
| `SignRequest` | Pending signature requests |
| `CKDRequest` | Pending CKD requests |
| `Triple` | Beaver triples for MPC |
| `Presignature` | Pre-generated partial signatures |
| `VerifyForeignTx` | Foreign chain verification state |

#### Keyshare Storage

Manages threshold key material with two backends:

- **Local**: Files on disk
- **GCP**: Google Cloud Storage for production

---

## Signature Request Flow

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Contract as MPC Contract<br/>(NEAR)
    participant Indexer as MPC Node Indexer
    participant Coord as Coordinator
    participant Provider as Signature Provider
    participant Network as P2P Network
    participant OtherNodes as Other MPC Nodes

    User->>Contract: sign(payload, path, domain_id)
    Note over Contract: Validate request<br/>Store in pending
    Contract-->>User: request_id

    rect rgb(240, 248, 255)
        Note over Indexer,OtherNodes: Off-Chain MPC Processing
        Indexer->>Indexer: Detect new block
        Indexer->>Indexer: Parse SignRequest event
        Indexer->>Coord: Notify: new signature request

        Coord->>Provider: Spawn signing job
        Provider->>Provider: Load keyshare
        Provider->>Provider: Acquire presignature

        Provider->>Network: Broadcast: start signing protocol
        Network->>OtherNodes: MpcStartMessage

        loop Protocol Rounds
            Provider->>Network: Send partial signature
            Network->>OtherNodes: MpcMessage
            OtherNodes->>Network: Partial signatures
            Network->>Provider: Receive partials
        end

        Provider->>Provider: Combine partials → final signature
        Provider->>Coord: Signature complete
    end

    Coord->>Contract: respond(request_id, signature)
    Note over Contract: Verify signature<br/>Clear pending request
    Contract-->>User: Signature delivered via callback

    User->>User: Use signature on target chain
```

### Flow Description

1. **Request Submission**: User calls `sign()` on the MPC contract with payload and derivation path
2. **Indexer Detection**: Each MPC node's indexer monitors NEAR blocks and detects the new request
3. **Coordinator Dispatch**: Coordinator spawns a signing job with the appropriate provider
4. **Protocol Execution**:
   - Provider loads its keyshare and acquires a presignature
   - Broadcasts protocol start to other nodes
   - Exchanges partial signatures over P2P network
   - Combines partials into final signature
5. **Response Submission**: One node submits the signature back to the contract
6. **Delivery**: Contract delivers signature to user via callback

---

## Key Generation & Resharing

### Key Generation Flow

```mermaid
sequenceDiagram
    autonumber
    participant Participants as MPC Participants
    participant Contract as MPC Contract
    participant Coord as Coordinators
    participant Network as P2P Network

    Participants->>Contract: vote_add_domains([new_domain])
    Note over Contract: Transition to Initializing state

    rect rgb(255, 250, 240)
        Note over Coord,Network: Distributed Key Generation
        Coord->>Coord: Detect Initializing state
        Coord->>Network: Reserve key_event_id

        loop FROST Keygen Protocol
            Coord->>Network: Keygen round messages
            Network->>Coord: Receive other shares
        end

        Coord->>Coord: Compute keyshare
        Coord->>Coord: Store keyshare locally
    end

    Coord->>Contract: vote_pk(key_event_id, public_key)
    Note over Contract: Collect votes

    alt Threshold votes received
        Contract->>Contract: Store public key
        Contract->>Contract: Transition to Running
    else Timeout or failure
        Participants->>Contract: vote_cancel_keygen()
        Contract->>Contract: Transition to Running (failed)
    end
```

### Resharing Flow

When the participant set changes (nodes added/removed) or threshold changes:

```mermaid
sequenceDiagram
    autonumber
    participant OldSet as Old Participants
    participant NewSet as New Participants
    participant Contract as MPC Contract
    participant Network as P2P Network

    OldSet->>Contract: vote_new_parameters(new_participants, new_threshold)
    Note over Contract: Transition to Resharing state

    rect rgb(255, 245, 238)
        Note over OldSet,NewSet: Resharing Protocol (per domain)
        OldSet->>Network: Share keyshare fragments
        NewSet->>Network: Participate in resharing

        loop For each domain
            OldSet->>Network: Resharing protocol messages
            NewSet->>Network: Receive and process
            NewSet->>NewSet: Compute new keyshare
        end

        NewSet->>NewSet: Store new keyshares
    end

    NewSet->>Contract: vote_reshared(key_event_id)
    Note over Contract: Collect votes from new set

    Contract->>Contract: Update participant set
    Contract->>Contract: Transition to Running

    Note over OldSet: Cleanup old keyshares
```

---

## Background Operations

MPC nodes continuously perform background operations to optimize signing performance:

### Beaver Triple Generation

```mermaid
graph LR
    subgraph "Background Triple Generation"
        Gen[Triple Generator] -->|Produces| Queue[Triple Queue<br/>Up to 1M triples]
        Queue -->|Consumed by| PreSig[Presignature Generator]
    end

    subgraph "Signing"
        PreSig -->|2 triples| PSig[Presignature]
        PSig -->|Used in| Sign[Signature Protocol]
    end

    style Gen fill:#e1ffe1
    style Queue fill:#fff4e1
    style Sign fill:#ccccff
```

**Beaver Triples**: Pre-computed values that enable efficient secure multiplication in MPC protocols.

- Generated continuously in background
- Each node both initiates and participates
- Up to 1 million triples stored per node

### Presignature Generation

**Presignatures**: Partially computed signatures that reduce online signing to a single round.

- Requires 2 Beaver triples per presignature
- Generated in background when triples available
- Dramatically speeds up signature requests

---

## Integration with NEAR Core Architecture

The MPC system integrates with NEAR's core infrastructure at multiple points:

```mermaid
graph TB
    subgraph "NEAR Core Node (nearcore)"
        subgraph "Blockchain Layer"
            Consensus[Nightshade Consensus]
            Sharding[Shard Management]
            Receipts[Receipt Routing]
        end

        subgraph "Runtime Layer"
            WASM[WASM VM<br/>Wasmer]
            Gas[Gas Metering]
            Tokens[Token Standards<br/>NEP-141]
        end

        subgraph "Storage Layer"
            Trie[State Trie]
            RocksDB[(RocksDB)]
        end
    end

    subgraph "MPC Contract (WASM)"
        ContractLogic[Contract Logic]
        SignRequests[Sign Request Queue]
        ParticipantState[Participant Registry]
        PublicKeys[Public Key Storage]
    end

    subgraph "MPC Node (Separate Process)"
        Indexer[NEAR Indexer<br/>Block Monitor]
        Coordinator[Coordinator]
        Providers[Signature Providers]
        P2P[P2P Network]
        LocalDB[(Local RocksDB)]
    end

    %% Contract execution
    ContractLogic -->|Compiled to| WASM
    WASM -->|Executes| ContractLogic
    WASM -->|Uses| Gas
    WASM -->|Manages| Tokens

    %% State storage
    SignRequests -->|Stored in| Trie
    ParticipantState -->|Stored in| Trie
    PublicKeys -->|Stored in| Trie
    Trie -->|Persisted to| RocksDB

    %% Cross-contract
    ContractLogic -->|Creates| Receipts
    Receipts -->|Routed by| Sharding

    %% MPC integration
    Indexer -.->|Reads blocks from| Consensus
    Coordinator -->|Submits tx to| ContractLogic
    Providers -->|Stores keys in| LocalDB

    style ContractLogic fill:#ccccff
    style Coordinator fill:#ccffcc
    style WASM fill:#fff4e1
    style Consensus fill:#e1f5ff
```

### Integration Points

| NEAR Component | How MPC Uses It |
|----------------|-----------------|
| **Runtime Layer** | MPC Contract executes as WASM in Wasmer VM |
| **Gas Metering** | Signature requests cost ~7 Tgas |
| **Token Standards** | Contract may integrate with NEP-141 for fees |
| **Receipt System** | Cross-contract callbacks for signature delivery |
| **State Trie** | Contract state (requests, keys, participants) stored here |
| **Consensus** | Finalizes signature responses on-chain |

### Key Differences from NEAR Intents

While both MPC Chain Signatures and NEAR Intents are part of NEAR's Chain Abstraction layer, they serve different purposes:

| Aspect | MPC Chain Signatures | NEAR Intents |
|--------|---------------------|--------------|
| **Purpose** | Sign transactions for external chains | Execute optimal swaps/trades |
| **Core Tech** | Threshold cryptography (FROST) | Solver network + escrow contracts |
| **On-Chain** | Single contract (v1.signer) | Verifier + Escrow contracts |
| **Off-Chain** | MPC nodes with P2P network | Solver network (market makers) |
| **Output** | Digital signatures | Completed token swaps |
| **Use Case** | Control Bitcoin/Ethereum accounts | Trade tokens across chains |

---

## Security Model

### Threshold Security

```mermaid
graph TB
    subgraph "Security Layers"
        L1[Threshold Cryptography<br/>t-of-n signatures required]
        L2[Key Isolation<br/>No single node has full key]
        L3[TLS Encryption<br/>All P2P traffic encrypted]
        L4[TEE Support<br/>Optional hardware security]
        L5[On-Chain Verification<br/>Contract validates responses]
    end

    L1 --> L2
    L2 --> L3
    L3 --> L4
    L4 --> L5

    L5 --> Security[Multi-Layer Security]

    style L1 fill:#e1f5ff
    style L2 fill:#fff4e1
    style L3 fill:#e1ffe1
    style L4 fill:#fffacd
    style L5 fill:#ccccff
    style Security fill:#ccffcc
```

### Security Properties

| Property | Implementation |
|----------|----------------|
| **Key Security** | No single node possesses complete private key |
| **Threshold** | Configurable t-of-n (e.g., 3-of-5) |
| **Network Security** | TLS 1.3 for all peer communication |
| **Replay Protection** | Nonce tracking in contract |
| **TEE Option** | Intel TDX/SGX for hardware isolation |
| **Economic Security** | MPC operators may stake NEAR |

---

## Key Modules Reference

### Node Crate (`crates/node/`)

| Module | File | Responsibility |
|--------|------|----------------|
| Coordinator | `coordinator.rs` | Main state machine, job orchestration |
| Protocol | `protocol.rs` | Generic threshold protocol execution |
| Network | `network.rs` | Message multiplexing, channel management |
| P2P | `p2p.rs` | TLS transport, persistent connections |
| Key Events | `key_events.rs` | Keygen and resharing logic |
| Indexer | `indexer/` | NEAR blockchain monitoring |
| Providers | `providers/` | Signature scheme implementations |
| Storage | `db.rs`, `storage.rs` | RocksDB and keyshare storage |

### Contract Crate (`crates/contract/`)

| Module | Directory | Responsibility |
|--------|-----------|----------------|
| Entry Points | `src/lib.rs` | Public contract methods |
| State Machine | `src/state/` | Protocol state transitions |
| Primitives | `src/primitives/` | Core types and configurations |

### Supporting Crates

| Crate | Purpose |
|-------|---------|
| `contract-interface` | DTOs for contract communication |
| `mpc-primitives` | Shared primitive types |
| `mpc-tls` | TLS transport implementation |
| `node-types` | Node-specific types, attestation |
| `tee-authority` | TEE validation logic |
| `foreign-chain-inspector` | Cross-chain verification |

---

## Further Reading

### MPC System
- [MPC GitHub Repository](https://github.com/near/mpc) - Source code and documentation
- [Chain Signatures Documentation](https://docs.near.org/concepts/abstraction/chain-signatures) - NEAR docs

### NEAR Core
- [NEAR Node Architecture Summary](near-node-architecture-summary.md) - Core protocol architecture
- [NEAR Protocol Specification](https://nomicon.io/) - Technical specification

### Cryptography
- [FROST Protocol](https://eprint.iacr.org/2020/852) - Threshold signature scheme
- [Cait-Sith Library](https://github.com/cronokirby/cait-sith) - Threshold ECDSA implementation
