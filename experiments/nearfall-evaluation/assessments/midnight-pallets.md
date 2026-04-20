# 🤖 Midnight's Standard Substrate Pallets

Substrate provides a library of pre-built, heavily audited microservices known as **FRAME pallets** (Framework for Runtime Aggregation of Modularized Entities). Midnight integrates several of these standard pallets to handle the "boring but critical" mechanics of the blockchain, freeing up the custom pallets to handle the advanced cryptography.

## 1. The Core Infrastructure Pallets

### `pallet-system` (The Nervous System)

This is the foundational pallet required by every Substrate blockchain. It doesn't handle tokens or smart contracts; it handles the base reality of the network.

- **Account Nonces:** It tracks the "nonce" (the transaction count) of every unshielded address. When you submit a transaction, this pallet checks the nonce to ensure you aren't accidentally submitting the same transaction twice (replay protection).
    
- **Block Metadata:** It stores the current block number, the hash of the previous block, and the size limits of the current block.
    
- **Event Routing:** When the custom Kachina pallet successfully verifies a ZK proof, it sends an "Event" to the System pallet, which then officially logs it into the block so the external Indexer can see it.
    

### `pallet-timestamp` (The Network Clock)

Because blockchain networks are distributed globally, agreeing on the exact time is notoriously difficult. This pallet forces the block producer (the validator) to embed a timestamp into every block, which the rest of the network verifies.

- **Midnight Specific Role:** While standard blockchains use timestamps mostly for block ordering, Midnight's custom `pallet-dust` relies on `pallet-timestamp` for its core tokenomics. Because unshielded NIGHT generates shielded DUST over time, the network must constantly ask the Timestamp pallet exactly how much time has passed since a user's last transaction to calculate their DUST battery recharge.
    

## 2. Economics and Execution Pallets

### `pallet-transaction-payment` (The Toll Booth)

In Substrate, every computation has a "Weight" (a measurement of how many picoseconds of CPU time and bytes of RAM an operation requires). This pallet converts that Weight into an actual financial fee.

- **Midnight Specific Role:** Midnight intercepts this standard pallet to accommodate its dual-token system. When you submit a transaction, this pallet calculates the Weight. Instead of just deducting standard NIGHT tokens, it communicates with the custom DUST pallet to deduct the equivalent value from your shielded DUST balance, ensuring the network is compensated for the heavy CPU load of verifying ZK-SNARKs.
    

### `pallet-balances` (The Transparent Ledger)

While Substrate's standard `pallet-balances` uses an account-based model (like Ethereum), Midnight heavily modifies or swaps this base logic to support an **Unspent Transaction Output (UTXO)** model (like Cardano and Bitcoin) for its base layer.

- However, the conceptual role remains the same: A foundational pallet is responsible for tracking the transparent, unshielded assets (NIGHT). It handles the basic math of addition and subtraction when you transfer transparent NIGHT, ensuring nobody spends more unshielded tokens than they actually have.
    

### `pallet-utility` (The Batch Processor)

This is a standard quality-of-life pallet that allows users to wrap multiple different transactions into a single payload.

- **Midnight Specific Role:** In Midnight, complex dApp interactions might require a user to execute a transparent NIGHT transfer and submit a shielded ZK proof at the exact same time. The Utility pallet allows the wallet to "batch" these intents together. If one part of the batch fails, the entire transaction reverts, preventing the public and private states from falling out of sync.
    

## 3. Midnight's Custom Substrate Pallets (On-Chain)

While standard pallets handle the basics, Midnight relies heavily on custom, proprietary pallets to achieve its hybrid public/private architecture.

### `pallet-kachina` (The ZK Proof Verifier)

This is the heart of Midnight. It does _not_ execute smart contracts in the way Ethereum's EVM does — the actual contract logic runs off-chain on the client. Instead, `pallet-kachina` is responsible for **verifying** the zero-knowledge proofs that prove off-chain execution was correct.

