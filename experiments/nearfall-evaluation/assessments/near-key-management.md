# 🤖👱 NEAR Key Management and Key Structure

## 1. Account Model

NEAR accounts maintain an on-chain map of `PublicKey → AccessKey` entries. An account can hold **multiple active keys simultaneously** — this is a first-class protocol feature, not a contract abstraction. Every NEAR account is identified by a human-readable account ID (or an implicit 64-hex-char ID) and optionally holds a deployed smart contract in the same address space.

### Account ID Types

| Type | Description |
|---|---|
| **Named accounts** | Human-readable (e.g., `alice.near`, `app.alice.near`). Follow a hierarchical domain-like structure: only `alice.near` can create `sub.alice.near`. Top-level accounts shorter than 32 characters can only be created by a privileged registrar contract. |
| **Ed25519 implicit accounts** | A 64-character lowercase hex string encoding the raw 32-byte Ed25519 public key. Latent until funded; activated (storage allocated on-chain) upon first token receipt. |
| **Secp256k1 / ETH-implicit accounts** | Derived as `'0x' + keccak256(uncompressed_pubkey)[12:32].hex()`, matching Ethereum address conventions. Automatically receive an Ethereum-compatible Wallet Contract; cannot have full-access keys added and cannot be deleted. |

---

## 2. Named Account Registration

### 2.1 Registration Database

NEAR's account registry is stored in a **Borsh-serialized Merkle-Patricia Trie**, one per shard. Every account's data is collocated within a single shard, with shard assignment determined by account ID prefix. The trie is organized using a `TrieKey` enum with a leading-byte column discriminant:

| `TrieKey` Variant | Col | Content |
|---|---|---|
| `Account` | 0 | Account struct: `amount`, `locked`, `code_hash`, `storage_usage` |
| `ContractCode` | 1 | Raw WASM bytecode |
| `AccessKey` | 2 | Per-key entry: `(account_id, public_key) → AccessKey` |
| `ContractData` | 9 | Contract KV storage: `(account_id, key) → value` |
| `GlobalContractCode` | 18 | Globally deployed contract bytecode (shared by reference) |

The canonical `Account` struct fields:

| Field | Type | Description |
|---|---|---|
| `amount` | u128 yoctoNEAR | Liquid (unlocked) balance |
| `locked` | u128 yoctoNEAR | Staking-locked balance |
| `code_hash` | CryptoHash | SHA-256 of deployed WASM; `EMPTY_HASH` if no contract |
| `storage_usage` | u64 bytes | Total trie bytes consumed by this account (drives storage staking) |
| `global_contract_hash` | Option\<CryptoHash\> | Reference to a globally deployed contract by hash (immutable) |
| `global_contract_account_id` | Option\<AccountId\> | Reference to a global contract by owner (auto-upgrades on redeploy) |

Access keys are **not** stored in the `Account` struct; they are separate `TrieKey::AccessKey` entries.

Storage staking rate: **1 NEAR per 100 KB** (10¹⁹ yoctoNEAR per byte). A bare account with one FullAccess key costs approximately **0.00182 NEAR** at minimum. If `amount` would drop below the storage staking floor, transactions fail with `LackBalanceForState`.

### 2.2 Name Storage: Literal, Not Hashed

Account names are stored **literally** in the trie, not as hashes. Every state entry for an account uses a `TrieKey` whose binary encoding contains the raw UTF-8 bytes of the account ID:

```
[1-byte column discriminant] ++ [account_id as UTF-8 bytes] ++ [optional suffix]
```

Concrete examples:

| Entry | Trie key structure |
|---|---|
| Account struct | `\x00` ++ `alice.near` |
| Access key | `\x02` ++ `alice.near` ++ `\x00` ++ `ed25519:<pubkey bytes>` |
| Contract code | `\x01` ++ `alice.near` |
| Contract KV entry | `\x09` ++ `alice.near` ++ `\x00` ++ `<storage key bytes>` |

The Patricia trie routes on the **bits of those raw bytes**, so all entries for `alice.near` share a common prefix path through the trie and are naturally collocated on the same shard (shard assignment is also determined by reading the account ID prefix literally).

Consequences:
- The name is always recoverable from state — accounts can be enumerated by scanning trie keys; no preimage table is needed.
- Longer names consume more key bytes, marginally increasing trie node overhead (though this is small compared to value storage).
- This contrasts with Ethereum, where accounts are keyed by the 20-byte keccak hash of the address and human-readable names (ENS) are an application-layer contract with no protocol standing.

### 2.3 Account Name Rules

| Rule | Specification |
|---|---|
| Length | 2–64 characters |
| Allowed characters | Lowercase `a–z`, digits `0–9`, separators `.` `-` `_` |
| Cannot start or end with | `.`, `-`, or `_` |
| Consecutive separators | Forbidden (`..`, `--`, `__`, `.-`, etc.) |
| 64-char all-lowercase-hex | Reserved: Ed25519 implicit account |
| `0x` + 40 lowercase hex | Reserved: ETH-implicit account (Secp256k1) |

### 2.3 The `CreateAccount` Action

`CreateAccountAction` carries no payload. Its behavior is determined entirely by the transaction's `receiver_id` (new account ID) and `predecessor_id` (account initiating creation).

**Protocol rules:**

1. `receiver_id` must not already exist (`AccountAlreadyExists` error otherwise).
2. **Top-level account (TLA) rule:** If `receiver_id` has no dots and its length is ≤ 32 characters, `predecessor_id` must equal the genesis `registrar_account_id`; otherwise `CreateAccountOnlyByRegistrar`.
3. **Sub-account rule:** `receiver_id` must end with `.predecessor_id`; otherwise `CreateAccountNotAllowed`. Only the **direct parent** can create a sub-account.
4. **Implicit account rule:** 64-hex-char `receiver_id` values are disallowed with `CreateAccount`. Implicit accounts come into existence only via a `Transfer` to that ID — preventing hijack before the key holder arrives.

**Post-creation state:** The account is written with `amount = 0`, `locked = 0`, `code_hash = EMPTY_HASH`. No keys are added automatically; `AddKey` actions must follow in the same transaction batch to make the account usable.

**Typical sub-account creation batch:**
```
[CreateAccount, Transfer { deposit: initial_balance }, AddKey { public_key, FullAccess }]
```

### 2.4 Registrar for Top-Level Accounts

**`.near` sub-accounts** (e.g., `alice.near`) are created by calling the `create_account` method on the `near` account (which holds the registrar contract). Only `near` can be `predecessor_id` for `alice.near` per rule 3.

**Short TLAs (≤ 32 characters)** require creation by the genesis `registrar_account_id`. The registrar was designed to run a **commit-reveal Vickrey auction**:

- Phase 1 (7 days): Participants submit hidden bids (encrypted commitment).
- Phase 2 (7 days): Bidders reveal amounts.
- Phase 3: Winner pays the second-highest bid; revenue is burned.

Names are released on a deterministic schedule: `sha256(account_id) % 52` = release week, staggering all names over a year. Long TLAs (> 32 chars) are first-come-first-served. In practice the formal auction was not fully operationalized for all names; the NEAR Foundation administered notable short TLAs by policy.

**Front-running prevention:** Sub-account creation cannot be front-run — no other `predecessor_id` can legally issue `CreateAccount` for `sub.alice.near`. The commit-reveal auction prevents TLA front-running. Implicit accounts are cryptographically bound to their key, so intercepting the account ID gives an attacker nothing.

### 2.5 LinkDrop: Onboarding Without an Existing Account

LinkDrop solves the bootstrapping problem (you need an account to create an account):

1. **Sender** generates a temporary keypair `(pk1, sk1)`, calls `linkdrop.send(pk1)` with a NEAR deposit. The contract stores `pk1 → deposit`.
2. Sender shares a URL containing `sk1` (QR code, link, etc.).
3. **Recipient** opens the URL in a wallet, generates a fresh keypair `(pk2, sk2)`, and chooses an account name.
4. Wallet signs a call with `sk1` to `linkdrop.create_account_and_claim(new_account_id, pk2)`.
5. The contract executes `[CreateAccount, Transfer, AddKey(pk2, FullAccess)]` for the new account.

### 2.6 Security: No KYC or Identity Layer

There is no protocol-level KYC, identity verification, or dispute resolution. Account names are pseudonymous. The `near` Foundation's role is limited to controlling the `registrar` account. Third-party name marketplaces are application-layer contracts. NEAR has no protocol equivalent to DNS disputes or ICANN.

### 2.7 Revocation and Deletion

The `DeleteAccount` action:

```rust
pub struct DeleteAccountAction {
    pub beneficiary_id: AccountId,
}
```

- Must be the **last action** in its transaction.
- Account must have **no locked (staked) balance**.
- **Postconditions:** All state wiped (account record, contract code, access keys, contract KV storage). Liquid balance transferred to `beneficiary_id`. Account ID freed for future re-creation.
- Only the account itself (via a FullAccess key) can execute `DeleteAccount`. Function-call keys cannot.

**Parent authority after creation: none.** The hierarchical naming is purely nominal — it is not an authority tree.

- `alice.near` **cannot** delete, modify, or add keys to `sub.alice.near`.
- Deleting `alice.near` does **not** affect `sub.alice.near`.
- Sub-accounts are fully independent from the moment of creation.

**Accounts with zero balance are not automatically deleted.** There is no autonomous account-state garbage collection in NEAR, and none has ever shipped. What NEAR calls "GC" in its codebase is exclusively **block/chunk/trie-history GC**: on non-archival nodes it removes historical snapshots older than ~5 epochs (~2.5 days), triggered automatically after each new block. It does not touch live account state. The runtime unconditionally writes an account back to the trie after applying actions, regardless of balance.

*Account hibernation* (collapsing state to a Merkle root) was described in the original NEAR economics whitepaper but was explicitly deferred at launch and never implemented.

**NEP-448 (shipped February 2023)** went in the opposite direction: accounts with ≤ 770 bytes of storage (a bare account plus a few keys) are entirely exempt from the storage-staking balance floor. Creating such an account burns gas rather than requiring a NEAR deposit, so small accounts no longer need a minimum balance to exist.

An account that falls below the storage-staking floor (for larger accounts that exceed 770 bytes) is frozen for sending (`LackBalanceForState` on any state-adding transaction) but can still receive inbound transfers. It persists indefinitely until explicitly deleted via `DeleteAccount`.

**Token-loss risk from explicit deletion.** The NEAR documentation warns of a real fund-loss scenario that is sometimes described — misleadingly — as a GC risk. The actual cause is explicit `DeleteAccount`, not autonomous cleanup:

1. Account A sends all its funds to a non-existent Account B.
2. The transfer fails; a **refund receipt** is generated back to A and is in-flight for 1–2 blocks.
3. While the refund is in-flight, A has zero balance. A concurrent `DeleteAccount` on A (from a separate transaction or contract call) succeeds.
4. The refund receipt arrives at the now-deleted account. Per the Nomicon spec, **the refund amount is burned**.

A related variant: `DeleteAccount { beneficiary_id }` where `beneficiary_id` does not exist — the account is deleted, the balance transfer to the beneficiary fails, and the funds are burned.

**Interaction with implicit accounts.** A never-funded implicit account (latent 64-hex address) can be activated by a direct single-action `Transfer` transaction, which creates and funds the account atomically (NEP-71, protocol v35). Once created, it persists even at zero balance. However, **refund receipts do not trigger implicit account creation** — if a refund is routed to a 64-hex address for an account that does not yet exist, the receipt fails and the amount is burned.

### 2.8 Transfer of Account Ownership

NEAR has **no first-class "transfer account" primitive**. Ownership is entirely defined by who holds the FullAccess keys. To transfer control:

1. Add the new owner's public key as FullAccess (`AddKey`).
2. Delete all of the previous owner's FullAccess keys (`DeleteKey` for each).

There is no on-chain ownership history or event emitted. Account names are not NFTs and cannot be atomically swapped or listed on exchanges at the protocol level. Application-layer escrow contracts could implement name sales, but the protocol itself does not support atomic name transfers.

### 2.9 Key Rotation

Standard rotation batches both actions targeting the account itself:

```
[AddKey { new_key, FullAccess }, DeleteKey { old_key }]
```

Because both actions target the same account (`receiver_id == signer_id`), they are folded into a single `ActionReceipt` on the account's shard. Receipts are atomic — either all actions execute or none do.

**Keyless (frozen) accounts:** If all FullAccess keys are removed and no contract is deployed, the account is permanently frozen — no external party can transact on its behalf. If a contract is deployed, it can call `AddKey` via a promise to unlock the account under contract-defined conditions (e.g., multisig threshold, recovery flow).

**No protocol-level timelocks or social recovery.** NEP-518 proposed future account abstraction (timelocks, guardian recovery), but as of 2025 these are not protocol primitives. All such mechanisms must be implemented at the contract layer (e.g., `lockup.near` for vesting, multisig contracts for guardian recovery).

---

## 3. Access Key Permission Levels

NEAR defines exactly two permission levels for access keys, encoded in the `AccessKeyPermission` enum: `FullAccess` and `FunctionCall`. Every access key also carries a per-key nonce.

### 3.1 Nonce

Every `AccessKey` record contains a **nonce** scoped to the `(account_id, public_key)` pair — different keys on the same account have independent nonces, avoiding cross-key replay confusion. A transaction's nonce must be strictly greater than the key's current nonce; upon acceptance the nonce is updated. New keys are initialized with a nonce derived from `block_height × MULTIPLIER`. If a key is deleted and re-added with the same public key, the new key's nonce must still exceed whatever the old key's nonce reached.

### 3.2 Full Access Keys

A `FullAccess` key authorizes all action types. The complete set:

| Action | What it does |
|---|---|
| `CreateAccount` | Creates a new sub-account with `id == receiver_id` |
| `DeployContract` | Installs or replaces WASM bytecode on the receiver account |
| `FunctionCall` | Invokes a named export on the receiver's contract; carries `method_name`, `args`, `gas`, and `deposit` |
| `Transfer` | Moves yoctoNEAR from signer to receiver |
| `Stake` | Emits a validator-seat proposal (see section 3.5); `stake = 0` unstakes |
| `AddKey` | Attaches a new access key (`FullAccess` or `FunctionCall`) to the account |
| `DeleteKey` | Removes an existing access key by public key |
| `DeleteAccount` | Destroys the account; sweeps balance to `beneficiary_id`; must be last action in batch |
| `DelegateAction` | Wraps a `SignedDelegateAction` for meta-transaction relaying (NEP-366) |
| `DeployGlobalContract` | Deploys WASM globally by hash for cross-shard reuse |
| `UseGlobalContract` | Attaches a globally deployed contract to this account by reference |

The actions `DeployContract`, `Stake`, `AddKey`, `DeleteKey`, and `DeleteAccount` all require `FullAccess`; submitting them signed by a `FunctionCall` key returns `InvalidAccessKeyError::RequiresFullAccess`.

### 3.3 Function Call Keys

A `FunctionCall` key carries three fields:

```rust
pub struct FunctionCallPermission {
    pub allowance: Option<Balance>,  // None = unlimited; Some(n) = cap in yoctoNEAR
    pub receiver_id: AccountId,      // exactly one authorized contract
    pub method_names: Vec<String>,   // empty = any method; non-empty = exact-match allowlist
}
```

**Runtime validation** (performed in order at transaction ingestion):

1. **Single action, FunctionCall type only.** Any other action type or more than one action returns `RequiresFullAccess`.
2. **Zero deposit.** Any `deposit > 0` returns `DepositWithFunctionCall`. A deposit of exactly zero is permitted; the called contract will see `env::attached_deposit() == 0`.
3. **Receiver match.** `tx.receiver_id` must equal `permission.receiver_id`; otherwise `ReceiverMismatch`.
4. **Method name match.** If `method_names` is non-empty, `tx.method_name` must appear in the list (exact string equality, case-sensitive, no globs or patterns); otherwise `MethodNameMismatch`.
5. **Allowance sufficiency.** If `allowance == Some(n)`, the total transaction cost must not exceed `n`; otherwise `NotEnoughAllowance`.

**Allowance behaviour:**
- When allowance reaches `Some(0)` the key is not automatically deleted — it remains in the trie but cannot sign any paid transaction. It must be explicitly removed with `DeleteKey` (FullAccess required).
- Setting `allowance = Some(0)` at creation produces a key that can never be used. This is a known foot-gun.
- Gas refunds partially restore allowance after execution (best-effort: silently dropped if the key was deleted before the refund receipt arrives).
- There is no `UpdateKey` or `SetAllowance` action. Topping up requires deleting and re-adding the key.

**Other behaviours:**
- `receiver_id` may equal `signer_id` (self-calls are permitted).
- Key permission checks apply only at transaction ingestion. Cross-contract receipts generated by the called contract are not subject to the originating key's restrictions.
- The 1 yoctoNEAR security deposit pattern used by many NEP-141 and NEP-171 operations cannot be satisfied by a FunctionCall key, since any nonzero deposit is forbidden.

### 3.4 Delegate Actions (NEP-366 Meta-Transactions)

A `DelegateAction` wraps a signed inner action list for submission by a relayer. The relayer pays all gas; the user's key provides authorization.

```rust
pub struct DelegateAction {
    pub sender_id: AccountId,
    pub receiver_id: AccountId,
    pub actions: Vec<Action>,         // must not contain another DelegateAction
    pub nonce: Nonce,
    pub max_block_height: BlockHeight, // expiry; transaction rejected if current height ≥ this
    pub public_key: PublicKey,
}
```

Both key types can sign a `DelegateAction`, with different inner-action restrictions:

| Signing key | Inner actions permitted |
|---|---|
| `FullAccess` | Any valid action except a nested `DelegateAction` |
| `FunctionCall` | Exactly one `FunctionCall`; `receiver_id` and `method_name` must satisfy the key's constraints |

**Allowance is not checked** when a FunctionCall key signs a `DelegateAction` — the relayer absorbs the cost. This means a key with exhausted or zero allowance can still authorize meta-transactions. The `max_block_height` field is the only time-bound in the key system; keys themselves have no TTL.

Validation sequence: transaction receiver must equal `sender_id`; signature must verify; block height must be within bound; nonce must be fresh; if FunctionCall key, receiver and method constraints apply; inner actions must not nest another `DelegateAction`.

### 3.5 Validator and Node Keys

NEAR validators use three distinct key types, only one of which is an account access key:

| Key | Storage | Purpose |
|---|---|---|
| **`node_key.json`** | Node filesystem | Signs p2p network messages (peer discovery, block gossip). Never used on-chain. |
| **`validator_key.json`** | Node filesystem | Signs block proposals and chunk attestations during consensus. Referenced as `public_key` in `StakeAction`. Must be present on the live node at all times. |
| **Account access key** | On-chain trie | Signs the `StakeAction` transaction that registers or updates the validator position. A `FullAccess` key. |

The validator key in `StakeAction` is entirely separate from the account's access keys. If the validator node is compromised, the attacker obtains the validator key but not the account's access keys — they cannot transfer funds, add keys, or delete the account. Changing the validator key during an active staking epoch causes missed blocks and risks ejection from the active set.

### 3.6 ETH-Implicit Account Keys

ETH-implicit accounts (IDs matching `0x[0-9a-f]{40}`) are subject to protocol-enforced key restrictions:

- `AddKey` with `FullAccess` permission is **rejected**.
- `DeleteAccount` is **rejected**.

When first funded, the protocol automatically deploys a **Wallet Contract** and installs a FunctionCall key permitting only calls to `rlp_execute` on the account itself (`receiver_id == self`).

The Wallet Contract's `rlp_execute` method accepts a base64-encoded RLP Ethereum transaction, verifies the secp256k1 signature against the key whose hash is the account ID, decodes the embedded NEAR actions, and executes them. Actions supported via `rlp_execute`:

- `Transfer`
- `FunctionCall`
- `AddKey` (FunctionCall permission only — no FullAccess)
- `DeleteKey`

Ethereum wallets (MetaMask etc.) interact through a Translator RPC that wraps transactions into `rlp_execute` calls. A relayer's NEAR public key can be added as a FunctionCall key for `rlp_execute` to enable meta-transaction submission on behalf of the user.

### 3.8 Secp256k1 as a Regular Account Access Key

Both `ed25519` and `secp256k1` key types can be registered as `FullAccess` or `FunctionCall` access keys on any named NEAR account. There is no protocol restriction limiting secp256k1 keys to ETH-implicit accounts. A named account such as `alice.near` may hold a mix of ed25519 and secp256k1 keys simultaneously.

**Binary encoding in the trie.** The `PublicKey` is Borsh-serialized as a 1-byte curve discriminant followed by raw key bytes:

| Curve | Discriminant | Payload | Serialized total |
|---|---|---|---|
| `ED25519` | `0x00` | 32 bytes (raw public key) | 33 bytes |
| `SECP256K1` | `0x01` | 64 bytes (uncompressed `x ‖ y`, no `0x04` prefix) | 65 bytes |

**String serialization.** Both types use `<curve>:<base58-encoded-key-bytes>`:
```
ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp
secp256k1:qMoRgcoXai4mBPsdbHi1wfyxF9TdbPCF4qSDQTRP3TfescSRoUdSx6nmeQoN3aiwGzwMyGXAb1gUjBTv5AY8DXj
```
The curve prefix string conveys the type; no type byte is prepended in the string form. Secp256k1 base58 strings are substantially longer due to the 64-byte key size.

**Signature algorithm.** NEAR uses recoverable **ECDSA** over secp256k1 with a 1-byte recovery ID (`v ∈ {0,1}`), identical to the Bitcoin/Ethereum scheme. Within contracts, `env::ecrecover(hash, sig, v, malleability_flag)` exposes this as a host function returning the 64-byte uncompressed public key.

**Gas cost.** Ed25519 signature verification is handled at the protocol layer and is cheap. The `ecrecover` host function costs approximately **93 TGas per call** — roughly one-third of the 300 TGas per-receipt budget — making secp256k1 significantly more expensive inside contract logic.

**Restriction.** The `Stake` action requires a ristretto-compatible ed25519 key; providing a secp256k1 key in `StakeAction.public_key` returns `UnsuitableStakingKey`.

**Hardware wallet note.** The Ledger NEAR app derives ed25519 keys via SLIP-0010 at `m/44'/397'/0'/0'/1'`. No Ledger app currently derives secp256k1 keys for use as NEAR account access keys; secp256k1 NEAR keys require software wallet tooling.

### 3.9 Summary

| Property | FullAccess | FunctionCall |
|---|---|---|
| Action types authorized | All (12 types) | Exactly one `FunctionCall` |
| Token transfer | Yes | No (deposit must be 0) |
| `AddKey` / `DeleteKey` / `Stake` / `DeployContract` | Yes | No |
| Signs `DelegateAction` | Yes, any inner actions | Yes, single `FunctionCall` inner action |
| Allowance checked for `DelegateAction` | N/A | No — relayer pays |
| Protocol-level key expiry | None | None (exhausted allowance freezes but does not delete) |
| Allowance top-up | N/A | No — delete and re-add |
| Method name matching | N/A | Exact string; empty list = any |
| Self-calls (`receiver_id == signer_id`) | Yes | Yes |
| ETH-implicit accounts | Forbidden | Allowed (Wallet Contract only) |

---

## 4. Hierarchical Deterministic Key Derivation

### Protocol Support

NEAR has **no HD key tree at the protocol layer**. Keys are plain raw public keys attached to accounts. HD derivation is entirely a **wallet-layer convention** built on three standards:

| Standard | Role |
|---|---|
| **BIP-39** | Mnemonic phrase → 512-bit seed via PBKDF2-HMAC-SHA512 |
| **SLIP-0010** | HD derivation for non-secp256k1 curves, specifically Ed25519. Required instead of BIP-32 because Ed25519 has a cofactor of 8 and applies bit-clamping, making raw BIP-32 derivation incompatible. SLIP-0010 restricts Ed25519 derivation to **hardened paths only** — unhardened (soft/public) child derivation is not defined. |
| **BIP-44** | Logical path structure: `m / purpose' / coin_type' / account' / change / address_index` |
| **SLIP-0044** | Coin type registry: NEAR = **397** |

### Derivation Paths by Wallet

| Wallet / Tool | Path | Notes |
|---|---|---|
| `near-seed-phrase` (reference lib) | `m/44'/397'/0'` | Default single-account path |
| NEAR Web Wallet + Ledger | `m/44'/397'/0'/0'/1'` | Full 5-level BIP-44, all hardened |
| Keystone hardware wallet | `m/44'/397'/0'` | Matches reference lib |
| NEAR CLI (`near generate-key`) | None (random) | Generates a fresh Ed25519 keypair; no HD derivation |

All path components are hardened (the `'` suffix) because SLIP-0010 mandates it for Ed25519.

### Key Generation Steps (from `near-seed-phrase`)

1. BIP-39: `mnemonic → seed` via PBKDF2-HMAC-SHA512
2. SLIP-0010: `seed → master key`, then apply path `m/44'/397'/0'` using HMAC-SHA512 chain derivation
3. `nacl.sign.keyPair.fromSeed(derivedKey)` → Ed25519 keypair
4. Public key is Base58-encoded and prefixed `ed25519:` for use in NEAR

### Supported Curves

| Curve | Use case |
|---|---|
| **Ed25519** | Default for all NEAR native transactions, validator keys, node keys |
| **Secp256k1** | ETH-implicit accounts and Chain Signatures cross-chain signing |

---

## 5. Implicit Accounts

Implicit accounts allow reserving a NEAR address before any on-chain transaction is needed to claim it.

### Ed25519 Implicit Accounts

1. Generate an Ed25519 keypair locally.
2. The 32-byte raw public key is hex-encoded (lowercase) to produce a 64-character account ID.
3. Example: public key `BGCCDDHfysuuVnaNVtEhhqeT4k9Muyem3Kpgq2U1m9HX` (Base58) → account ID `98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de`
4. The account is latent until someone sends NEAR tokens to it; once funded, the corresponding private key is the sole access key.

### Secp256k1 / ETH-Implicit Accounts

Derived as `'0x' + keccak256(uncompressed_pubkey)[12:32].hex()`, matching Ethereum address derivation exactly. These accounts automatically receive an Ethereum-compatible Wallet Contract and cannot have full-access keys added.

---

## 6. Key Registration: `AddKeyAction` and `DeleteKeyAction`

Key management uses dedicated **action types** in NEAR transactions. A NEAR transaction is a batch of actions; key management is two of those types.

### `AddKeyAction`

```rust
pub struct AddKeyAction {
    pub public_key: PublicKey,
    pub access_key: AccessKey,  // contains nonce + permission
}
```

- Inserts a new `(public_key → AccessKey)` entry in the account's key store.
- The embedded `AccessKey` sets the initial nonce (assigned by the runtime to `block_height × MULTIPLIER`) and the permission (`FullAccess` or `FunctionCall { receiver_id, method_names, allowance }`).
- **Validation errors:** `receiver_id` invalid; method name exceeds 256 bytes; total method name bytes exceed 2,000.
- **Execution errors:** Public key already exists for that account.
- **Authorization:** Only the account itself (via an existing full-access key) can add keys.

### `DeleteKeyAction`

```rust
pub struct DeleteKeyAction {
    pub public_key: PublicKey,
}
```

- Removes the `AccessKey` associated with `public_key`.
- **Execution errors:** Key does not exist.
- An account with all keys deleted can still receive calls if it has deployed contract code.