- **Proof Verification:** When a user submits a transaction, the payload contains a fully-formed ZK-SNARK. Kachina runs the Plonk/KZG verifier against this proof. If the math checks out, the state transition is accepted; if it fails, the transaction is rejected with no side effects.

- **Nullifier Set Management:** To prevent double-spending of shielded coins, Kachina maintains the on-chain nullifier set. Every time a shielded input is consumed, its unique nullifier is added to this ever-growing set. Before accepting a proof, Kachina checks that none of the declared nullifiers already appear in the set.

- **Public State Commitment Updates:** When contract logic modifies public state (e.g., a token's total supply), Kachina writes the new commitment root into the on-chain state trie. This root is what other contracts and clients can later query or prove membership against.

### `pallet-dust` (The Fee Battery)

This manages Midnight's unique battery-recharge tokenomics. Rather than charging gas fees in the primary token at the moment of each transaction, Midnight uses a time-accrual model where holding unshielded NIGHT passively generates spendable DUST.

- **Accrual Calculation:** `pallet-dust` reads the current timestamp from `pallet-timestamp` and compares it to the last-recorded time for each unshielded NIGHT holding. The difference, multiplied by the holder's NIGHT balance, determines how much DUST has recharged into the account's shielded battery.

- **Fee Deduction:** When `pallet-transaction-payment` calculates the Weight cost for a ZK proof verification, `pallet-dust` intercepts the fee request and deducts the equivalent from the submitter's DUST balance instead of their visible NIGHT balance. This preserves transaction privacy: the fee payment itself does not leak information about the user's shielded token holdings.

### `pallet-minotaur` (The Partner Chain Consensus Bridge)

Because Midnight operates as a Cardano Partner Chain rather than a sovereign Substrate chain, it cannot use standard Substrate proof-of-stake. This pallet implements the Minotaur protocol, which anchors block production to Cardano's existing validator set.

- **SPO-Based Validation:** Cardano Stake Pool Operators (SPOs) validate Midnight blocks using their existing Cardano stake as the economic backing. `pallet-minotaur` receives Cardano epoch data (the active SPO set and their relative stake weights) and uses it to determine which nodes are eligible to produce Midnight blocks in a given slot.

- **Cross-Chain Finality Anchor:** By inheriting Cardano's Ouroboros finality, Midnight avoids the need to bootstrap an independent validator economy. This also means Midnight's security budget is tied to the value of ADA staked, not a separate Midnight-native staking token.

### Assets / Tokens Pallet (The Transparent Ledger)

This pallet handles the public ledger side of Midnight's dual-token world: the unshielded NIGHT balance sheet and the public tracking for any transparent custom tokens deployed by dApps.

- **Unshielded NIGHT Balances:** Every account's publicly visible NIGHT balance is stored and updated here. Transfers of unshielded NIGHT are settled by this pallet using straightforward addition and subtraction, with overdraft protection.

- **Custom Transparent Tokens:** dApp developers can issue non-fungible or fungible tokens whose balances are fully visible on-chain. These tokens do not interact with the ZK layer; they are tracked purely within this pallet's key-value storage, analogous to how ERC-20 balances are stored in Ethereum's state trie.

## 4. Components OUTSIDE the Pallet System

Because pallets must be executed by every single node on the network to reach consensus, they must be deterministic, public, and incredibly lightweight. Therefore, anything that is heavy, private, or complex must exist **outside** the pallet system.

### Local Proof Server (Client-Side Prover)

Generating a zero-knowledge proof requires heavy computation — often several seconds on a modern machine — and direct access to the user's private, unencrypted data. If proof generation were a pallet, every node would need the user's private inputs, defeating the privacy model entirely. Instead, the proof server runs locally as a separate Wasm/Rust binary alongside the user's wallet.

- **Workflow:** The wallet hands the proof server the circuit (compiled from the dApp's Compact source), the private inputs (token amounts, secret keys, Merkle paths), and the public inputs. The server executes the circuit, generates the Plonk proof, and returns the compact proof blob — typically 1–2 KB — to the wallet, which then assembles the full transaction payload for submission.

- **Security boundary:** The proof server is a trust boundary: private data never leaves the local machine. Its correctness is guaranteed by the math of the ZK system, not by any on-chain enforcement. If the server is compromised, the attacker can learn the user's private data but cannot forge a valid proof accepted by `pallet-kachina`.

### Private State Store

Substrate pallets manage the on-chain Wasm state trie, which is 100% public and replicated across every node on the network. Contract private variables (balances, secrets, internal counters visible only to the contract owner) cannot live there. Instead, the wallet SDK persists private state in a local encrypted database — typically LevelDB — on the user's device.

- **Encryption:** The store is encrypted with a key derived via PBKDF2 from the wallet's encryption public key (as seen in the `levelPrivateStateProvider` of the wallet SDK). This means private state is wallet-specific: a new wallet instance cannot read a previous wallet's store without re-deriving the same key.

- **State Recovery:** Because private state is local-only, a user who loses their device loses their private state. Recovery requires the original mnemonic and replaying all relevant transactions from the chain to reconstruct the private state from scratch — an operation that the wallet SDK supports through its sync mechanism but which can be slow for wallets with long histories.

### Indexer (GraphQL API)

Substrate nodes are optimized for block production, not for the kinds of rich queries wallets and dApps require (e.g., "give me all transactions involving this shielded address in the last 30 days"). Exposing those queries directly to a Substrate node would be ruinously expensive and could destabilize the node under load.

- **Event Ingestion:** The Indexer subscribes to the Substrate node's event stream. When `pallet-kachina` emits a proof-verified event or `pallet-dust` emits a fee-deducted event, the Indexer captures it and writes the structured data into a PostgreSQL database optimized for the access patterns of wallet UIs and block explorers.

- **GraphQL Surface:** The Indexer exposes this data via a GraphQL API, allowing wallets to efficiently query transaction history, contract state snapshots, and nullifier inclusion — without those queries ever touching the Substrate node. This separation also means the Indexer can be scaled horizontally independently of the validator infrastructure.

### Compact Compiler and Circuits

In Ethereum, the EVM is embedded in every node; deploying a contract means uploading bytecode that all nodes can execute. Midnight nodes have no equivalent virtual machine. The Compact language compiler lives entirely off-chain, on the developer's machine.

- **Compilation Output:** The Compact compiler translates a `.compact` source file into two artifacts: a Prover Key (the circuit's full description, used by the proof server to generate proofs) and a Verifier Key (a compact mathematical summary used by `pallet-kachina` to verify proofs). Only the Verifier Key is uploaded to the chain at deployment time.

- **Consequence for Upgrades:** Because no executable bytecode lives on-chain, Midnight does not have an equivalent of Ethereum's `DELEGATECALL`-based proxy upgrade pattern. Upgrading a contract's logic requires deploying a new contract address with a new Verifier Key, and migrating users to the new address. This is a deliberate design choice — the on-chain state contains only mathematical commitments, not mutable code — but it imposes a different upgrade discipline on dApp developers.
    

## The Interoperability Dance: A Transaction's Journey

To see how perfectly the standard pallets, custom pallets, and off-chain components interoperate, look at what happens when you run a zero-knowledge `mint` transaction:

1. **Proof Server (Off-Chain):** Your local machine executes the circuit, generating the ZK proof using your private data.
    
2. **`pallet-system` (Standard):** Receives your transaction and verifies your unshielded address's signature and nonce.
    
3. **`pallet-transaction-payment` (Standard):** Looks at the payload, realizes it contains a ZK proof, and calculates a massive "Weight" for the CPU execution.
    
4. **`pallet-dust` (Custom):** Intercepts the fee request, checks your local DUST battery, and deducts the required fuel.
    
5. **`pallet-kachina` (Custom):** Now that the fee is paid, this pallet takes over. It verifies the math of your ZK proof and records your new Nullifiers.
    
6. **`pallet-system` (Standard):** The Kachina pallet tells the System pallet, _"Verification successful."_ The System pallet officially logs the event into the new block.
    
7. **The Indexer (Off-Chain):** Sees the event logged in the block and updates its database so your wallet UI can display your new balance.
    

### Summary Analogy

If you think of Midnight as a restaurant:

- **The Pallets** are the strict health inspectors at the door. They check the math (Kachina), charge you the Wasm fee (DUST), and make sure you belong there (Minotaur).
    
- **The Non-Pallet Components** (Proof Server, Private State) are your private kitchen at home, where you actually cook the meal (the transaction) before putting it in a sealed box to show the inspector!

## Sources

- [Midnight ledger spec](https://github.com/midnightntwrk/midnight-ledger/tree/main/spec)
- [dust.md — DUST accrual and fee battery mechanics](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/dust.md)
- [onchain-runtime.md — on-chain stack machine instruction set](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/onchain-runtime.md)
- [Substrate FRAME pallets reference](https://docs.substrate.io/reference/frame-pallets/)
- [Midnight node GitHub](https://github.com/midnightntwrk/midnight-node)
- [Midnight developer documentation](https://docs.midnight.network)
- background/midnight-architecture.md — internal Midnight architecture reference

---

## Afterword: Quality Scrutiny

### 1. Sources Correspond to Retrievable URLs

- **The document contains no `## Sources` section and no citations of any kind.** This is a structural violation of the repository convention defined in AGENTS.md, which requires every assessment to include a `## Sources` section.
- The Midnight ledger spec (https://github.com/midnightntwrk/midnight-ledger/tree/main/spec) is publicly accessible. The two sub-files most relevant to the claims here — `dust.md` and `onchain-runtime.md` — were fetched successfully.
- The Substrate FRAME documentation at `https://docs.substrate.io/reference/frame-pallets/` redirects to the Polkadot Developer Docs; the five standard pallets named (system, timestamp, transaction-payment, balances, utility) are confirmed to exist via the Polkadot documentation and paritytech GitHub repositories.
- All other technical claims (Plonk/KZG, LevelDB, PBKDF2, proof blob size, Minotaur epoch-data interface, Assets pallet name) lack any cited source.

### 2. Internal Consistency

- **`pallet-balances` vs. Assets/Tokens Pallet tension.** Section 2 describes `pallet-balances` as "heavily modified or swapped" to support a UTXO model, while Section 3 introduces a separate unnamed "Assets / Tokens Pallet" that handles "unshielded NIGHT balances." The document never reconciles these: is `pallet-balances` the Assets pallet after modification, or a distinct pallet that was replaced? The relationship is left unresolved.
- **UTXO model vs. account nonces.** The document states Midnight uses a UTXO model (Section 2, `pallet-balances`), but the transaction journey (Step 2) says `pallet-system` "verifies your unshielded address's signature and **nonce**." Nonce-based replay protection is an account-model concept; UTXO chains use input-reference uniqueness instead. These two statements are in tension.
- **Fee privacy claim.** The document claims that routing fees through `pallet-dust` "preserves transaction privacy: the fee payment itself does not leak information about the user's shielded token holdings" (Section 3, `pallet-dust`). However, the same document notes that Dust accrues from publicly visible unshielded NIGHT holdings, which are themselves public. The privacy benefit described is real but the framing overstates it slightly — an observer can infer a user has nonzero DUST from their public NIGHT balance.
- The "battery recharge" metaphor is applied consistently throughout and the analogy is internally coherent, though the terminology does not come from the spec (see §3 below).

### 3. Accuracy Against Sources

- **Dust accrual mechanism.** `dust.md` confirms time-proportional accrual from Night holdings at a rate of "approximately one week" to reach the cap, and confirms Dust is non-transferable and usable only for fees. The document's description is broadly accurate.
- **`pallet-timestamp` dependency for Dust.** The document states that "`pallet-dust` reads the current timestamp from `pallet-timestamp`." `dust.md` makes no mention of `pallet-timestamp` or any Substrate pallet; it specifies the accrual math but not the implementation mechanism. This claim is a reasonable implementation inference but is not sourced.
- **"Battery recharge" terminology.** This metaphor does not appear in the spec. It is the document's own framing, not Midnight's official terminology.
- **Plonk/KZG verifier.** The document states "`pallet-kachina`… runs the Plonk/KZG verifier." Neither `onchain-runtime.md` nor `dust.md` mentions Plonk, KZG, or `pallet-kachina` — `onchain-runtime.md` covers only the stack machine instruction set and contains nothing about ZK proof verification. This claim may be correct but it is entirely unsourced from the retrieved spec files.
- **Proof blob size "typically 1–2 KB."** Specific quantitative claim with no cited source.
- **Private state store uses LevelDB encrypted with PBKDF2.** The wallet SDK contains a `levelPrivateStateProvider` API (observable in experiment source code), but neither LevelDB nor PBKDF2 is confirmed by any document retrieved; both are unverified specifics.
- **`onchain-runtime.md` is irrelevant to the pallet architecture.** That document covers the on-chain stack machine instruction set only; it contains no information about pallets, ZK verification, nullifier sets, or fees. It cannot be used to verify or refute any claim in this document.
- **Standard FRAME pallets** (system, timestamp, transaction-payment, balances, utility) are confirmed to be real Substrate/FRAME components.
- **Minotaur protocol, SPO-based validation, and ADA-backed security budget.** These claims are consistent with Midnight's public positioning as a Cardano Partner Chain, but no spec document or official source is cited.

### 4. Areas of Greatest Uncertainty

- **All custom pallet descriptions (kachina, dust, minotaur, assets).** Every substantive claim about these pallets — their internal logic, inter-pallet communication, and specific mechanisms — is entirely unsourced. The descriptions are plausible and internally coherent, but none can be traced to a retrievable document.
- **Plonk/KZG as the proof system.** Midnight has been publicly described as using Plonk-family proofs, but no spec doc retrieved here confirms it, and the specific claim of KZG polynomial commitments is unverified.
- **LevelDB + PBKDF2 for private state.** Two specific technology choices stated as facts with no source.
- **The UTXO/nonce inconsistency** (see §2). It is unclear whether the transaction journey accurately describes Midnight's nonce handling, or whether the account-model framing was inadvertently imported from a generic Substrate description.
- **The "Assets / Tokens Pallet" identity.** No pallet name is given. It is unclear whether this is `pallet-assets` (the standard FRAME assets pallet), a custom Midnight pallet, or a renamed `pallet-balances`. The absence of a specific name makes this section unverifiable.
- **Circular internal corroboration.** All internal repository evidence for these claims (journal entries, other assessments) traces back to this document. There is no independent internal source that corroborates the pallet details from a different angle.

### 5. Robustness of Primary Conclusions

The document's central thesis — that Midnight uses a combination of standard FRAME pallets for infrastructure and custom pallets for ZK proof verification, DUST fee management, and Cardano consensus anchoring, with heavy computation pushed off-chain to the proof server — is **plausible and broadly consistent** with Midnight's public architectural positioning.

However, this conclusion rests almost entirely on uncited claims. The specific details that distinguish this description from a generic Substrate-based ZK chain (Plonk/KZG, `pallet-kachina` structure, DUST accrual formula, Minotaur protocol mechanics) are unverifiable from the sources provided. If these specifics are wrong, the high-level structural picture would likely survive — there is certainly a ZK verifier pallet, a fee pallet, and a consensus pallet — but the described mechanics could differ materially from the actual implementation.

The UTXO/nonce inconsistency is the one place where a specific claim could be **outright wrong** rather than merely imprecise: if Midnight's unshielded layer is fully UTXO-based, the nonce description in the transaction journey is incorrect, which would undermine the accuracy of the document's most concrete walkthrough.

**Overall assessment:** Useful as a high-level orientation document, but should not be relied on for implementation details without cross-checking against Midnight's source code or internal technical documentation. The absence of a Sources section is the document's most significant quality gap.