### Atomic Key Rotation

Rotation batches both `AddKey` (new key) and `DeleteKey` (old key) into a single transaction targeting the account itself. Because `receiver_id == signer_id`, both actions are folded into a single `ActionReceipt` executed on the shard that holds the account. **Receipts are the unit of atomicity in NEAR** — either all actions in a receipt execute or none do. Key rotation is atomic for this reason, not because transactions are atomic in general. A transaction whose actions span multiple shards would produce multiple receipts, and those receipts execute independently and are not atomic with respect to each other.

### Promise-Based Key Management from Contracts

A deployed contract can add or delete keys on its own account by queuing a `Promise`. The Rust SDK methods:

```rust
Promise::new(env::current_account_id())
    .add_full_access_key(public_key: PublicKey) -> Promise

Promise::new(env::current_account_id())
    .add_access_key_allowance(
        public_key: PublicKey,
        allowance: Allowance,        // Allowance::Unlimited or Allowance::Limited(yoctoNEAR)
        receiver_id: AccountId,
        function_names: impl Into<String>,  // comma-separated, e.g. "method_a,method_b"
    ) -> Promise

Promise::new(env::current_account_id())
    .delete_key(public_key: PublicKey) -> Promise
```

**Authorization constraint.** `AddKey` and `DeleteKey` require `predecessor_id == receiver_id`. A contract can only modify keys on its own account (`env::current_account_id()`). Cross-account key modification is rejected by the runtime. The single exception: when `CreateAccount` is the first action in a batch, the creating account may include `AddKey` for the newly created sub-account in the same atomic batch — the basis for account factory contracts.

**Timing.** A promise-based key operation creates an `ActionReceipt` scheduled for a subsequent block. The key change is **not** visible within the same receipt that queued it. Batched actions within a single `Promise` chain (e.g., `.create_account().add_full_access_key()`) execute atomically in one receipt. If a `Promise::then` callback is chained, it runs after the key action receipt completes.

**Failure behaviour.** If `AddKey` targets a public key that already exists, the receipt fails with `AddKeyAlreadyExists`. A chained callback receives the failure status via `promise_result()`. The failed receipt is fully reverted; no partial state change occurs.

**Contracts cannot enumerate keys.** There is no host function equivalent to `view_access_key_list`. A contract that needs to manage keys conditionally must maintain its own key registry in contract storage.

**Common patterns:**

| Pattern | Description |
|---|---|
| Lockup contract | `add_full_access_key` called after all tokens vest and staking is cleared; returns full owner control |
| Multisig contract | `AddKey`/`DeleteKey` dispatched via Promise after m-of-n confirmations |
| Account factory | `create_account().transfer().add_full_access_key()` in one atomic batch for new sub-accounts |
| Social recovery | Guardian contract calls `add_full_access_key(new_key)` on the user's account after threshold of guardian approvals |

---

## 7. Multi-Sig and Key Rotation Patterns

### Native Multi-Key Pattern

Because an account can hold multiple full-access keys, basic m-of-m is achievable without a contract. However, NEAR has no native threshold cryptography at the protocol layer — n-of-m requires a smart contract.

### `near/core-contracts` Multisig Contract

NEAR ships a reference on-chain multisig contract implementing m-of-n threshold logic:

**Confirmation flow:**
1. Any authorized signer calls `add_request_and_confirm(request)` — submits the request and provides the first confirmation.
2. Other signers call `confirm(request_id)` — each adds their public key to a `HashSet<PublicKey>` tracking approvals.
3. When confirmations reach `num_confirmations`, the request executes automatically.

Supported request actions include `AddKey`, `DeleteKey`, `Transfer`, `DeployContract`, `FunctionCall`, `SetNumConfirmations`, and `SetActiveRequestsLimit`.

**Per-key request limiting:** Each key can have at most `active_requests_limit` (default 12) outstanding requests.

### Key Rotation via Multisig

To rotate a compromised key: m signers submit a `DeleteKey(old) + AddKey(new)` request and collect required confirmations. Safer than native rotation because it enforces m-of-n before execution.

### Two-Factor Authentication (2FA)

The NEAR web wallet's 2FA mode deploys a multisig contract to the user's account and replaces the full-access key with a function-call key scoped to the multisig contract. Every high-value action then requires confirmation via a second device (email or TOTP).

---

## 8. Chain Signatures (Cross-Chain Hierarchical Keys)

Launched on mainnet **August 8, 2024**, Chain Signatures is NEAR's cross-chain key management system, extending NEAR's key model to other blockchains via a threshold MPC network.

### Architecture

- **On-chain contract:** `v1.signer` (NEAR mainnet)
- **MPC node network:** 8 independent nodes, secured by NEAR staking and Eigenlayer ETH restakers
- **Key scheme:** Additive Key Derivation for deterministic foreign-chain address generation

### Signing Flow

1. A NEAR account (or smart contract) calls `v1.signer.sign(payload, path, domain_id)`.
2. The MPC nodes each compute a signature share using a jointly-held master key and the derivation parameters.
3. Shares are aggregated — no single node ever holds the full key — to produce a valid signature.
4. The signature is returned on-chain and can be submitted to the target chain.

**Parameters:**

| Parameter | Description |
|---|---|
| `payload` | Transaction hash or raw bytes to sign for the target chain |
| `path` | Arbitrary string (e.g., `"ethereum-1"`, `"bitcoin-main"`) identifying which derived sub-account to use |
| `domain_id` | Integer: `0` = Secp256k1, `1` = Ed25519 |

### Additive Key Derivation

The foreign chain address is derived **deterministically** from:

```
foreign_address = derive(MPC_master_public_key, near_account_id, path)
```

The same `(near_account_id, path)` pair always produces the same foreign address, enabling a single NEAR account to control stable addresses on many chains without exposing a private key.

**Example mappings for `example.near`:**

| Path | Foreign address |
|---|---|
| `"ethereum-1"` | `0x1b48b83a308ea4beb845db088180dc3389f8aa3b` |
| `"ethereum-2"` | `0x99c5d3025dc736541f2d97c3ef3c90de4d221315` |

### Supported Chains and Curves

| Chain Family | Scheme | `domain_id` |
|---|---|---|
| Ethereum, EVM, Bitcoin, Cosmos, DOGE, XRP | Secp256k1 (ECDSA) | 0 |
| Solana, NEAR, Stellar, TON | Ed25519 (EdDSA) | 1 |
| Cardano *(theoretically compatible — uses Ed25519, unverified in practice)* | Ed25519 (EdDSA) | 1 |
| BLS12-381 (planned) | BLS | TBD via `vote_add_domains` |

New signature schemes can be added by MPC node operators via governance vote.

---

## 9. Additional Abstractions

### Meta Transactions (NEP-366)

A user signs a `DelegateAction` off-chain; a **relayer** submits it and pays gas. The user never needs to hold NEAR tokens. The relayer cannot see what the user is doing beyond the fact that a transaction is being submitted.

### FastAuth / Account Recovery

Launched May 2023. Enables account recovery via email using a decentralized network of relayer nodes that manage recovery keys, without any single party holding custody.

### Key Enumeration and Privacy

All access keys for all accounts are stored in the public state trie and are unconditionally readable by anyone with RPC access. There is no mechanism for private or unlisted keys.

**RPC methods.** The `view_access_key` and `view_access_key_list` queries return full key details:

```json
// view_access_key_list response (one entry per key)
{
  "public_key": "ed25519:1TprKa...",
  "access_key": {
    "nonce": 116133598000035,
    "permission": {
      "FunctionCall": {
        "allowance": "250000000000000000000000",
        "receiver_id": "mintspace2.testnet",
        "method_names": []
      }
    }
  }
}
```

**What is revealed.** Every FunctionCall key entry publicly exposes:
- Which dApp the user has authorized (`receiver_id`)
- Which methods are permitted (`method_names`)
- Remaining gas budget (`allowance`)
- Usage count (`nonce` — incremented on every transaction signed with that key)

An observer querying `view_access_key_list` can reconstruct which dApps a user has logged into, the approximate login time (inferred from the block height embedded in the initial nonce), and usage frequency.

**Historical auditability.** `AddKey` and `DeleteKey` actions are recorded as standard transaction actions on the blockchain and indexed by block explorers. A full history of all key additions and deletions for any account is permanently available. There is no expiry or pruning of this record.

**Privacy implication for Midnight.** NEAR's fully public key model is the inverse of Midnight's design philosophy. A "ZK access key" analogue for Midnight (Stakeholder topic, Background 6) would need to ensure that the delegation constraint itself — which contract and method a key is authorized for — is not visible to observers, preserving both the account relationship and the dApp usage pattern as private information. This is achievable via a ZK proof that the key satisfies hidden constraints, with no on-chain `receiver_id` or `method_names` field.

### NEP-413: NEAR Signed Message

**Status: Final** (approved January 2023, version 1.1.0). The standard for off-chain authentication using NEAR account keys — analogous to "Sign In With Ethereum" (EIP-4361) but for NEAR.

**Purpose.** NEP-413 replaces the older pattern of creating a new FunctionCall key on-chain for dApp login (which cost gas, consumed storage, and exposed dApp usage via the public key list). A NEP-413 signature is entirely off-chain: no transaction is sent, no key is added, no gas is spent.

**Message structure (`signMessage` input):**

```typescript
interface SignMessageParams {
    message: string;         // human-readable text shown to user
    recipient: string;       // domain or account ID of the intended recipient
    nonce: Uint8Array;       // exactly 32 random bytes, unique per request
    callbackUrl?: string;    // web wallet redirect target after signing
    state?: string;          // optional CSRF mitigation token
}
```

**What is signed.** The wallet signs `SHA-256(tag ‖ borsh(Payload))` where:
- `tag = (2^31 + 413).to_le_bytes()` = `[0x9D, 0xF3, 0x7F, 0x80]` — a domain separator chosen to be outside the range of any valid Borsh-encoded NEAR transaction, preventing signature reuse as a transaction
- `Payload` = `{ message, nonce: [u8;32], recipient, callback_url }`

**Replay prevention.** The `nonce` (32 bytes, caller-supplied) must be stored and checked server-side. The `recipient` field binds the signature to a specific service — a signature for `myapp.com` cannot be replayed against `otherapp.com`.

**Key type requirement.** Only **FullAccess keys** may sign NEP-413 messages. FunctionCall keys are explicitly prohibited. The rationale: a dApp that holds a FunctionCall key could otherwise silently sign authentication messages on the user's behalf without interaction. Restricting to FullAccess keys ensures the user is the exclusive signer.

**Server-side verification steps:**
1. Reconstruct `SHA-256(tag ‖ borsh(Payload))` from the claimed fields.
2. Verify the ed25519 signature against `publicKey`.
3. Query `view_access_key(accountId, publicKey)` to confirm the key is a registered FullAccess key on the claimed account.
4. Confirm `nonce` has not been used before.
5. Confirm `recipient` matches the expected server domain.

Step 3 is critical — without the on-chain key check, an attacker with an unregistered keypair could forge authentication tokens.

---

## 10. Critical Assessment

The following subsections evaluate each major capability across ten criteria. Additional criteria — **privacy implications**, **ecosystem uniqueness**, and **developer experience** — are included where they add meaningful signal beyond the requested list.

---

### 10.1 Named Account System

Named accounts (`alice.near`, `app.alice.near`) are NEAR's most visible UX innovation. Human-readable identifiers dramatically reduce the cognitive burden of wallet addresses and are a genuine point of product differentiation versus EVM chains, Solana, and Cardano.

**Strengths.** The hierarchy (only `alice.near` can create `sub.alice.near`) is a clean mental model for organizations: a company can manage a namespace under `company.near` without a registrar. The sub-account pattern maps naturally to enterprise structures, DApp deployments, and multi-contract systems. For general users, named accounts make NEAR far more approachable than address-based systems.

**Weaknesses.** The parent/child authority split is a persistent source of confusion: the naming hierarchy implies a governance relationship that does not exist at the protocol level. Users reasonably expect `alice.near` to have some control over `evil.alice.near` but it does not. The short-TLA auction mechanism was designed but never fully operationalized, leaving the high-value name space governed by NEAR Foundation policy rather than a trustless mechanism — a coherence gap. Long names (> 32 chars) are first-come-first-served with no squatting protection.

**Security.** The lowercase ASCII-only character set **fully eliminates cross-script homoglyph attacks**: Cyrillic `а`, Greek `ο`, and other Unicode lookalikes for Latin letters are simply not valid characters in a NEAR account ID. However, within ASCII itself, visually confusable pairs remain — `0` (zero) vs `o` (letter) and `1` (one) vs `l` (lowercase L) are both valid and indistinguishable in many sans-serif fonts. Attacks such as `micros0ft.near` impersonating `microsoft.near` are possible and not addressed at the protocol level. The summary table entry "Homoglyph risk" should be read as referring specifically to these within-ASCII look-alike pairs.

**Implementation.** Pure protocol-layer feature: names are literal UTF-8 bytes in trie keys. Zero contract complexity; zero off-chain complexity beyond UI display. Fundamental enabler — NEAR without named accounts would lose its primary UX advantage.

---

### 10.2 FullAccess Keys

FullAccess keys are a necessary primitive with no meaningful differentiation. Every serious blockchain has an equivalent. Their significance is primarily negative: loss or compromise of a FullAccess key is catastrophic and unrecoverable without application-layer safeguards (multisig, recovery contracts).

**Design note.** NEAR's decision to make key management (AddKey, DeleteKey) an explicit on-chain action rather than a side-effect of contract execution is architecturally clean. It avoids the EVM pattern where account state is modified implicitly through storage writes. This makes key lifecycle auditable and queryable. However, this very auditability means FullAccess key usage patterns are completely public — a privacy cost.

**Ecosystem congruence.** High. FullAccess keys are the foundation everything else builds on. The explicit, enumerable key model is central to NEAR's "account abstraction by default" philosophy.

---

### 10.3 FunctionCall Keys (Session Keys)

This is arguably NEAR's most significant and under-appreciated key management innovation. The ability to register a narrowly scoped signing key for a specific contract and method set — with no ability to transfer funds — enables "login without custody" as a protocol-level feature, not a wallet convention.

**Value to general users.** Very high. A user can log into a game or trading app using a FunctionCall key and never expose their root key. The key can be held in browser storage and used for high-frequency low-value operations. Compromise of the session key cannot drain the wallet.

**Value to corporate/finance users.** High. The `method_names` allowlist maps well to role-based access control: an operator key can call `execute_trade` but not `withdraw_funds`. The `allowance` mechanism provides a spending cap analogous to a corporate card limit.

**Application areas.** dApps (gaming, social, NFT), DeFi (trading bots, automated strategies), corporate treasury management, enterprise smart contract access control.

**Fundamental vs. cosmetic.** Fundamental. Without session keys, every interaction requires the root key — unacceptable for high-frequency applications and severe security degradation for users.

**Ecosystem uniqueness.** Significant differentiator. EVM chains have no native equivalent; ERC-4337 account abstraction approximates it but at much higher complexity and gas cost. Solana has no equivalent. Cardano has no equivalent.

**Weaknesses.** The zero-deposit restriction is a genuine limitation: any contract operation requiring even 1 yoctoNEAR as a security deposit (extremely common in NEAR's NFT and FT standards) cannot be executed by a FunctionCall key. This forces a choice between convenience and functionality. The inability to top up allowance without deleting and re-adding the key creates operational friction for long-running session keys.

**Security.** Well-designed. The scoped blast radius is genuine — a compromised session key cannot escalate to full account control. The public visibility of `receiver_id` and `method_names` leaks which dApps the user is connected to, which is a privacy cost but not a security vulnerability per se.

---

### 10.4 DelegateAction / Meta-Transactions (NEP-366)

Meta-transactions decouple the signer of a transaction from the gas payer. This solves a fundamental onboarding problem: new users cannot pay gas until they hold tokens, but cannot acquire tokens easily without an on-chain account.

**Value to general users.** High for onboarding. A user with a freshly created account (or even an implicit account) can interact with dApps without first acquiring NEAR for gas. Relayers absorb the cost and may recoup it through application-layer fees.

**Value to corporate users.** High. Enterprises deploying consumer-facing products can sponsor all gas costs, creating a Web2-like UX where the product pays infrastructure costs, not users.

**Fundamental vs. cosmetic.** Fundamental for mass adoption. The pattern of "user signs intent, relayer executes" is essential to bringing non-crypto-native users into Web3 applications.

**Security.** The relayer is trusted to submit but not to modify: the `SignedDelegateAction` is signed by the user's key, and the relayer cannot alter the inner actions without invalidating the signature. The `max_block_height` expiry prevents indefinite replay. The allowance bypass for FunctionCall keys (relayer pays, so allowance is not checked) is intentional and well-reasoned but creates a subtle asymmetry that developers must understand.

**Implementation.** Moderate on-chain complexity (new action type, nonce handling, inner action validation). Moderate off-chain complexity (relayer infrastructure required, but `near-relay` reference implementations exist).

**Ecosystem congruence.** High. Fits naturally into NEAR's account-centric, user-experience-first philosophy. Part of the broader "chain abstraction" narrative.

---

### 10.5 Validator and Node Keys

These are pure infrastructure. No user-facing value; no corporate UX differentiation. The significant design merit is the **separation of the validator key from the account key**: a compromised hot validator node cannot drain the staking account.

**Security.** The three-tier key separation (node key, validator key, account key) is sound and follows the principle of least privilege. The inability to change the validator key mid-epoch without risking ejection is an operational constraint that complicates key rotation for validators — a meaningful operational security gap.

**Ecosystem congruence.** High. Clean, principled design consistent with the overall key architecture.

---

### 10.6 ETH-Implicit Accounts and the Wallet Contract

ETH-implicit accounts (`0x...`) are an explicit concession to the Ethereum ecosystem: NEAR wants Ethereum users and their wallets to work without friction. The Wallet Contract deployed automatically on funding turns NEAR into an EVM-wallet-compatible chain for fund custody.

**Value to general users.** Moderate. Users who already have MetaMask and an Ethereum address can receive and send NEAR without generating a new keypair or learning NEAR's account model.

**Value to corporate/finance users.** Moderate. Institutions with existing secp256k1 key infrastructure (custody systems, HSMs configured for Ethereum) can hold NEAR without re-keying.

**Ecosystem coherence.** Low. This is the most obviously ad-hoc addition to NEAR's key system. The hard prohibition on FullAccess keys for ETH-implicit accounts, the automatically deployed Wallet Contract, and the `rlp_execute` interface are a layered workaround rather than a first-class design. The inability to delete an ETH-implicit account is particularly inelegant. The feature solves a real business problem (Ethereum wallet compatibility) but at the cost of a parallel account model that partially contradicts the simplicity of the named account system.

**Security.** The Wallet Contract is additional attack surface. Any bug in `rlp_execute` affects all ETH-implicit accounts that use it. The restriction to FunctionCall-only key additions (no FullAccess) prevents full account control being granted through the Ethereum interface, which is a reasonable safety boundary.

---

### 10.7 Secp256k1 as a Regular Access Key

Permitting secp256k1 keys on named accounts enables interoperability with Ethereum-compatible key material (HSMs, custody systems, hardware wallets using the Ethereum derivation path) without the constraints of ETH-implicit accounts.

**Value.** Niche but real. Primarily useful for institutions with secp256k1-based custody infrastructure who want a named NEAR account rather than a `0x...` address. Also relevant for developers building cross-chain tools who want NEAR accounts controlled by the same key used on Ethereum.

**Usage frequency.** Low in the general ecosystem; potentially higher in institutional or cross-chain developer contexts.

**Gas cost penalty.** The ~93 TGas `ecrecover` cost (one-third of per-receipt budget) makes secp256k1 unsuitable for high-frequency contract interactions. It is feasible for low-frequency account management operations but not for trading or gaming.

**Ecosystem coherence.** Moderate. A reasonable extension of the key model to a second curve, but the high gas penalty creates a two-tier system where secp256k1 keys are second-class citizens for on-chain operations.

---

### 10.8 Hierarchical Deterministic Key Derivation (Wallet Layer)

HD derivation (SLIP-0010 + BIP-44, path `m/44'/397'/0'`) is entirely a wallet convention with no protocol support. NEAR treats keys as opaque public keys; where they came from is irrelevant on-chain.

**Value.** Essential for any serious wallet: seed phrase recovery, multi-account support, hardware wallet integration, and backup/restore all depend on HD derivation. The choice of SLIP-0010 for Ed25519 (rather than attempting to use BIP-32) is technically correct.

**Limitation.** The restriction of all NEAR HD paths to hardened derivation (mandated by SLIP-0010 for Ed25519) means there is no public child key derivation — you cannot derive a child public key from a parent public key without the private key. This limits some advanced wallet patterns (watch-only accounts, key delegation without private key exposure) that are possible with secp256k1 HD keys.

**Ecosystem coherence.** High for what it is: a wallet-layer concern correctly kept out of the protocol. The single standardized path (`m/44'/397'/0'`) avoids the fragmentation seen in some other ecosystems, though the Ledger path differs slightly.

---

### 10.9 Ed25519 Implicit Accounts

Implicit accounts allow receiving funds to an address derived from a public key before any on-chain account creation. This reduces onboarding friction for the initial token receipt.

**Value to general users.** Moderate. A useful primitive for exchanges and faucets that need to send funds to new users before they have accounts. The LinkDrop pattern builds on it. Less useful for users who already have accounts.

**Footgun.** The interaction between implicit accounts and refund receipts is a genuine fund-loss risk that is not obvious to developers. Refund receipts do not trigger implicit account creation, so a send-to-nonexistent-named-account refund routed to a 64-hex address will be burned. The token-loss documentation is not prominently positioned.

**Ecosystem coherence.** Moderate. A pragmatic solution to the bootstrapping problem, but the two activation modes (Transfer for implicit, CreateAccount for named) and the refund receipt exception create edge cases that complicate the mental model.

---

### 10.10 Promise-Based Key Management

Contracts can add and delete keys on their own account via promises, enabling account abstraction patterns at the contract layer.

**Value.** High for developers building complex account management (recovery, DAO governance, lockup, factory contracts). Invisible to end users unless they are the beneficiary of a recovery or unlock flow.

**Limitation.** The restriction to self-account-only key management (a contract cannot add keys to a different account) prevents fully delegated key management. Any cross-account key operation requires the target account to explicitly invoke the operation itself. This is architecturally sound (prevents unauthorized key injection) but forces recovery and delegation patterns to be cooperative rather than unilateral.

**The deferred-receipt timing** creates potential for subtle race conditions in multi-step flows: a key added by a promise is not visible until the next block, meaning a callback cannot assume the key is already present.

**Ecosystem coherence.** High. A natural consequence of NEAR's receipt-based execution model. The constraint (self-only) is consistent with the broader principle that accounts are sovereign.

---

### 10.11 Multi-Sig Contract

NEAR's multisig is entirely a contract-layer feature — there is no native protocol-level threshold signing. This has significant implications.

**Value to corporate/finance users.** High for treasury management, DAO governance, shared custody. The m-of-n model with per-request confirmation is well-suited to institutional workflows.

**Fundamental limitation.** Contract-layer multisig is vulnerable to bugs in the multisig contract itself. A flaw in `near/core-contracts/multisig` affects all accounts using it. Native protocol-level threshold signing (as in Solana's native multisig or future NEAR protocol upgrades) would be more trustworthy. The 15-minute request cooldown is an operational constraint that can impede time-sensitive operations.

**Comparison to Chain Signatures.** Chain Signatures provides MPC-based threshold signing at the infrastructure layer with a much stronger security model. The contract-layer multisig is simpler and cheaper for NEAR-only operations but lacks the adversarial robustness of the MPC network.

**Ecosystem coherence.** Moderate. Functional but not philosophically distinguished — many blockchains have contract-layer multisig. NEAR's multisig does not leverage the unique features of NEAR's key model (e.g., there is no FunctionCall-restricted multisig variant that scopes spending to specific contracts).

---

### 10.12 Chain Signatures / MPC

Chain Signatures is NEAR's most strategically significant key management capability and its strongest claim to ecosystem uniqueness.

**Value to general users.** High. A user controls Bitcoin, Ethereum, Solana, and Cardano addresses from a single NEAR account and seed phrase, without managing per-chain private keys or wallets.

**Value to corporate/finance users.** Very high. A single key management infrastructure (NEAR account + MPC) can custody assets across all major blockchains. This is significant for cross-chain DeFi, cross-chain treasury management, and multi-chain institutional products. The deterministic address derivation (`account + path → address`) means custody addresses are auditable and reproducible.

**Application areas.** Cross-chain DeFi, cross-chain bridges, multi-chain DAO treasuries, cross-chain NFT ownership, chain-abstracted wallet products. Cardano/NEAR interoperability is theoretically feasible (Cardano uses Ed25519, which falls under domain_id=1) but is not demonstrated by any experiment in this repository.

**Fundamental vs. cosmetic.** Fundamental and platform-defining. Chain Signatures is the technical foundation for NEAR's "chain abstraction" product positioning.

**Ecosystem uniqueness.** Very high. No other L1 offers threshold MPC-based cross-chain signing as a production protocol primitive. Polkadot's XCM, Cosmos IBC, and LayerZero all approach cross-chain interoperability through message passing, not shared key control.

**Security.** The 8-node MPC network with NEAR staking + Eigenlayer ETH restaking provides meaningful economic security. However, 8 nodes is a small committee by Byzantine fault tolerance standards (tolerates 2 faults under a 1/3 threshold). Expanding the committee size is the primary security improvement path. The additive key derivation scheme is cryptographically sound but the security of the overall system depends on the DKG protocol, the re-sharing mechanism, and the liveness of the MPC network.

**Curve incompatibility.** For this evaluation: NEAR's MPC uses BN254 (via Sirius) for proof aggregation, while Midnight uses BLS12-381. Any adoption of the Chain Signatures stack for Midnight would need to resolve this.

**Off-chain complexity.** High. Integrating Chain Signatures requires understanding the MPC contract API, the target chain's transaction format and signature scheme, and the relay infrastructure needed to submit the returned signature to the target chain. Mature SDKs (`chain-signatures-js`) reduce but do not eliminate this complexity.

---

### 10.13 Key Enumeration (Public Key Visibility)

The complete, unconditional public visibility of all access keys is a design choice with significant negative consequences that are underweighted in NEAR's documentation.

**Privacy impact.** Every FunctionCall key reveals which dApp the user is connected to, which methods are permitted, and usage frequency. A persistent observer can construct a detailed map of any user's dApp engagement history without any data breach — it is just on-chain state. This is a fundamental privacy deficit compared to chains where contract interactions do not leave a persistent, queryable key registration.

**Value.** The public auditability of keys has some genuine value: it enables transparent account introspection for custody audits, allows wallets to detect unexpected keys added by malicious contracts, and supports off-chain tooling that monitors account state. These are real but secondary benefits.

**Coherence.** Low against the general direction of blockchain privacy (ZK rollups, private state, confidential transactions). NEAR's key model is designed for transparency, which is coherent with its historical positioning as a developer-friendly public blockchain, but sits in tension with any future privacy features.

**No mitigation path.** There are no known NEPs addressing key privacy. The only workaround is application-layer: avoid using FunctionCall keys (losing the session key benefit) or accept the privacy cost.

---

### 10.14 NEP-413 (NEAR Signed Message / Off-Chain Authentication)

NEP-413 is a well-designed, practically important standard that addresses a genuine gap: authenticating users via their NEAR account without the on-chain overhead and privacy cost of creating a FunctionCall access key.

**Value to general users.** High. Sign-in flows become gasless, instantaneous, and leave no on-chain trace. The UX is familiar (approve a message in your wallet) and the security properties are clear.

**Value to corporate users.** Moderate. Useful for Web3 backends that need to authenticate NEAR account holders, but corporate use cases more often involve on-chain authorization than off-chain authentication.

**Security design.** Strong. The domain separator (`2^31 + 413`) prevents signature reuse as a transaction. The `recipient` field prevents cross-site replay. The mandatory FullAccess-key-only restriction closes the FunctionCall key delegation attack. The 32-byte nonce is suitably sized. The required server-side on-chain key verification (step 3) is the critical security control that many implementations may skip — a documentation and tooling gap.

**Limitation.** FullAccess-only requirement creates a subtle UX problem: a user who stores their FullAccess key in cold storage cannot sign NEP-413 messages without bringing the cold key online. A session-key-based authentication standard would be more practical for daily use — but would reintroduce the delegation attack it was designed to prevent.

**Ecosystem coherence.** High. Fills a natural gap in the authentication stack and replaces a prior approach (on-chain login key creation) that was wasteful and privacy-invasive.

---

### 10.15 FastAuth / Email Recovery

FastAuth provides email-based account recovery using a decentralized relay network, reducing the barrier to entry for users unfamiliar with seed phrase management.

**Value to general users.** High for onboarding. Email recovery is a familiar pattern that makes NEAR accounts accessible to users who would not manage a seed phrase.

**Centralization risk.** The relay network introduces a set of trusted parties. While no single party holds full custody, the system depends on the network's liveness and honesty. This is a meaningful trade-off between UX accessibility and trustlessness. It is philosophically at odds with the self-sovereign key management principle, though pragmatically essential for mass adoption.

**Corporate value.** Low to moderate. Corporate users typically prefer hardware-based custody over email-based recovery.

---

### 10.16 Summary Assessment Table

| Capability | User Value | Corp / Finance Value | App Areas | Implementation Locus | Usage Frequency | Fundamental vs. Cosmetic | NEAR Philosophy Fit | Security Posture | On-Chain Complexity | Off-Chain Complexity |
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

**Overall pattern.** NEAR's key system is genuinely distinguished at two levels: the **FunctionCall key** as a protocol-native session key, and **Chain Signatures** as a cross-chain MPC primitive. These two features, together, represent capabilities that no other major L1 provides natively. The remainder of the system — named accounts, FullAccess keys, HD derivation — is solid and well-designed but not uniquely differentiating. The significant weaknesses are the **complete absence of key privacy** (all keys and usage are public), the **ad-hoc ETH-implicit account model** (coherence cost), and the **contract-layer-only multisig** (security limitation for high-value custody). The overall philosophy — explicit, auditable, user-sovereign key management at the protocol layer — is internally consistent and well-executed, with the privacy gap being the most significant unresolved tension.

---

## 11. Midnight Applicability Analysis

This section evaluates eight NEAR key management capabilities against six criteria relevant to the NEARFall feasibility study. For each capability the analysis addresses: **(1)** whether Midnight already has an equivalent, **(2)** the complexity of adding the capability at three integration levels, **(3)** alignment with Midnight's philosophy and architecture, **(4)** privacy implications, **(5)** security implications, and **(6)** actionable observations for decision-making.

**Integration levels used in criterion 2:**
- **(a) Off-chain** — wallet SDK, relayer, or tooling layer; no protocol change required
- **(b) Via smart contract** — Compact language contract; no ledger rule change
- **(c) As a ledger change** — new FRAME pallet, runtime primitive, or consensus rule

---

### 11.1 Named Accounts

**Criterion 1 — Midnight support.** No equivalent. Midnight uses Bech32m addresses (application-facing) and SS58 addresses (Substrate-facing) — both are opaque cryptographic encodings of public keys with no human-readable name registry at the protocol layer.

**Criterion 2 — Complexity to add.**
- **(a) Off-chain:** Low. An ENS-style resolver service — a lookup from human-readable labels to Midnight addresses — requires only a web service and a Compact contract storing the registry. Resolution happens client-side; the protocol is unaware of names.
- **(b) Via smart contract:** Moderate. A Compact contract can maintain a canonical name-to-address map, enforce uniqueness, and charge registration fees. Sub-account hierarchies (e.g., `app.alice.midnight`) can be implemented as separate registry entries. The contract does not control address creation, only provides lookup authority.
- **(c) As a ledger change:** High. Native named accounts require a new address type, name-validation logic at the runtime level, and consensus-layer registration mechanics — a significant protocol extension with unclear value given the off-chain alternative.

**Criterion 3 — Philosophy alignment.** Poor fit. Named accounts create a permanent, publicly visible binding between a memorable identity and a cryptographic address. This directly contradicts Midnight's selective disclosure model: once `alice.midnight` is registered, every transaction involving that address is permanently attributable to the name "alice." NEAR's hierarchical sub-account model compounds the problem: organizational structures (`treasury.company.midnight`, `payroll.company.midnight`) would be publicly readable on-chain, revealing internal structure without any disclosure decision by the account holder.

**Criterion 4 — Privacy impact.** High degradation. The entire value of Midnight's ZK architecture rests on unlinking activity from identity. A named account system re-introduces persistent identity linkage at the address level, undermining zero-knowledge transaction privacy before a single proof is constructed.

**Criterion 5 — Security impact.** Neutral to marginally positive. Named accounts reduce the risk of funds sent to a mistyped address. The ASCII-only homoglyph protection from NEAR's design is a useful precedent if any naming scheme is adopted.

**Criterion 6 — Actionable.** Midnight should not adopt protocol-level named accounts. The privacy cost is prohibitive. If human-readable addressing is required for UX, an off-chain resolver (analogous to ENS or Cardano's ADA Handle) is the appropriate integration point — users can opt into name registration without exposing pseudonymous users. Any such resolver should be designed so that an on-chain address cannot be easily reverse-resolved by an adversary monitoring chain traffic.

---

### 11.2 FullAccess Keys

**Criterion 1 — Midnight support.** Yes, effectively. Every Midnight account has an account signing key (sr25519, ed25519, or ecdsa via Substrate) that authorizes all operations on that account — the conceptual equivalent of a NEAR FullAccess key.

**Criterion 2 — Complexity to add.** Not applicable — the capability is already present.

**Criterion 3 — Philosophy alignment.** High. Root signing authority is a universal requirement. Midnight's account key model is a clean, standard Substrate primitive.

**Criterion 4 — Privacy impact.** Neutral from the key concept itself. However, one NEAR-specific design choice — making key management (AddKey, DeleteKey) an **enumerable, permanently auditable on-chain action** — would be privacy-degrading if adopted verbatim for Midnight. In NEAR, the full list of keys and their history is unconditionally public. In Midnight, this would reveal account control patterns, custody arrangements, and key rotation timing.

**Criterion 5 — Security impact.** Neutral.

**Criterion 6 — Actionable.** No adoption work is needed for the base concept. What Midnight should *not* borrow is NEAR's pattern of exposing all key management operations as public, enumerable on-chain events. If Midnight adds explicit key management actions to the ledger, those events should be shielded or at minimum not publish the full key and permission details.

---

### 11.3 FunctionCall Keys (Session Keys)

**Criterion 1 — Midnight support.** No direct equivalent. Midnight has viewing keys (granting read-only access to private state for indexing purposes) but no protocol-native scoped signing key that authorizes only specific contract calls and enforces a spending cap.

**Criterion 2 — Complexity to add.**
- **(a) Off-chain:** Moderate. A wallet convention could create a "session keypair" stored in browser memory that signs message payloads intended for a specific contract, validated in the private transcript. No protocol changes are required, but scope restriction is a contract-enforced convention rather than a runtime invariant.
- **(b) Via smart contract:** Moderate-high. A Compact contract can maintain a private-state authorization map: `Map<SessionPublicKey, PermissionRecord>`. Transition functions verify that incoming calls are co-signed by an authorized session key. Critical limitation: Midnight transactions are signed at the account level (Substrate), not at the contract level. Session key authorization would be contract-internal, meaning the account's root key still signs the outer transaction — eliminating the primary security benefit (root key isolation from the application layer) unless wallets enforce the separation by convention.
- **(c) As a ledger change:** Very high. Protocol-native scoped signing keys require new transaction types, new runtime validation logic, and new Compact language primitives — a substantial consensus change.

**Criterion 3 — Philosophy alignment.** High conceptually. Limiting key blast radius and enabling "login without custody" are strongly aligned with Midnight's security goals. However, NEAR's implementation is anti-aligned with Midnight's privacy model: NEAR's FunctionCall keys are public on-chain, permanently revealing `receiver_id`, permitted `method_names`, and `allowance` to any observer. This transparency is exactly what Midnight's ZK architecture is designed to prevent.

**Criterion 4 — Privacy impact.** With NEAR's design: high degradation — public session key registration reveals every dApp a user is connected to. With a Midnight-native ZK redesign: no degradation, potentially enhancement — session key authorization can live entirely in private contract state, invisible to chain observers.

**Criterion 5 — Security impact.** High improvement potential. Session keys are the single most impactful key management feature for reducing operational security risk. A compromised session key cannot drain the root account. This benefit applies equally to Midnight.

**Criterion 6 — Actionable.** Session keys are the strongest candidate for **Option 3 (Take Ideas)**. The pattern should be redesigned for Midnight: session key registration in private contract state, ZK proof of session key validity inside the Kachina transition function, no on-chain revelation of permitted receiver or methods. This would produce a capability stronger than NEAR's in privacy terms while preserving the security benefit. The key open question is whether Compact's current witness and private-state primitives are expressive enough to validate session key signatures inside a circuit — this is a well-scoped experiment.

---

### 11.4 DelegateAction / Meta-Transactions

**Criterion 1 — Midnight support.** No. Midnight has no protocol-native meta-transaction mechanism where a user signs an intent and a relayer pays DUST gas on their behalf.

**Criterion 2 — Complexity to add.**
- **(a) Off-chain:** Moderate. A relayer service can accept user-signed intent payloads outside the Midnight transaction format, wrap them into valid Midnight transactions, pay the DUST fee, and submit. The user's signature proves authorization; the relayer provides only fee payment. A relay protocol needs replay-prevention (nonces) and expiry, analogous to NEAR's `max_block_height` field.
- **(b) Via smart contract:** Moderate. A Compact "relayer contract" can hold authorized intent payloads in its state and execute them when a relayer triggers the operation, with application-layer accounting. More limited than a protocol-level DelegateAction but achievable without ledger changes.
- **(c) As a ledger change:** High. A native delegate-action-equivalent requires a new FRAME pallet with inner-action validation, nonce management per delegation, and fee abstraction logic. Significant but tractable.

**Criterion 3 — Philosophy alignment.** High for the UX goal. Midnight's DUST fee model creates an onboarding barrier identical to NEAR's gas barrier: new users cannot pay DUST until they hold DUST, but cannot easily acquire DUST without an active account. Meta-transactions are required infrastructure for consumer-facing Midnight DApps.

**Criterion 4 — Privacy impact.** Moderate risk. A relayer must receive a sufficiently structured payload to construct a valid transaction, which may reveal the contract target, call arguments, or token amounts. A ZK-augmented meta-transaction — the user provides a ZK proof of a valid transition and the relayer submits it without seeing the proof inputs — could preserve privacy but adds complexity. For the public-layer case, relaying leaks no more than a self-submitted transaction would.

**Criterion 5 — Security impact.** Low risk if designed correctly. The user's signature still authorizes the action; the relayer cannot forge or modify it. NEAR's `max_block_height` expiry preventing indefinite replay is a useful pattern to carry forward.

**Criterion 6 — Actionable.** An off-chain relayer network for Midnight should be treated as a **required infrastructure component** for any consumer DApp deployment, regardless of the NEARFall architectural path chosen. The NEAR DelegateAction spec and `near-relay` implementation are useful prior art but must be adapted to Midnight's UTXO/intent model and DUST fee structure. The privacy implications of relay payload visibility are worth a dedicated design review before committing to a standard.

---

### 11.5 HD Key Derivation

**Criterion 1 — Midnight support.** Unspecified at the protocol layer. The architecture document describes sr25519, ed25519, and ecdsa key schemes but does not prescribe derivation paths. Substrate's sr25519 implementation (via Schnorrkel) supports its own hierarchical derivation as a wallet convention. Whether Midnight wallets implement BIP-44 / SLIP-0010 derivation paths is a wallet implementation question, not a protocol question.

**Criterion 2 — Complexity to add.**
- **(a) Off-chain:** Very low. HD derivation is entirely a wallet-layer concern. The protocol sees only public keys; derivation path and seed management are local to the wallet. No protocol changes required.
- **(b) Via smart contract:** Not applicable — key derivation has no on-chain component.
- **(c) As a ledger change:** Not applicable.

**Criterion 3 — Philosophy alignment.** High. HD derivation is a security and usability primitive that every serious wallet requires. Cardano's BIP32-Ed25519 (analyzed in Appendix A) is the natural reference for Midnight given the shared heritage — it enables unhardened child key derivation with the `8·zL` trick that preserves Ed25519's clamping invariant, and its CIP-1852 path structure is directly applicable.

**Criterion 4 — Privacy impact.** Opportunity. Privacy-aware HD derivation is a strong enhancement specific to Midnight's threat model: deriving a fresh address per contract interaction (analogous to Zcash's diversified addresses) prevents address correlation across DApp interactions. Deriving independent viewing keys per context limits the exposure of any single disclosed key. The BIP32-Ed25519 approach's support for unhardened public-key derivation enables watch-only account management without exposing the root private key.

**Criterion 5 — Security impact.** Significant improvement. Seed phrase recovery, hardware wallet support, multi-account management, and backup/restore all depend on standardized HD derivation. Without it, private key management for Midnight is error-prone and tool-fragmented.

**Criterion 6 — Actionable.** Midnight should standardize wallet HD derivation paths as a wallet-layer specification, independent of the NEARFall architectural decision. The Cardano BIP32-Ed25519 approach is technically superior to SLIP-0010 for Ed25519 because it supports unhardened derivation (see Appendix A), enabling more flexible wallet architectures. A CIP-style specification for Midnight HD paths — coin type, role/index structure, viewing-key derivation — should be produced as an early deliverable. Privacy-first diversified addresses should be a first-class wallet pattern.

---

### 11.6 Implicit Accounts

**Criterion 1 — Midnight support.** No. Midnight accounts are created explicitly via Substrate account creation. There is no mechanism for funds sent to a key-derived address to automatically activate an account.

**Criterion 2 — Complexity to add.**
- **(a) Off-chain:** Low as a workaround. A voucher/holding contract pattern (analogous to NEAR's LinkDrop) can stage funds for a recipient who has not yet created an account. No implicit account creation required.
- **(b) Via smart contract:** Moderate. A Compact holding contract can act as a staging area for funds destined for an as-yet-unregistered account, releasing them when the recipient presents proof of key ownership.
- **(c) As a ledger change:** High. Protocol-native implicit accounts require detecting funded-but-unregistered addresses and creating account records on first receipt — complex consensus logic with known edge-case risks (the NEAR refund-receipt fund-loss footgun, §5).

**Criterion 3 — Philosophy alignment.** Poor fit. NEAR's implicit account model encodes the public key directly into the account ID (`hex(public_key) = account_id`), permanently and unconditionally linking key and on-chain identity. For Midnight, where address-key unlinkability is a core architectural goal, this is structurally inappropriate.

**Criterion 4 — Privacy impact.** High degradation in the NEAR design. The explicit address-from-public-key derivation removes any unlinkability between key material and on-chain activity — exactly the property Midnight's ZK architecture is designed to provide.

**Criterion 5 — Security impact.** Introduces the refund-receipt race condition risk (§5) with no mitigating benefit for Midnight's use case.

**Criterion 6 — Actionable.** Do not adopt implicit accounts. The onboarding problem (new users receive funds before having a registered account) is better solved via a privacy-preserving voucher contract — a one-time code redeemable for an initial DUST allocation — which does not require revealing the recipient's public key at funding time and is fully compatible with Midnight's privacy model.

---

### 11.7 Promise-Based Key Management

**Criterion 1 — Midnight support.** No. Midnight's Compact contracts modify contract state (public and private) but cannot issue key management operations on account keys. Account-level key changes are Substrate runtime operations, outside the contract execution environment.

**Criterion 2 — Complexity to add.**
- **(a) Off-chain:** Not applicable for on-chain enforcement. Off-chain social recovery via multisig wallets (guardians co-sign a new key registration transaction out-of-band) is possible but provides no smart-contract enforcement of thresholds or timelocks.
- **(b) Via smart contract:** High. Supporting this requires: a new runtime call that a contract can invoke to modify account key state, authorization logic proving the contract has permission to do so for the target account, and Compact language extensions exposing the call. The NEAR model's "self-only" constraint (a contract can only manage keys on its own account) is the minimal safe design boundary to carry forward.
- **(c) As a ledger change:** Very high. This requires a new FRAME pallet for contract-authorized key management, new runtime authorization logic, and new Compact/Kachina primitives. A "key management pallet" with a well-defined contract invocation interface is the architectural pattern.

**Criterion 3 — Philosophy alignment.** High for the goal, poor for the naive implementation. Social recovery and key rotation via contract-enforced policies are strongly aligned with Midnight's security goals. However, NEAR's implementation makes all key management operations and their triggering conditions publicly visible on-chain: guardian relationships, recovery thresholds, and rotation timing are all transparent. In Midnight, these are precisely the sensitive relationships that should be in private state.

**Criterion 4 — Privacy impact.** With NEAR's design: high degradation — guardian identities, approval thresholds, and key rotation events are all permanently public. With a Midnight-native ZK redesign: minimal degradation or enhancement — guardian relationships and recovery conditions held in private Compact contract state, with ZK proofs of threshold satisfaction submitted without revealing the guardians' identities or the specific approval path.

**Criterion 5 — Security impact.** High positive potential. Contract-enforced key recovery with timelocks (see Appendix B) is a significant security improvement for users facing lost or compromised accounts. The self-only constraint (a contract cannot inject keys into a different account without that account's cooperation) is a crucial safety boundary that Midnight must preserve in any implementation.

**Criterion 6 — Actionable.** Strong **Option 3 (Take Ideas)** candidate. The social recovery pattern from Appendix B should be redesigned for Midnight using Compact's private state to hide guardian identities and relationships. Two technical gates for a proof-of-concept: (1) Can a Compact contract produce a ZK proof that a threshold of anonymous guardian signatures is satisfied, without revealing which guardians approved? (2) Can a contract-triggered ledger call change the account key atomically? These questions are well-scoped for an experiment.

---

### 11.8 Chain Signatures / MPC

**Criterion 1 — Midnight support.** No general-purpose MPC chain signatures. Midnight has a protocol-level Cardano partnership (committee bridge, cNIGHT ↔ mNIGHT token bridge, Cardano reward-address mappings) but this is a dedicated bilateral integration, not a general threshold-signing service for arbitrary foreign chains.

**Criterion 2 — Complexity to add.**
- **(a) Off-chain:** High. An MPC network comparable to NEAR's `v1.signer` — with distributed key generation, threshold signing, re-sharing, and economic security via staking — is a multi-year infrastructure project to build from scratch. However, an existing MPC network (NEAR's own, or a third-party provider) could in principle be adapted to accept signing requests initiated from Midnight contracts. The off-chain integration surface is: Midnight emits a signing request event → oracle/relayer forwards it to the MPC network → returned signature is posted back to Midnight. This is architecturally tractable without building an MPC network from scratch.
- **(b) Via smart contract:** Moderate for the request/response interface. A Compact contract acts as the user-facing layer: it accepts a signing request (target chain, message, derivation path) in its public state, and a trusted oracle delivers the completed signature. The hard work is the oracle bridge and the MPC network, not the contract itself.
- **(c) As a ledger change:** Very high. Making the MPC network a first-class protocol participant — with staking, slashing, liveness obligations, and direct ledger integration — is equivalent in scope to what NEAR built for Chain Signatures, requiring years of protocol development.

**Criterion 3 — Philosophy alignment.** Very high. Chain abstraction is explicitly on Midnight's roadmap (Background 6). The ability to control Bitcoin, Ethereum, Solana, and Cardano addresses from a single Midnight account using a single root key directly addresses the stakeholder-requested "hierarchical key derivation for multi-chain addresses." Midnight's privacy model actually enhances the Chain Signatures concept: signing requests and target-chain transaction details can live in private contract state, known to the MPC network off-chain but never recorded on-chain — a stronger privacy guarantee than NEAR's fully-public signing requests.

**Criterion 4 — Privacy impact.** Net improvement opportunity over NEAR. In NEAR, every chain signature request (including derivation `path` and the message being signed) is a public on-chain event. In Midnight, the signing request can be a private-state input to a Compact contract: on-chain observers never see it. This privacy enhancement is uniquely possible because of Midnight's ZK architecture.

**Criterion 5 — Security impact.** The dominant concern is the **BN254 / BLS12-381 curve incompatibility**. NEAR's MPC stack uses BN254 for its internal proof aggregation layer (via Sirius). Midnight uses BLS12-381 with KZG commitments. These curve ecosystems are not directly composable at the proof level. However, the MPC network's *signing operations* — secp256k1 for Bitcoin/Ethereum, ed25519 for Cardano/Solana — are independent of the internal aggregation curve. This may be the key insight enabling a decoupled integration: the signing service can be used by Midnight without resolving the proof-layer curve conflict, provided the MPC network's internal proofs do not need to be verified on Midnight's chain.

**Criterion 6 — Actionable.** Chain Signatures is the highest-value capability in this analysis for Midnight's strategic roadmap. Priority actions:
1. **Clarify whether the BN254/BLS12-381 incompatibility blocks the signing path or only the proof-aggregation path.** If only the aggregation proofs are affected, the MPC signing service is usable by Midnight without resolving curve incompatibility at the proof level.
2. **Prototype an oracle bridge** that relays Midnight contract signing requests to NEAR's `v1.signer`. This tests the off-chain integration path without requiring protocol changes on either chain.
3. **Design private signing requests** as a Compact contract pattern — demonstrating Midnight's privacy enhancement over NEAR's public chain signatures model and validating the architecture for the broader chain abstraction vision.

---

### 11.9 Summary Table

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

**Strategic read-out.** Three capabilities should be deprioritized or actively avoided: **named accounts** (structurally anti-privacy), **implicit accounts** (key-address linkage violates Midnight's model), and verbatim adoption of **NEAR's public key enumeration** model. Four capabilities are strong **Option 3 (Take Ideas)** candidates requiring redesign for Midnight's ZK architecture: **session keys**, **HD key derivation** (BIP32-Ed25519 with diversified addresses), **promise-based key management** (with private guardian state), and **chain signatures** (with private signing requests). **Meta-transactions / DelegateAction** is a near-term **off-chain priority** — required infrastructure for any consumer DApp deployment regardless of the NEARFall path chosen. **Chain Signatures** is the highest-value long-term capability; clarifying whether the BN254/BLS12-381 incompatibility affects the signing path or only the proof-aggregation path is the single most important near-term technical question to resolve.

---

## Sources

### General Sources

- [SLIP-0010: Universal private key derivation from master private key](https://github.com/satoshilabs/slips/blob/master/slip-0010.md)
- [SLIP-0044: Registered coin types for BIP-0044](https://github.com/satoshilabs/slips/blob/master/slip-0044.md)

### NEAR Sources

- [Access Keys — NEAR Documentation](https://docs.near.org/protocol/access-keys)
- [Account Model — NEAR Documentation](https://docs.near.org/concepts/protocol/account-model)
- [Address (Account ID) — NEAR Documentation](https://docs.near.org/protocol/account-id)
- [Access Keys — Nomicon Spec](https://nomicon.io/DataStructures/AccessKey)
- [Actions — Nomicon Spec](https://nomicon.io/RuntimeSpec/Actions)
- [Accounts — Nomicon Spec](https://nomicon.io/DataStructures/Account)
- [Nomicon: Transactions](https://nomicon.io/RuntimeSpec/Transactions)
- [Nomicon: FunctionCall](https://nomicon.io/RuntimeSpec/FunctionCall)
- [Nomicon: Cross-Contract Call](https://nomicon.io/RuntimeSpec/Scenarios/CrossContractCall)
- [Nomicon: Refunds](https://nomicon.io/RuntimeSpec/Refunds)
- [Receipts — Nomicon Spec](https://nomicon.io/RuntimeSpec/Receipts)
- [Implicit Accounts — NEAR Documentation](https://docs.near.org/integrations/implicit-accounts)
- [Chain Signatures — NEAR Documentation](https://docs.near.org/chain-abstraction/chain-signatures)
- [Chain Signatures launch announcement — NEAR](https://pages.near.org/blog/chain-signatures-launch-to-enable-transactions-on-any-blockchain-from-a-near-account/)
- [Meta Transactions — NEAR Documentation](https://docs.near.org/chain-abstraction/meta-transactions)
- [NEP-0366: Meta-Transactions](https://github.com/near/NEPs/blob/master/neps/nep-0366.md)
- [Meta-Transactions Architecture — nearcore](https://near.github.io/nearcore/architecture/how/meta-tx.html)
- [Benefits of Function-Call Keys — NEAR Blog](https://docs.near.org/blog/benefits-of-multiple-keys)
- [Storage Staking — NEAR Documentation](https://docs.near.org/protocol/storage/storage-staking)
- [Create a NEAR Account — NEAR Documentation](https://docs.near.org/tutorials/protocol/create-account)
- [Using Linkdrops — NEAR Documentation](https://docs.near.org/primitives/linkdrop)
- [Global Contracts — NEAR Documentation](https://docs.near.org/smart-contracts/global-contracts)
- [Front Running — NEAR Documentation](https://docs.near.org/smart-contracts/security/frontrunning)
- [Avoiding Token Loss — NEAR Documentation](https://docs.near.org/protocol/network/token-loss)
- [EVM Wallets on NEAR — NEAR Documentation](https://docs.near.org/web3-apps/concepts/eth-wallets-on-near)
- [Validator Staking — NEAR Documentation](https://docs.near.org/protocol/network/staking)
- [NEAR Data Flow — NEAR Documentation](https://docs.near.org/concepts/data-flow/near-data-flow)
- [Access Keys RPC — NEAR Documentation](https://docs.near.org/api/rpc/access-keys)
- [Authenticate NEAR Users — NEAR Documentation](https://docs.near.org/web3-apps/backend)
- [Wallet Login — NEAR Documentation](https://docs.near.org/web3-apps/tutorials/wallet-login)
- [NEP-448: Zero-Balance Accounts](https://github.com/near/NEPs/blob/master/neps/nep-0448.md)
- [NEP-491: Non-Refundable Storage Staking](https://github.com/near/NEPs/blob/master/neps/nep-0491.md)
- [NEP-518: Account Abstraction Proposal](https://github.com/near/NEPs/issues/518)
- [NEP-71: Implicit Account Creation](https://github.com/near/NEPs/pull/71)
- [NEP-413: NEAR Signed Message](https://github.com/near/NEPs/blob/master/neps/nep-0413.md)
- [Zero Balance Account Discussion — NEPs #402](https://github.com/near/NEPs/discussions/402)
- [near/mpc — GitHub](https://github.com/near/mpc)
- [near/core-contracts — GitHub](https://github.com/near/core-contracts)
- [near/near-seed-phrase — GitHub](https://github.com/near/near-seed-phrase)
- [near-linkdrop — GitHub](https://github.com/near/near-linkdrop)
- [Lockup Contract README — GitHub](https://github.com/near/core-contracts/blob/master/lockup/README.md)
- [TLA Registrar — core-contracts issue #25](https://github.com/near/core-contracts/issues/25)
- [nearcore views.rs — GitHub](https://github.com/near/nearcore/blob/324b42e70166bb17fcf2435c2d75365c1f12ac24/core/primitives/src/views.rs)
- [nearcore verifier.rs — GitHub](https://github.com/near/nearcore/blob/4510472d69c059644bb2d2579837c6bd6d94f190/runtime/runtime/src/verifier.rs)
- [nearcore signature.rs — GitHub](https://github.com/near/nearcore/blob/master/core/crypto/src/signature.rs)
- [GC Architecture — nearcore](https://github.com/near/nearcore/blob/master/docs/architecture/how/gc.md)
- [Serialization — Nearcore Architecture Guide](https://near.github.io/nearcore/architecture/how/serialization.html)
- [ecrecover gas cost — nearcore issue #4548](https://github.com/near/nearcore/issues/4548)
- [Secp256k1 staking key discussion — nearcore #3807](https://github.com/near/nearcore/discussions/3807)
- [Zero allowance foot-gun — near-sdk-rs #871](https://github.com/near/near-sdk-rs/issues/871)
- [Promise — near-sdk-rs docs](https://docs.rs/near-sdk/latest/near_sdk/struct.Promise.html)
- [near-sdk-rs promise.rs — GitHub](https://github.com/near/near-sdk-rs/blob/master/near-sdk/src/promise.rs)
- [Key Management — NEAR Nodes](https://near-nodes.io/intro/keys)
- [LedgerHQ/app-near — GitHub](https://github.com/LedgerHQ/app-near)
- [near-sign-verify — npm](https://www.npmjs.com/package/near-sign-verify)
- [NearBlocks Explorer](https://nearblocks.io/)
- [Everything You Should Know About Accounts on NEAR — DEV Community](https://dev.to/denbite/everything-you-should-know-about-accounts-on-near-5gb7)
- [Refunds — Nomicon Spec](https://nomicon.io/RuntimeSpec/Refunds)

### Midnight Sources

- Midnight Architecture Summary — internal repository document (`background/midnight-architecture.md`); primary source for §11 Midnight architecture claims
- NearFall Technical Specification v4.2 — internal repository document (`background/NearFall_Technical_Specification_v4_2.pdf`); primary source for integration-level complexity and curve incompatibility assessment
- Midnight Litepaper — internal repository copy (`background/Midnight litepaper.pdf`); also publicly available from midnight.network
- Midnight Tokenomics and Incentives Whitepaper — internal repository copy (`background/Midnight-Tokenomics-And-Incentives-Whitepaper.pdf`)
- [Halo 2 — zcash](https://zcash.github.io/halo2/) — PLONK-based ZK proof system underlying Midnight's proof stack
- [Substrate / FRAME — Parity Technologies](https://docs.substrate.io/) — modular blockchain framework on which Midnight is built; source for runtime account model and pallet architecture
- Kachina — Foundations of Private Smart Contracts (Zetzsche, Groth, Kiayias, Preneel; IEEE S&P 2021) — theoretical basis for Midnight's public/private transcript execution model
- NEAR MPC Chain Signatures System Summary — internal repository document (`background/mpc-chain-signatures-summary.md`); primary source for MPC architecture, signature providers (ECDSA, EdDSA, CKD), supported curves, and domain_id scheme

---

## Appendix A: Ed25519 HD Derivation — NEAR vs Cardano

### A.1 Why NEAR Requires All-Hardened Paths

NEAR uses SLIP-0010 for HD key derivation, which mandates that **all path components be hardened** when the underlying curve is Ed25519. The reason lies in the mathematical structure of Ed25519 private keys.

In BIP-32 with secp256k1, unhardened child key derivation works by adding a tweak to the parent scalar:

```
child_private_key = parent_private_key + IL   (mod curve order)
child_public_key  = parent_public_key  + IL × G
```

Because secp256k1 has a prime-order group (cofactor = 1) and scalar multiplication is linear, the child public key can be computed from the parent public key alone — without the private key. This is what enables extended public keys (xpub) and watch-only wallets.

Ed25519 private keys are not raw scalars. The signing scalar is derived by hashing and **clamping** a 32-byte seed:

```
(scalar ‖ nonce_material) = SHA-512(seed)
scalar = clamp(scalar)
    -- low 3 bits of byte 0 cleared  (forces divisibility by 8)
    -- bit 7 of byte 31 cleared      (keeps scalar < 2²⁵⁵)
    -- bit 6 of byte 31 set          (ensures 2²⁵⁴ ≤ scalar)
```

The clamping is mandatory. Curve25519 (the underlying curve) has cofactor 8 — there are 8 points that reduce to the same prime-order subgroup element. Clearing the low three bits forces the scalar to be divisible by 8, ensuring the key lies cleanly in the prime-order subgroup and neutralising small-subgroup attacks.

If unhardened derivation were attempted — `child_scalar = parent_scalar + tweak` — the result would generally violate the clamping invariant: bit 254 may be wrong and the low bits may be non-zero. The child scalar would not be a valid Ed25519 private key. The invariant could be restored by clamping the result, but then `clamp(a + b) ≠ clamp(a) + b` in general, destroying the linear relationship `child_public_key = parent_public_key + tweak × G` that makes unhardened derivation useful. The mechanism collapses entirely.

SLIP-0010 avoids this by using only hardened derivation for Ed25519:

```
I = HMAC-SHA512(Key=parent_chain_code, Data=0x00 ‖ parent_private_key ‖ index)
child_seed = IL      -- treated as a fresh 32-byte seed, not added to anything
child_scalar = clamp(SHA-512(child_seed)[:32])
```

The child key is a completely fresh seed derived from the parent **private** key. No scalar addition occurs; clamping is applied from scratch; linearity is never needed. The cost is absolute: child keys and child public keys cannot be derived without the private key. Extended public keys (xpub) do not exist for NEAR. Every new address requires the seed or private key to be present.

### A.2 How Cardano Solves the Problem: BIP32-Ed25519

Cardano uses a custom scheme — **BIP32-Ed25519** (specified by Khovratovich and Law, deployed as CIP-1852) — that enables unhardened derivation for Ed25519 without violating the clamping invariant.

**Extended private keys.** Rather than representing a private key as a 32-byte seed, BIP32-Ed25519 keeps the full 64-byte output of the initial hash as the extended private key `(kL ‖ kR)`:

```
(kL ‖ kR) = modified_SHA-512(seed)     -- 64 bytes total
kL = clamp(kL)                          -- same invariants as standard Ed25519
```

`kL` is the signing scalar (clamped, identical invariants to standard Ed25519). `kR` is auxiliary material used in nonce generation. The 64-byte extended key is the unit of derivation.

**Unhardened child key derivation.** For soft (unhardened) derivation:

```
Z = HMAC-SHA512(Key=chain_code, Data=0x02 ‖ parent_public_key ‖ index)
I = HMAC-SHA512(Key=chain_code, Data=0x03 ‖ parent_public_key ‖ index)

zL = Z[:28]                             -- left 28 bytes of Z
child_kL = 8·zL + parent_kL
child_kR = (Z[32:] + parent_kR) mod 2²⁵⁶
child_chain_code = I[32:]
child_public_key = parent_public_key + 8·zL × B
```

The child public key is computable from the parent public key alone — unhardened derivation is recovered.

**Why multiplying by 8 preserves the clamping invariant.** `parent_kL` has its low 3 bits cleared by clamping (divisible by 8). `8·zL` is also divisible by 8 (it is `zL` left-shifted by 3). Their sum therefore also has low 3 bits zero — the cofactor-8 invariant is preserved through addition **without re-clamping**. Re-clamping after addition would destroy linearity; multiplying the tweak by 8 before adding avoids this entirely. The upper-bit constraint (`2²⁵⁴ ≤ kL < 2²⁵⁵`) holds with overwhelming probability because `zL` is drawn from a 224-bit HMAC output and cannot dominate the `parent_kL` term.

Hardened derivation in BIP32-Ed25519 works similarly but derives from the private key (using `0x00`/`0x01` prefixes instead of `0x02`/`0x03`), mirroring the SLIP-0010 approach for the levels where public key derivation is not needed.

### A.3 Cardano's Derivation Paths (CIP-1852, Shelley Era)

```
m / 1852' / 1815' / account' / role / index
```

| Level | Value | Hardened? | Rationale |
|---|---|---|---|
| Purpose | `1852'` | Yes | Named for Ada Lovelace's birth year; hardened to protect master key |
| Coin type | `1815'` | Yes | Cardano's SLIP-44 registration; hardened for same reason |
| Account | `0'`, `1'`, … | Yes | Isolates accounts; hardened to prevent cross-account key leakage |
| Role | `0` external, `1` change, `2` staking | **No** | Derivable from account xpub |
| Index | `0`, `1`, `2`, … | **No** | Derivable from account xpub |

The top three levels are hardened for a specific security reason: if an attacker obtains a leaf-level extended private key and the account-level extended public key, they could work upward to recover the account private key. Hardening at the account level severs this chain. Within an account, `role` and `index` are unhardened, enabling watch-only wallets that can generate all payment and change addresses from the exported account-level xpub without private key material.

The staking key at `m/1852'/1815'/account'/2/0` (role 2, index 0) is also unhardened at the leaf level and is therefore derivable from the account xpub.

### A.4 Comparison

| Property | NEAR (SLIP-0010) | Cardano (BIP32-Ed25519) |
|---|---|---|
| Unhardened derivation | Not possible | Supported via 8× tweak |
| Watch-only wallets | No | Yes (from account xpub) |
| Extended public keys (xpub) | No | Yes |
| Path structure | All hardened | Top 3 levels hardened; role and index unhardened |
| Signing scalar | `clamp(SHA-512(seed)[:32])` | Same, but `kR = SHA-512(seed)[32:]` carried alongside |
| Private key size | 32 bytes (seed) | 64 bytes (extended) |
| Clamping invariant preserved by | N/A (fresh key each time) | Multiplying tweak by 8 before addition |
| Security basis | SLIP-0010 (conservative: avoids the problem) | Khovratovich–Law paper (proves safety under the construction) |

### A.5 Implications for Midnight / NEARFall

NEAR's all-hardened approach is the safer and simpler choice: it requires no new security proof and is trivially correct. The cost is the loss of xpub-based watch-only wallets and hardware wallet address-generation flows — a real UX limitation for institutional custody, where the ability to verify receive addresses on an air-gapped device or generate address sequences without the signing key is standard practice.

Cardano's BIP32-Ed25519 recovers those capabilities at the cost of a more complex scheme with a bespoke security argument and a 64-byte extended key format that must be handled correctly throughout the wallet stack. If Midnight adopted BIP32-Ed25519, it would gain Cardano wallet compatibility and the institutional xpub workflow; if it adopted SLIP-0010, it would inherit the same limitations as NEAR but with a simpler implementation and a well-understood standard.

A middle path — BIP32-Ed25519 at the wallet layer, SLIP-0010 as the fallback for tools that do not need xpub — is feasible since neither scheme has protocol-level representation on the chain.

### A.6 Additional Sources

- [BIP32-Ed25519: Hierarchical Deterministic Keys over a Non-linear Keyspace — Khovratovich and Law](https://input-output-hk.github.io/adrestia/cardano-wallet/concepts/master-key-generation)
- [CIP-1852: HD Wallets for Cardano](https://github.com/cardano-foundation/CIPs/blob/master/CIP-1852/README.md)
- [CIP-0003: Wallet key generation](https://github.com/cardano-foundation/CIPs/blob/master/CIP-0003/README.md)
- [Cardano address derivation — cardano-addresses](https://github.com/IntersectMBO/cardano-addresses)
- [BIP-32: Hierarchical Deterministic Wallets](https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki)

---

## Appendix B: Use Case — Social Recovery for a High-Value Account

### B.1 Scenario

Alice holds significant assets on NEAR in `alice.near`. She wants protection against key loss without relying on a custodian or a seed-phrase backup stored somewhere attackable. She designates three trusted contacts — her spouse (`bob.near`), her lawyer (`carol.near`), and a hardware key in a safe deposit box (`vault-key.near`) — as guardians. Any two of the three can trigger a key rotation on her account if she loses access.

This is implemented through a recovery contract deployed on Alice's own account. No third party ever holds Alice's private key.

### B.2 A Critical Clarification: How Alice Gets the New Key

Before describing the flow, it is important to address an apparent paradox: if Alice has lost access to her account, how can she participate in the recovery, and how does she prove to the contract that she is Alice?

**Key generation requires no account access.** Generating a new Ed25519 keypair is purely local computation — Alice installs a NEAR wallet on a new device, or runs `near generate-key` on any machine, and obtains a fresh private key and its corresponding public key immediately. No NEAR signature, no on-chain state, and no existing account are required.

**Alice never proves her identity to the contract.** The contract only requires two guardians to agree. Alice proves her identity to Bob and Carol through their existing personal relationship — a phone call, a video call, or a meeting. That social verification is entirely off-chain. The contract enforces the threshold and the timelock; the human trust layer is what ensures the guardians only act on a legitimate request from Alice.

**The "social" in social recovery refers precisely to this.** The blockchain enforces the mechanism; the security reduces to whether the guardians are honest and can correctly identify Alice out-of-band.

### B.3 Contract State

Alice deploys a recovery contract to `alice.near` itself. The contract stores:

```rust
struct RecoveryContract {
    guardians: HashSet<AccountId>,      // { bob.near, carol.near, vault-key.near }
    threshold: u8,                      // 2
    pending_key: Option<PublicKey>,     // proposed replacement key
    confirmations: HashSet<AccountId>,  // guardians who have confirmed
    request_block: Option<BlockHeight>, // when the request was opened
    timelock_blocks: u64,               // e.g. 14400 (~2 days at ~1s blocks)
}
```

Alice also retains her FullAccess key for normal use. The recovery contract sits dormant and costs only its storage staking allocation.

### B.4 Recovery Flow

Alice loses her hardware wallet and cannot sign transactions.

**Step 1 — Alice generates a new keypair offline.**

Alice generates a fresh Ed25519 keypair on a new device. She now holds a new private key and its public key. No NEAR account access is required for this step. She contacts Bob and Carol through off-chain channels and gives them the new public key.

**Step 2 — Bob opens a recovery request.**

Bob calls `alice.near::initiate_recovery(new_public_key)` from `bob.near`. The contract:
- Verifies `predecessor_account_id()` is a registered guardian.
- Stores `pending_key = new_public_key`.
- Adds Bob to `confirmations`.
- Records `request_block = current_block_height`.

No key change happens yet. One confirmation out of two required.

**Step 3 — Carol confirms.**

Carol calls `alice.near::confirm_recovery()` from `carol.near`. The contract:
- Verifies Carol is a guardian and has not already confirmed.
- Adds Carol to `confirmations`.
- Checks: `confirmations.len()` (2) ≥ `threshold` (2). ✓
- Checks: `current_block_height` ≥ `request_block + timelock_blocks`.

If the timelock has not elapsed, the contract records the confirmation but does not act. Anyone can call `execute_recovery()` once the delay passes.

**Step 4 — Execution after timelock.**

Once the block height condition is met, `execute_recovery()` dispatches a promise:

```rust
Promise::new(env::current_account_id())
    .add_full_access_key(self.pending_key.unwrap())
```

This creates an `ActionReceipt` targeting `alice.near` itself. It executes in the next block and adds the new FullAccess key to Alice's account.

**Step 5 — Alice resumes control.**

Alice signs her first transaction using the new private key she has held since step 1. She then calls `DeleteKey` on the old key.

### B.5 The Role of the Timelock

The timelock exists to protect against a scenario where Bob and Carol collude maliciously and submit a public key they control. During the delay, Alice sees the on-chain `initiate_recovery` call (block explorers index it immediately), recognises she did not initiate it, and calls `cancel_recovery()` using her still-valid old key. The window is only useful if Alice's key is not actually lost — but this is exactly the case worth protecting: the threat of a malicious recovery attempt while Alice still has her key.

If Alice has genuinely lost her key, she cannot cancel, which is why choosing trustworthy guardians is the actual security assumption the whole scheme rests on. The contract enforces mechanism; human relationships enforce honesty.

### B.6 Why Promise-Based Key Management Is Essential

The contract cannot add a key to Alice's account in the same execution step as the threshold check. Key operations go through the promise/receipt mechanism. This is not merely a technical constraint — it is what makes the security model sound:

**The self-only rule prevents guardian escalation.** The promise targets `env::current_account_id()` — the recovery contract can only add keys to the account it is deployed on. A guardian calling the contract cannot use it to inject keys into any other account. Without this constraint, a recovery contract could be weaponised against third-party accounts.

**No external key holder is possible.** NEAR's key model does not permit one account to hold a FullAccess key to a different named account. Social recovery is therefore impossible through an external custodian account — the contract promise mechanism is the only path by which an external trigger (guardian confirmations) can produce a key change on Alice's account.

**Atomic execution.** The `AddKey` action either succeeds completely or fails completely in its receipt. There is no intermediate state where the threshold has been reached but the new key partially exists.

### B.7 What Would Be Required Without Promise-Based Key Management

Without the ability for a contract to add keys via a promise, social recovery on NEAR would require one of:

- **A custodial third party** holding a recovery key and acting on Alice's behalf — reintroducing the trust model social recovery is designed to eliminate.
- **A separate recovery account** (`alice-recovery.near`) controlled by guardians holding a FullAccess key to `alice.near` — impossible: NEAR does not permit external key holders for named accounts.
- **Off-chain key reconstitution** (e.g. Shamir's Secret Sharing of Alice's original private key) — complex, fragile, and requires Alice to have distributed key shares at setup.

The promise-based `add_full_access_key` is the only mechanism that allows a contract's execution logic (threshold check, timelock, guardian verification) to directly produce a key change on the account without any external trusted party.

### B.8 Security Properties

| Property | How achieved |
|---|---|
| No custodian | Self-only promise rule: contract modifies only its own account |
| Alice can cancel fraud | Timelock + her FullAccess key remains valid during delay |
| Guardian collusion resistance | Threshold ≥ 2; timelock gives Alice time to detect |
| Atomic execution | `AddKey` receipt succeeds or fails entirely |
| No key escrow | Guardians never see or hold Alice's private key material |
| New key pre-generated offline | Alice generates keypair independently; no account access needed |
| Identity verified off-chain | Guardians verify Alice's identity through personal relationship; contract enforces only the mechanism |
| Auditability | All `initiate_recovery` and `confirm_recovery` calls are on-chain transactions, publicly visible |

### B.9 Additional Sources

- [Promise — near-sdk-rs docs](https://docs.rs/near-sdk/latest/near_sdk/struct.Promise.html)
- [Actions — Nomicon Spec](https://nomicon.io/RuntimeSpec/Actions)
- [Receipts — Nomicon Spec](https://nomicon.io/RuntimeSpec/Receipts)
- [near/core-contracts — GitHub](https://github.com/near/core-contracts)
- [Social Recovery Wallet — Vitalik Buterin](https://vitalik.eth.limo/general/2021/01/11/recovery.html)

---

## Afterword: Quality Scrutiny

### 1. Sources Correspond to Retrievable URLs

This document is the most thoroughly sourced of the assessments reviewed in this series: it has a dedicated `## Sources` section with over 50 citations spanning official NEAR documentation, Nomicon specification pages, NEPs, nearcore GitHub issues and source files, SDK documentation, and internal Midnight documents.

**URLs checked:**
- `docs.near.org/chain-abstraction/chain-signatures` — accessible; verified: 8 MPC nodes, domain_id scheme, "Additive Key Derivation" terminology.
- `github.com/near/NEPs/blob/master/neps/nep-0448.md` — accessible; verified: Final status approved February 9, 2023; ≤770-byte storage threshold.
- `github.com/near/nearcore/issues/4548` — accessible; verified: ecrecover base cost ~93 TGas.
- `nomicon.io/DataStructures/AccessKey` — accessible; partial: nonce initialization and zero-allowance key retention semantics are not documented at Nomicon specification level (they are implementation details in `nearcore` source).
- **Chain Signatures launch blog post** (`pages.near.org/blog/chain-signatures-launch-…`) — **inaccessible**: redirects permanently to `docs.near.org` homepage. The launch date of August 8, 2024 and Eigenlayer claim cannot be verified from this source.
- SLIP-0010, SLIP-0044, nearcore source files, NEP-366, NEP-413, NEP-71, NEP-491, NEP-518, `near/core-contracts`, `near/near-seed-phrase` — cited correctly; formats are consistent with the AGENTS.md `[Title — Publisher/Context](URL)` convention.
- **Internal Midnight sources** (three background documents, one internal PDF specification) — cited with repository-relative paths in accordance with the AGENTS.md convention for internal documents; not publicly accessible but correctly flagged as internal.

### 2. Internal Consistency

The document is internally consistent on technical substance. Two structural numbering errors are present:

- **Duplicate §2.3.** The heading `### 2.3 Account Name Rules` (line 70) and `### 2.3 The CreateAccount Action` (line 81) share the same section number. The second should be §2.4, which pushes all subsequent sub-sections of §2 up by one.
- **Missing §3.7.** The section sequence jumps from `### 3.6 ETH-Implicit Account Keys` directly to `### 3.8 Secp256k1 as a Regular Account Access Key`, with no §3.7. Either a section was removed without renumbering or the numbering was incremented by mistake.

Neither error affects the technical content, but they create confusion when cross-referencing sections.

The security analysis in §10 is consistent with the technical descriptions in §§1–9. The Midnight applicability analysis in §11 correctly identifies which NEAR mechanisms have direct analogues, which require adaptation, and which have no equivalent — and this is consistent with claims made in other repository assessments (`modularity-comparison.md`, `contract-to-contract-calls.md`).

### 3. Accuracy Against Sources

- **8 MPC nodes** — ✅ Verified verbatim: "The MPC Service comprises eight independent nodes."
- **`domain_id` 0 = Secp256k1, 1 = Ed25519** — ✅ Verified verbatim from Chain Signatures documentation.
- **"Additive Key Derivation"** — ✅ Verified as the official NEAR term for the foreign-address derivation scheme.
- **ecrecover ~93 TGas per call** — ✅ Verified from nearcore issue #4548 benchmark measurements.
- **NEP-448 shipped February 2023, ≤770-byte threshold** — ✅ Verified from NEP text (Final, approved February 9, 2023; exact 770-byte figure present).
- **"Secured by NEAR staking and Eigenlayer ETH restakers"** (§8) — ❓ Not found in current `docs.near.org/chain-abstraction/chain-signatures`. The Eigenlayer restaking security model was discussed in NEAR's August 2024 launch announcements but does not appear in the current official documentation; it may have been accurate at launch and since changed, or may be in a blog post or announcement page that is no longer accessible. This claim should be re-verified against current NEAR sources.
- **Chain Signatures mainnet launch date: August 8, 2024** — ❓ The cited source (blog post) permanently redirects. The date is plausible and corroborated by the internal `background/mpc-chain-signatures-summary.md`, but cannot be independently confirmed from a public URL at this time.
- **BLS12-381 (planned) via `vote_add_domains`** (§8 table) — ❓ Not found in current Chain Signatures documentation. The `vote_add_domains` governance mechanism is a specific technical claim that was not confirmed by any retrieved source. It may be correct but is sourced from the internal MPC summary rather than a public specification.
- **Nonce initialized as `block_height × MULTIPLIER`** (§3.1) — ❓ Not present in the Nomicon spec. This is an implementation detail verifiable from `nearcore` source (the relevant function is `AccessKey::new` in `nearcore`), which is cited in the sources list but was not fetched for this review. The Nomicon specification confirms nonces prevent replay without specifying the initialization formula.
- **FunctionCall key with `allowance = Some(0)` is not auto-deleted** (§3.3) — ❓ Not confirmed at Nomicon specification level. Corroborated by the cited `near-sdk-rs` issue #871 ("zero allowance foot-gun"), which implies the behaviour is real and documented as a known issue.
- **FastAuth launched May 2023** (§9.2) — ❓ Unsourced in the document; no URL is cited for this claim.
- All NEP-level descriptions (NEP-366, NEP-413, NEP-71, NEP-448, NEP-491, NEP-518) — ✅ Match the cited NEP texts in structure and described behaviour.

### 4. Areas of Greatest Uncertainty

- **Eigenlayer/restaker security model.** The specific claim that Chain Signatures nodes are secured by Eigenlayer ETH restakers appears in no currently accessible official source. If incorrect or outdated, it mildly overstates the security model but does not affect the functional description of Chain Signatures.
- **`vote_add_domains` governance mechanism.** The mechanism by which new signature curve support is added to Chain Signatures is described but not sourced to a public document. The BLS12-381 "planned" entry in the table is unverifiable.
- **Implementation-level nonce details** (`block_height × MULTIPLIER`). This is likely correct (the referenced `nearcore` source file is cited) but is not confirmed from the Nomicon spec, which is the authoritative behavioural specification. Readers who need to rely on this detail should verify against nearcore source directly.
- **Section 11 Midnight applicability analysis.** The entire section draws on internal Midnight background documents (three documents cited, one a PDF). The analysis is plausible and consistent with other repository assessments but is not independently verifiable from public sources.
- **The short-TLA auction mechanism "was not fully operationalized."** The document states this as a fact in §2.4 but cites only a single GitHub issue (`core-contracts` issue #25) as evidence. The claim is consistent with public knowledge about NEAR's name governance in practice, but the extent to which the auction was and was not operationalized for specific TLA categories is not fully documented.

### 5. Robustness of Primary Conclusions

This document's primary deliverables are descriptive rather than evaluative — it documents how NEAR's key management system works in precise detail and assesses applicability to Midnight. The two load-bearing conclusions are:

1. *NEAR's FunctionCall key (session key) model is a genuine, under-appreciated UX innovation with no native equivalent on EVM chains, Solana, or Cardano, and is directly applicable to Midnight.*  **Robust.** This rests on well-sourced, verifiable NEP specifications and protocol documentation. The comparative claim (no native EVM equivalent) is a standard characterization that ERC-4337 partially addresses but at materially higher complexity.

2. *Chain Signatures is the strongest NEAR component for Option 2 (take software from NEAR), with the main integration obstacle being the BN254 vs BLS12-381 curve incompatibility identified in the NearFall Technical Specification.*  **Moderately robust.** The functional description of Chain Signatures is well-sourced. The curve-incompatibility claim depends on the internal NearFall Technical Specification (not publicly accessible) and on the BN254/Sirius characterization also noted as uncertain in the `modularity-comparison.md` Afterword. The robustness of this conclusion therefore depends on that document's accuracy.

Overall this is the best-sourced assessment in the repository, with clear citation practice, well-organized sourcing by domain, and a level of technical specificity that reflects direct engagement with nearcore source code and NEP specifications. The main gaps are the inaccessible blog-post launch citation, the two structural numbering errors, and three specific claims (Eigenlayer, `vote_add_domains`, FastAuth date) that lack retrievable public sources.
