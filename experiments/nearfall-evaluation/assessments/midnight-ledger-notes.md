# 🤖👱 Midnight Ledger Structure: Notes

**Date:** 2026-04-10
**Context:** NEARFall feasibility study — reference notes on the concrete structure of the Midnight ledger, derived from the `midnight-ledger` repository.

---

## Ledger Structure

### Overall `LedgerState`

From [`spec/intents-transactions.md`](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/intents-transactions.md):

```rust
struct LedgerState {
    utxo:               UtxoState,           // unshielded Night tokens
    zswap:              ZswapState,          // shielded Zswap coins
    dust:               DustState,           // fee-payment token
    contract:           LedgerContractState, // smart contract state
    replay_protection:  ReplayProtectionState,
    params:             LedgerParameters,
}
```

### Unshielded Ledger (Night)

Sources: [`spec/night.md`](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/night.md), [`ledger/src/structure.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/src/structure.rs).

The unshielded ledger is a plain UTXO set for NIGHT and custom tokens. Each UTXO is keyed by its full content; the state is a map from UTXOs to metadata.

#### Types (spec pseudocode)

```rust
type NightAddress = Hash<VerifyingKey>;   // SHA-256 of Schnorr/secp256k1 verifying key

struct Utxo {
    value:       u128,
    owner:       NightAddress,
    type_:       RawTokenType,
    intent_hash: IntentHash,
    output_no:   u32,
}

struct UtxoOutput {           // used in tx construction
    value:  u128,
    owner:  NightAddress,
    type_:  RawTokenType,
}

struct UtxoSpend {            // used in tx inputs; carries unhashed owner for sig verification
    value:       u128,
    owner:       VerifyingKey,     // NOT hashed — needed for signature check
    type_:       RawTokenType,
    intent_hash: IntentHash,
    output_no:   u32,
}

// UtxoSpend → Utxo by hashing the owner
impl From<UtxoSpend> for Utxo {
    fn from(s: UtxoSpend) -> Utxo { Utxo { owner: hash(s.owner), .. } }
}

struct UtxoMeta  { ctime: Timestamp }
struct UtxoState { utxos: Map<Utxo, UtxoMeta> }
```

#### Actual Rust implementation

The impl types match the spec but add storage generics. From [`ledger/src/structure.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/src/structure.rs):

```rust
// tag = "unshielded-offer[v1]"
pub struct UnshieldedOffer<S: SignatureKind<D>, D: DB> {
    pub inputs:     storage::storage::Array<UtxoSpend, D>,
    pub outputs:    storage::storage::Array<UtxoOutput, D>,
    pub signatures: storage::storage::Array<S::Signature<SegIntent<D>>, D>,
}
```

`UtxoSpend` and `UtxoOutput` are defined in `structure.rs` as non-generic value types (confirmed by the import in `construct.rs`: `use crate::structure::{..., UtxoOutput, UtxoSpend}`). Their fields match the spec exactly.

**Key points:**
- The UTXO is keyed by its *full content* (value + owner + type + intent_hash + output_no). There is no separate UTXO ID — the UTXO *is* its own key.
- Signatures sign `(segment_id, ErasedIntent)` — the parent intent stripped of signatures and proofs — preventing circular self-reference.

### Shielded Ledger (Zswap)

Sources: [`spec/zswap.md`](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/zswap.md), [`zswap/src/structure.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/zswap/src/structure.rs), [`zswap/src/ledger.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/zswap/src/ledger.rs), [`coin-structure/src/coin.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/coin-structure/src/coin.rs).

Zswap is a Zerocash-style multi-asset shielded system. The state is commitment/nullifier sets; the actual coin contents are never revealed on-chain.

#### Cryptographic primitives (spec)

```rust
type ZswapCoinSecretKey = [u8; 32];
type ZswapCoinPublicKey = Hash<ZswapCoinSecretKey>;      // SHA-256

type ZswapEncryptionSecretKey = Fr;                      // embedded curve scalar
type ZswapEncryptionPublicKey = embedded::CurvePoint;    // for ECDH ciphertext

struct CoinInfo {                      // never stored on-chain; witness only
    value: u128,
    type_: RawTokenType,
    nonce: [u8; 32],
}

type CoinCommitment = Hash<(CoinInfo, ZswapCoinPublicKey)>;
type CoinNullifier  = Hash<(CoinInfo, ZswapCoinSecretKey)>;
```

#### Actual Rust coin types (`coin-structure/src/coin.rs`)

```rust
// tag = "zswap-nonce[v1]"
pub struct Nonce(pub HashOutput);

// tag = "zswap-coin-secret-key[v1]"   (Zeroize + ZeroizeOnDrop)
pub struct SecretKey(pub HashOutput);

// tag = "zswap-coin-public-key[v2]"
pub struct PublicKey(pub HashOutput);

// tag = "zswap-coin-commitment[v2]"
pub struct Commitment(pub HashOutput);

// tag = "zswap-nullifier[v2]"
pub struct Nullifier(pub HashOutput);

// tag = "shielded-coin-info[v2]"
pub struct Info {                        // = spec CoinInfo
    pub nonce:  Nonce,
    pub type_:  ShieldedTokenType,
    pub value:  u128,
}

// tag = "shielded-qualified-coin-info[v2]"  (wallet-side, includes merkle index)
pub struct QualifiedInfo {
    pub nonce:    Nonce,
    pub type_:    ShieldedTokenType,
    pub value:    u128,
    pub mt_index: u64,
}

// tag = "shielded-token-type[v1]"
pub struct ShieldedTokenType(pub HashOutput);

// tag = "unshielded-token-type[v1]"
pub struct UnshieldedTokenType(pub HashOutput);

// tag = "token-type[v1]"
pub enum TokenType {
    Unshielded(UnshieldedTokenType),
    Shielded(ShieldedTokenType),
    Dust,
}
```

#### Transaction types (`zswap/src/structure.rs`)

```rust
// tag = "zswap-input[v2]"
pub struct Input<P: Storable<D>, D: DB> {
    pub nullifier:        Nullifier,
    pub value_commitment: Pedersen,                    // homomorphic Pedersen over embedded curve
    pub contract_address: Option<Sp<ContractAddress, D>>,
    pub merkle_tree_root: MerkleTreeDigest,            // historical root used in proof
    pub proof:            Arc<P>,
}

// tag = "zswap-output[v2]"
pub struct Output<P: Storable<D>, D: DB> {
    pub coin_com:         Commitment,
    pub value_commitment: Pedersen,
    pub contract_address: Option<Sp<ContractAddress, D>>,
    pub ciphertext:       Option<Sp<CoinCiphertext, D>>,  // ECDH + Poseidon CTR
    pub proof:            Arc<P>,
}

pub struct CoinCiphertext {
    pub c:    EmbeddedGroupAffine,       // ephemeral DH public key
    pub ciph: [Fr; COIN_CIPHERTEXT_LEN],
}

// tag = "zswap-transient[v2]"  — input+output within same transaction
pub struct Transient<P: Storable<D>, D: DB> {
    pub nullifier:               Nullifier,
    pub coin_com:                Commitment,
    pub value_commitment_input:  Pedersen,
    pub value_commitment_output: Pedersen,
    pub contract_address:        Option<Sp<ContractAddress, D>>,
    pub ciphertext:              Option<Sp<CoinCiphertext, D>>,
    pub proof_input:             Arc<P>,
    pub proof_output:            Arc<P>,
}

// tag = "zswap-delta"
pub struct Delta {
    pub token_type: ShieldedTokenType,
    pub value:      i128,
}

// tag = "zswap-offer[v5]"
pub struct Offer<P: Storable<D>, D: DB> {
    pub inputs:    Array<Input<P, D>, D>,
    pub outputs:   Array<Output<P, D>, D>,
    pub transient: Array<Transient<P, D>, D>,
    pub deltas:    Array<Delta, D>,           // net token imbalance; must sum to zero
}
```

#### Ledger state (`zswap/src/ledger.rs`)

```rust
// tag = "zswap-ledger-state[v5]"
pub struct State<D: DB> {
    pub coin_coms:     MerkleTree<Option<Sp<ContractAddress, D>>, D>,  // append-only
    pub coin_coms_set: HashMap<Commitment, (), D>,    // dedup guard
    pub first_free:    u64,                           // next free tree slot
    pub nullifiers:    HashMap<Nullifier, (), D>,
    pub past_roots:    TimeFilterMap<Identity<MerkleTreeDigest>, D>,
}
```

**Key points:**
- Commitments go in both a Merkle tree (for inclusion proofs) and a plain set (for dedup).
- Nullifiers are a flat set — no values, just presence.
- `past_roots` retains historical Merkle roots for the TTL window so old proofs validate.
- `deltas` must be collectively openable to the identity commitment (balance check via homomorphic Pedersen).
- Inputs and outputs are bound to segment IDs — coins of different segments/types are homomorphically unmixable.

### Dust Ledger

Sources: [`spec/dust.md`](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/dust.md), [`ledger/src/dust.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/src/dust.rs).

Dust is a shielded, non-transferable fee token. Its value is dynamically derived from a backing NIGHT UTXO and changes over time (grows while Night is held, decays after it is spent).

#### Cryptographic primitives (spec)

```rust
type DustSecretKey = Fr;                          // ZK-friendly (field element, not SHA-256)
type DustPublicKey = field::Hash<DustSecretKey>;  // Poseidon-based hash
type InitialNonce  = Hash<(IntentHash, u32)>;     // links back to originating Night UTXO
```

#### Core UTXO types

Spec pseudocode:

```rust
struct DustOutput {
    initial_value: u128,                              // value at creation time (Specks)
    owner:         DustPublicKey,
    nonce:         field::Hash<(InitialNonce, u32, Fr)>,  // deterministic, wallet-recoverable
    seq:           u32,                               // position in self-spend chain
    ctime:         Timestamp,
}

struct DustPreProjection<T> {    // T = DustPublicKey for commitment, DustSecretKey for nullifier
    initial_value: u128,
    owner:         T,
    nonce:         field::Hash<(InitialNonce, u32, Fr)>,
    ctime:         Timestamp,
}

type DustCommitment = field::Hash<DustPreProjection<DustPublicKey>>;
type DustNullifier  = field::Hash<DustPreProjection<DustSecretKey>>;
```

Actual Rust from [`ledger/src/dust.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/src/dust.rs):

```rust
// tag = "dust-nullifier[v1]"
pub struct DustNullifier(pub Fr);

// tag = "dust-commitment[v1]"
pub struct DustCommitment(pub Fr);

// tag = "dust-public-key[v1]"
pub struct DustPublicKey(pub Fr);

// tag = "dust-secret-key[v1]"   (Zeroize + ZeroizeOnDrop)
pub struct DustSecretKey(pub Fr);

// tag = "dust-initial-nonce[v1]"
pub struct InitialNonce(pub HashOutput);

// tag = "dust-output[v1]"
pub struct DustOutput {
    pub initial_value: u128,
    pub owner:         DustPublicKey,
    pub nonce:         Fr,
    pub seq:           u32,
    pub ctime:         Timestamp,
}

// wallet-side only — includes backing Night link and tree position
// tag = "qualified-dust-output[v1]"
pub struct QualifiedDustOutput {
    pub initial_value: u128,
    pub owner:         DustPublicKey,
    pub nonce:         Fr,
    pub seq:           u32,
    pub ctime:         Timestamp,
    pub backing_night: InitialNonce,
    pub mt_index:      u64,
}

// tag = "dust-pre-projection[v1]"
pub struct DustPreProjection<T> {
    pub initial_value: u128,
    pub owner:         T,
    pub nonce:         Fr,
    pub ctime:         Timestamp,
}
```

#### Generation bookkeeping

```rust
// tag = "dust-generation-info[v1]"
pub struct DustGenerationInfo {
    pub value: u128,          // Night value (Stars) backing this UTXO
    pub owner: DustPublicKey,
    pub nonce: InitialNonce,
    pub dtime: Timestamp,     // when backing Night was spent; Timestamp::MAX if still live
}

// tag = "dust-generation-uniqueness-info"
pub struct DustGenerationUniquenessInfo {
    pub value: u128,
    pub owner: DustPublicKey,
    pub nonce: InitialNonce,
}
```

#### Transaction types

```rust
// tag = "dust-spend[v1]"  — 1-to-1 self-spend (non-transferable)
pub struct DustSpend<P: ProofKind<D>, D: DB> {
    pub v_fee:          u128,
    pub old_nullifier:  DustNullifier,
    pub new_commitment: DustCommitment,
    pub proof:          P::LatestProof,
}

// tag = "dust-registration[v1]"
pub struct DustRegistration<S: SignatureKind<D>, D: DB> {
    pub night_key:         VerifyingKey,
    pub dust_address:      Option<Sp<DustPublicKey, D>>,  // None = deregister
    pub allow_fee_payment: u128,
    pub signature:         Option<Sp<S::Signature<(u16, ErasedIntent<D>)>, D>>,
}

// tag = "dust-actions[v1]"
pub struct DustActions<S: SignatureKind<D>, P: ProofKind<D>, D: DB> {
    pub spends:        storage::storage::Array<DustSpend<P, D>, D>,
    pub registrations: storage::storage::Array<DustRegistration<S, D>, D>,
    pub ctime:         Timestamp,   // tx author's claimed time; must be within dust_grace_period
}
```

#### State

```rust
// tag = "dust-utxo-state[v1]"
pub struct DustUtxoState<D: DB> {
    pub commitments:            MerkleTree<(), D>,
    pub commitments_first_free: u64,
    pub nullifiers:             HashSet<DustNullifier, D>,
    pub root_history:           TimeFilterMap<Identity<MerkleTreeDigest>, D>,
}

// tag = "dust-generation-state[v1]"
pub struct DustGenerationState<D: DB> {
    pub address_delegation:         Map<UserAddress, DustPublicKey, D>,  // Night→Dust key mapping
    pub generating_tree:            MerkleTree<DustGenerationInfo, D>,
    pub generating_tree_first_free: u64,
    pub generating_set:             HashSet<DustGenerationUniquenessInfo, D>,
    pub night_indices:              HashMap<InitialNonce, u64, D>,
    pub root_history:               TimeFilterMap<Identity<MerkleTreeDigest>, D>,
}

// tag = "dust-state[v1]"
pub struct DustState<D: DB> {
    pub utxo:       DustUtxoState<D>,
    pub generation: DustGenerationState<D>,
}
```

#### Parameters

```rust
// tag = "dust-parameters[v1]"
pub struct DustParameters {
    pub night_dust_ratio:      u64,      // initial: 5_000_000_000 (5 DUST/NIGHT in Specks/Stars)
    pub generation_decay_rate: u32,      // initial: 8_267 Specks/Star/sec ≈ 1-week fill time
    pub dust_grace_period:     Duration, // initial: 3 hours
}
```

### Transaction Envelope

From [`ledger/src/structure.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/src/structure.rs):

```rust
// tag = "transaction[v9]"
pub enum Transaction<S, P, B, D> {
    Standard(StandardTransaction<S, P, B, D>),
    ClaimRewards(ClaimRewardsTransaction<S, D>),
}

// tag = "standard-transaction[v9]"
pub struct StandardTransaction<S, P, B, D> {
    pub network_id:         String,
    pub intents:            HashMap<u16, Intent<S, P, B, D>, D>,
    pub guaranteed_coins:   Option<Sp<ZswapOffer<P::LatestProof, D>, D>>,
    pub fallible_coins:     HashMap<u16, ZswapOffer<P::LatestProof, D>, D>,
    pub binding_randomness: PedersenRandomness,
}

// tag = "intent[v6]"
pub struct Intent<S, P, B, D> {
    pub guaranteed_unshielded_offer: Option<Sp<UnshieldedOffer<S, D>, D>>,
    pub fallible_unshielded_offer:   Option<Sp<UnshieldedOffer<S, D>, D>>,
    pub actions:                     Array<ContractAction<P, D>, D>,
    pub dust_actions:                Option<Sp<DustActions<S, P, D>, D>>,
    pub ttl:                         Timestamp,
    pub binding_commitment:          B,   // Pedersen binding across all three ledgers
}
```

### Structural Comparison

| | Unshielded (Night) | Shielded (Zswap) | Dust |
|---|---|---|---|
| **State model** | `Map<Utxo, UtxoMeta>` | commitment tree + nullifier set | commitment tree + nullifier set + generation tree |
| **UTXO key** | full `Utxo` struct content | `Commitment` (hash) | `DustCommitment` (field element) |
| **Ownership proof** | Schnorr signature over `ErasedIntent` | ZK proof (spend circuit) | ZK proof (spend circuit) |
| **Key type** | secp256k1 `VerifyingKey` / `NightAddress` | `SecretKey`/`PublicKey` (SHA-256 of random bytes) | `DustSecretKey`/`DustPublicKey` (Fr / Poseidon) |
| **Hash function** | SHA-256 | SHA-256 | Poseidon (ZK-friendly) |
| **Transferable** | Yes | Yes | No (1-to-1 self-spends only) |
| **Value visible** | Yes | No (homomorphic commitment) | No (ZK proof of `updated_value`) |
| **Time-varying value** | No | No | Yes (grows/decays based on backing Night) |
| **Merkle tree** | None | Yes (for inclusion proofs in spend circuit) | Two trees: UTXOs + generation info |
| **Serialization tag** | `unshielded-offer[v1]` | `zswap-offer[v5]` | `dust-actions[v1]` |

---

## Persistent Storage

Sources: [`storage-core/src/db.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/storage-core/src/db.rs), [`storage/src/storage.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/storage/src/storage.rs), [`zswap/src/local.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/zswap/src/local.rs), [`ledger/src/dust.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/src/dust.rs), [`spec/storage-io-cost-modeling.md`](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/storage-io-cost-modeling.md).

### Storage abstraction

All stateful types are generic over `D: DB`, a content-addressable key-value backend:

```rust
pub trait DB: Default + Sync + Send + Debug + 'static {
    type Hasher: WellBehavedHasher;

    fn get_node(&self, key: &ArenaHash<Self::Hasher>) -> Option<OnDiskObject<Self::Hasher>>;
    fn insert_node(&mut self, key: ArenaHash<Self::Hasher>, object: OnDiskObject<Self::Hasher>);
    fn delete_node(&mut self, key: &ArenaHash<Self::Hasher>);
    fn batch_update<I>(&mut self, iter: I) where I: Iterator<Item = (ArenaHash<Self::Hasher>, Update<Self::Hasher>)>;
    // ... batch_get_nodes, bfs_get_nodes, root-count management
}
```

Concrete backends: `InMemoryDB` (testing), `SqlDB` (SQLite, feature-gated), `ParityDb` (feature-gated).

Values are accessed through `Sp<V, D>` (storage pointer), which stores the hash of the serialised value and loads it lazily on first access. This means large sub-trees are never loaded unless touched.

The higher-level containers — all backed by a Merkle-Patricia Trie — are:

| Type | Description |
|------|-------------|
| `Map<K, V, D>` | General ordered key-value map; keys serialised to nibble paths |
| `HashMap<K, V, D>` | Keys hashed to `ArenaHash` before storage |
| `HashSet<V, D>` | Set backed by `HashMap<V, (), D>` |
| `Array<V, D>` | MPT-indexed sequence; O(log n) insert/retrieve |
| `MerkleTree<V, D>` | Append-only tree; leaves indexed by `u64` |
| `TimeFilterMap<C, D>` | Time-keyed map (big-endian u64); supports predecessor lookup and TTL pruning |

Contract state uses a separate reference-counted Merkle DAG (`RcMap`) where the storage cost model charges for every node in the reachability closure of the state root. Writes and deletes are costed globally at transaction-end; reads are costed locally during VM execution.

### Public state (on-chain, held by all full nodes)

The full consensus state is `LedgerState<D>`, composed of the following public sub-states.

**Unshielded ledger** — `UtxoState`:

```
utxos: Map<Utxo, UtxoMeta>
```

Every UTXO and its creation timestamp are stored in the clear. The complete `Utxo` — including value, owner (`NightAddress` = SHA-256 of a secp256k1 key), token type, `intent_hash`, and `output_no` — is the map key. Nothing about unshielded UTXOs is hidden from node operators.

**Shielded ledger** — `zswap::State<D>` (from [`zswap/src/ledger.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/zswap/src/ledger.rs)):

```rust
// tag = "zswap-ledger-state[v5]"
pub struct State<D: DB> {
    pub coin_coms:     MerkleTree<Option<Sp<ContractAddress, D>>, D>,
    pub coin_coms_set: HashMap<Commitment, (), D>,
    pub first_free:    u64,
    pub nullifiers:    HashMap<Nullifier, (), D>,
    pub past_roots:    TimeFilterMap<Identity<MerkleTreeDigest>, D>,
}
```

What is public: commitment hashes (opaque), nullifier hashes (opaque), historical Merkle roots, and — notably — whether each commitment is contract-owned (the `Option<ContractAddress>` leaf annotation is stored in the tree alongside the commitment). User-owned commitments carry `None`; contract-owned commitments expose the contract address.

What is hidden: coin value, coin type, nonce — these are the ZK circuit witnesses and never leave the prover.

**Dust ledger** — `DustState<D>` (from [`ledger/src/dust.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/src/dust.rs)):

```rust
pub struct DustUtxoState<D: DB> {
    pub commitments:            MerkleTree<(), D>,        // opaque field elements
    pub commitments_first_free: u64,
    pub nullifiers:             HashSet<DustNullifier, D>,
    pub root_history:           TimeFilterMap<Identity<MerkleTreeDigest>, D>,
}

pub struct DustGenerationState<D: DB> {
    pub address_delegation:         Map<UserAddress, DustPublicKey, D>,  // Night→Dust key table
    pub generating_tree:            MerkleTree<DustGenerationInfo, D>,   // fully public
    pub generating_tree_first_free: u64,
    pub generating_set:             HashSet<DustGenerationUniquenessInfo, D>,
    pub night_indices:              HashMap<InitialNonce, u64, D>,
    pub root_history:               TimeFilterMap<Identity<MerkleTreeDigest>, D>,
}
```

The `generating_tree` stores `DustGenerationInfo` in the clear: Night value (Stars), Dust public key, nonce, and death time. This means the amount of Night staked for Dust generation — and which Dust key it generates to — is fully public knowledge, even though the Dust UTXO commitments themselves are opaque. The `address_delegation` table similarly exposes the Night-to-Dust address mapping.

**Replay protection** — `ReplayProtectionState<D>`:

```rust
// tag = "replay-protection-state[v1]"
pub struct ReplayProtectionState<D: DB> {
    pub time_filter_map: TimeFilterMap<HashSet<IntentHash, D>, D>,
}
```

Intent hashes are retained in a TTL-pruned time-indexed map to prevent replay.

**Contract state** — `Map<ContractAddress, ContractState<D>, D>`:

```rust
pub struct ContractState<D: DB> {
    pub data:                  ChargedState<D>,
    pub operations:            HashMap<EntryPointBuf, ContractOperation, D>,
    pub maintenance_authority: ContractMaintenanceAuthority,
    pub balance:               HashMap<TokenType, u128, D>,
}
```

All contract state — data, verifier keys, token balances — is fully public.

### Private state (off-chain, wallet-local only)

**Shielded wallet state** — `zswap::local::State<D>` (from [`zswap/src/local.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/zswap/src/local.rs)):

```rust
pub struct State<D: DB> {
    pub coins:            Map<Nullifier, QualifiedCoinInfo, D>,  // owned coins with plaintext info
    pub pending_spends:   Map<Nullifier, QualifiedCoinInfo, D>,
    pub pending_outputs:  Map<Commitment, CoinInfo, D>,
    pub merkle_tree:      MerkleTree<(), D>,                     // local copy for proof generation
    pub first_free:       u64,
}
```

The wallet decrypts incoming `CoinCiphertext` fields (ECDH + Poseidon CTR cipher) to recover `CoinInfo` (nonce, type, value) and stores the plaintext locally. It also maintains a local copy of the commitment Merkle tree to build membership paths for spend proofs.

**Dust wallet state** — `DustLocalState<D>` (from [`ledger/src/dust.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/src/dust.rs)):

```rust
pub struct DustLocalState<D: DB> {
    generating_tree:            MerkleTree<DustGenerationInfo, D>,
    generating_tree_first_free: u64,
    commitment_tree:            MerkleTree<(), D>,
    commitment_tree_first_free: u64,
    night_indices:              HashMap<InitialNonce, u64, D>,
    dust_utxos:                 HashMap<DustNullifier, DustWalletUtxoState, D>,
    pub sync_time:              Timestamp,
    pub params:                 DustParameters,
}

pub struct DustWalletUtxoState {
    utxo:          QualifiedDustOutput,  // full plaintext including backing Night link
    pending_until: Option<Timestamp>,
}
```

The wallet tracks owned Dust UTXOs with their full `QualifiedDustOutput` (value, owner, nonce, seq, ctime, backing Night nonce, Merkle index). Like the Zswap local state, it also keeps a local copy of both the Dust commitment tree and the generation info tree for proof construction.

**ZK proof witnesses** — never persisted, ephemeral only:

These are inputs to the proof circuits that never touch the chain:
- Zswap `SecretKey` (`HashOutput`) and Dust `DustSecretKey` (`Fr`)
- Coin plaintext: `Info { nonce, type_, value }` and `DustOutput` fields
- Merkle inclusion paths for commitment and generation trees
- Pedersen randomness scalars (`rc` per input/output) used in the homomorphic balance check
- ECDH ephemeral scalar for encryption/decryption

### Size and growth analysis

All containers use Merkle-Patricia Tries internally. Raw leaf data should be multiplied by roughly **2–3× for MPT internal-node overhead** (shared hash nodes, extension nodes, branch nodes). The estimates below are for raw leaf data only.

**Variable notation used in formulas:**

| Symbol | Meaning |
|--------|---------|
| U_live | live unshielded UTXOs at a given instant |
| S_total | cumulative shielded outputs ever created |
| S_spent | cumulative shielded coins ever spent (= nullifier count) |
| D_gen | cumulative Night UTXO outputs that triggered Dust generation |
| D_spend | cumulative Dust spends ever made |
| R_active | active Dust registrations (Night addresses currently mapped to a Dust key) |
| T_ttl | global TTL (seconds); controls Zswap root history and replay-protection window |
| T_grace | Dust grace period (seconds); initial value 10,800 s = 3 h |
| T_block | block interval (seconds) |
| TPS | average transactions per second |
| I_tx | average intents per transaction |

---

#### Unshielded UTXO set

**Per-entry raw size:** `sizeof(Utxo) + sizeof(UtxoMeta)` = (16 + 32 + 32 + 32 + 4) + 8 = **124 bytes**
(`value u128` + `owner HashOutput` + `type_ HashOutput` + `intent_hash HashOutput` + `output_no u32`) + `ctime u64`

**Total size:** `124 × U_live` bytes

**Growth dependency:** Proportional to **live UTXO count only**. Entries are removed on spend; the set does not accumulate historical data. In steady state, size is bounded by the number of addresses actively holding NIGHT.

---

#### Zswap commitment tree (`coin_coms`) and dedup set (`coin_coms_set`)

**Per-commitment raw size:**
- `coin_coms` leaf: 32 bytes (Commitment/HashOutput) + 1–33 bytes (Option<ContractAddress>) = **33–65 bytes**
- `coin_coms_set` entry: 32 bytes (Commitment key)
- Combined: **65–97 bytes per shielded output**

**Total size:** `~80 × S_total` bytes (rough midpoint)

**Growth dependency:** **Append-only; never shrinks.** Grows monotonically with every shielded output ever created across all history. Spending a coin adds a nullifier but does NOT remove the commitment. Long-run growth rate ≈ 80 bytes × shielded output rate.

---

#### Zswap nullifier set (`nullifiers`)

**Per-entry raw size:** 32 bytes (Nullifier/HashOutput)

**Total size:** `32 × S_spent` bytes

**Growth dependency:** **Append-only; never shrinks.** Grows with every shielded spend. The gap `S_total - S_spent` equals the number of currently live shielded coins — this difference is the only quantity that can decrease.

---

#### Zswap historical roots (`past_roots`)

**Per-entry raw size:** 8 bytes (BigEndianU64 timestamp key) + 32 bytes (MerkleTreeDigest) = **40 bytes**

**Total size:** `40 × (T_ttl / T_block)` bytes

**Growth dependency:** **Bounded by TTL; pruned at each block.** Size is a function of the protocol TTL and block rate, not transaction volume. Example: T_ttl = 86,400 s (24 h), T_block = 6 s → ~14,400 entries → **~576 KB**.

---

#### Dust commitment tree (`DustUtxoState.commitments`)

**Per-leaf raw size:** 32 bytes (DustCommitment as Fr field element)

**Total size:** `32 × (D_gen + D_spend)` bytes

**Growth dependency:** **Append-only; never shrinks.** A new Dust UTXO is created both when a registered Night UTXO is created (D_gen) and when an existing Dust UTXO is spent (D_spend, since every spend produces a new UTXO). Growth rate is therefore the sum of the Night output rate (for registered addresses) and the Dust spend rate.

---

#### Dust nullifier set (`DustUtxoState.nullifiers`)

**Per-entry raw size:** 32 bytes (DustNullifier as Fr field element)

**Total size:** `32 × D_spend` bytes

**Growth dependency:** **Append-only; never shrinks.** Grows only with Dust spends.

---

#### Dust historical roots (two `TimeFilterMap` instances)

**Per-entry raw size:** 40 bytes (same structure as Zswap past_roots)

**Total size per tree:** `40 × (T_grace / T_block)` bytes

**Growth dependency:** **Bounded by Dust grace period; pruned at each block.** Much smaller window than Zswap. Example: T_grace = 10,800 s (3 h), T_block = 6 s → ~1,800 entries → **~72 KB per tree**, **~144 KB total**.

---

#### Dust generation tree and dedup set

**Per-leaf raw size (`DustGenerationInfo`):**
16 (value u128) + 32 (owner Fr) + 32 (nonce HashOutput) + 8 (dtime u64) = **88 bytes**

**Per-entry raw size (`DustGenerationUniquenessInfo`):**
16 (value u128) + 32 (owner Fr) + 32 (nonce HashOutput) = **80 bytes**

**Total size:** `(88 + 80) × D_gen` = **`168 × D_gen`** bytes

**Growth dependency:** **Append-only; never shrinks.** One entry pair per Night UTXO output where Dust generation was active. Note that the `dtime` field in tree entries is updated in-place when the backing Night UTXO is spent, so spending Night changes an existing leaf value rather than adding new entries.

---

#### Dust address delegation (`address_delegation`)

**Per-entry raw size:** 32 bytes (UserAddress) + 32 bytes (DustPublicKey/Fr) = **64 bytes**

**Total size:** `64 × R_active` bytes

**Growth dependency:** **Bounded by active registrations; can grow and shrink.** Entries are added on registration (`DustRegistration` with `Some(dust_address)`) and removed on deregistration (`None`). The table reflects only currently active Night→Dust delegations.

---

#### Dust night indices (`night_indices`)

**Per-entry raw size:** 32 bytes (InitialNonce/HashOutput) + 8 bytes (u64 tree index) = **40 bytes**

**Total size:** `40 × D_gen` bytes

**Growth dependency:** **Append-only; never shrinks.** One entry per registered Night output, retained indefinitely so that generation tree entries can be found and updated when the Night UTXO is later spent.

---

#### Replay protection (`ReplayProtectionState`)

**Per-intent-hash raw size:** 32 bytes (IntentHash/HashOutput)

**Total size:** `32 × TPS × I_tx × T_ttl` bytes

**Growth dependency:** **Bounded by TTL and throughput; pruned continuously.** The window is fixed at T_ttl; at higher TPS the window holds proportionally more hashes but the oldest are pruned. Example: 10 TPS, 1 intent/tx, T_ttl = 86,400 s → 32 × 10 × 86,400 ≈ **~27 MB**. At 500 TPS the same TTL requires ~1.4 GB, making TTL tuning a significant parameter for higher-throughput operation.

---

#### Contract state

**Per-contract overhead:** ~32 bytes (ContractAddress key) + small fixed fields (maintenance authority: ~100 bytes, balance map: 48 bytes per token type)

**`data` (ChargedState):** fully variable. The storage cost model bills per node in the reachability closure of the state root DAG. A contract with N charged keys of average size K bytes uses approximately `N × K` bytes of raw data plus MPT overhead.

**`operations` (verifier keys):** approximately 1–4 KB per entry point per contract.

**Growth dependency:** Proportional to **deployed contracts × their data footprint**. Contract data can grow and shrink as transactions execute. The overall contract state map grows as contracts are deployed and shrinks only if contracts are explicitly decommissioned (if supported). Verifier key storage is bounded per contract by the number of entry points.

---

#### Summary table

❓🤖 The per-entry byte sizes below are computed from field types; the growth characterisation is derived from the semantics of each sub-ledger.

| State component | Raw bytes / entry | Growth variable | Bounded? |
|---|---|---|---|
| Unshielded UTXO | 124 | U_live (live UTXOs) | Yes — entries removed on spend |
| Zswap commitment + dedup | ~80 | S_total (all shielded outputs ever) | No — append-only |
| Zswap nullifiers | 32 | S_spent (all shielded spends ever) | No — append-only |
| Zswap root history | 40 | T_ttl / T_block (entries) | Yes — TTL-pruned |
| Dust commitments | 32 | D_gen + D_spend | No — append-only |
| Dust nullifiers | 32 | D_spend | No — append-only |
| Dust root histories (×2) | 40 | T_grace / T_block (entries) | Yes — grace-period-pruned |
| Dust generation tree + set | 168 | D_gen | No — append-only |
| Dust address delegation | 64 | R_active (active registrations) | Yes — entries removed on deregistration |
| Dust night indices | 40 | D_gen | No — append-only |
| Replay protection | 32 | TPS × I_tx × T_ttl | Yes — TTL-pruned |
| Contract state | variable | C × data footprint | Partially — data can shrink, verifier keys cannot |

The three append-only unbounded structures — shielded commitments, shielded nullifiers, and Dust generation history — represent the primary long-term disk growth obligations for full nodes. At sustained 10 TPS with 50% shielded activity, the commitment tree alone grows at roughly 80 bytes × 5 outputs/s × 31.5 Ms/year ≈ **~12 GB/year** of raw leaf data before MPT overhead.

### Privacy boundary summary

| Data item | Stored on-chain | Visible to observers |
|---|---|---|
| Unshielded UTXO (value, owner, type) | Yes | **Yes** — fully clear |
| Shielded commitment hash | Yes | Opaque hash only |
| Shielded coin content (value, type, nonce) | No | **No** — wallet-local |
| Whether shielded coin is contract-owned | Yes | **Yes** — contract address in tree |
| Zswap nullifier hash | Yes | Opaque hash only |
| Dust commitment hash | Yes | Opaque field element |
| Dust UTXO content (value at spend time) | No | **No** — ZK proof only |
| Dust generation info (Night value, Dust pubkey) | Yes | **Yes** — fully clear |
| Night→Dust address delegation table | Yes | **Yes** — fully clear |
| Contract state (all fields) | Yes | **Yes** — fully clear |
| Intent hashes (replay protection) | Yes | **Yes** (TTL-pruned) |

The key asymmetry is that the Dust generation infrastructure is fully public — staking Night for Dust generation reveals the Night UTXO value and the associated Dust public key — while the actual spending of Dust (how much fee was paid, when) is shielded.

---

## Separation from Substrate and the Ledger Entry Points

**Claim under examination:** *"Midnight's ledger processing is well separated from the other Substrate pallets and more-or-less has a single entry point or point of contact."*

**Verdict: Substantially confirmed, with two nuances** — the separation is clean and total; the "single entry point" is accurate for user transactions but there are a small number of additional system-level entry points.

### Substrate dependency: zero

The `ledger` crate Cargo.toml has no dependency on `frame_support`, `frame_system`, `sp_runtime`, any `pallet-*` crate, or any other Substrate component. Its dependencies are exclusively internal Midnight crates (`coin-structure`, `zswap`, `base-crypto`, `storage`, `serialize`, `onchain-runtime`) plus standard Rust libraries (`tokio`, `sha2`, `serde`, `rayon`, `zeroize`). The ledger is pure Rust — it neither knows nor cares what blockchain framework is above it. Substrate is one possible host, but the ledger code is fully portable.

### The architectural seam: `StateReference<D>`

The ledger interacts with the runtime above it exclusively through a single trait:

```rust
pub trait StateReference<D: DB> {
    fn stateless_check(&self, check: impl FnOnce() -> Result<..>) -> Result<..>;
    fn param_check(&self, always: bool, check: impl FnOnce(&LedgerParameters) -> Result<..>) -> Result<..>;
    fn op_check(&self, contract: ContractAddress, entry_point: &EntryPointBuf,
                check: impl FnOnce(&ContractOperation) -> Result<..>) -> Result<..>;
    fn maintenance_check(&self, contract: ContractAddress,
                         check: impl FnOnce(&ContractMaintenanceAuthority) -> Result<..>) -> Result<..>;
    fn generationless_fee_availability_check(&self, parent_intent: &ErasedIntent<D>,
                         night_key: &VerifyingKey, check: impl FnOnce(u128) -> Result<..>) -> Result<..>;
    fn dust_spend_check(&self, ctime: Timestamp,
                        check: impl FnOnce(DustParameters, MerkleTreeDigest, MerkleTreeDigest) -> Result<..>) -> Result<..>;
    fn network_check(&self, network: &str) -> Result<..>;
    fn ref_state_hash(&self) -> ArenaHash<D::Hasher>;
}
```

A Substrate pallet (or any other host) provides a concrete `StateReference` implementation that wraps its own storage. The ledger uses this solely for read queries during transaction verification — it does not call into pallet extrinsics, emit Substrate events, or touch `frame_storage` directly. The ledger is entirely on the callee side of this boundary.

### Entry points for user transactions: `well_formed` and `apply`

There are two closely paired entry points for processing user transactions.

**Verification:**
```rust
impl<S, P, B, D> Transaction<S, P, B, D> {
    pub fn well_formed(
        &self,
        ref_state: &impl StateReference<D>,
        strictness: WellFormedStrictness,
        tblock: Timestamp,
    ) -> Result<VerifiedTransaction<D>, MalformedTransaction<D>>;
}
```

`well_formed` runs six sequential validation layers — stateless checks, disjoint inputs, sequencing, effects, Pedersen balance, and TTL — and returns an opaque `VerifiedTransaction<D>` on success. This type-level distinction prevents `apply` from being called on an unverified transaction; the type system enforces the ordering.

**Application:**
```rust
impl<D: DB> LedgerState<D> {
    pub fn apply(
        &self,
        tx: &VerifiedTransaction<D>,
        context: &TransactionContext<D>,
    ) -> (Self, TransactionResult<D>);
}
```

`apply` consumes a `VerifiedTransaction` and returns a new `LedgerState` plus per-segment results. It is the only way to mutate ledger state for a user transaction. The calling Substrate pallet writes the returned `LedgerState` back to its storage; no mutation happens inside the ledger itself.

### Additional entry points

Beyond `well_formed`/`apply`, there are three further entry points called by the block-processing layer:

```rust
// Governance / reward / reserve operations (not user transactions)
pub fn apply_system_tx(&self, tx: &SystemTransaction, tblock: Timestamp)
    -> Result<MaybeEvents<D>, SystemTransactionError>;

// Time-based state changes and fee-market adjustment after all txs in a block
pub fn post_block_update(&self, tblock: Timestamp,
    detailed_block_fullness: NormalizedCost, overall_block_fullness: FixedPoint)
    -> Result<Self, BlockLimitExceeded>;

// Verify NIGHT supply conservation invariant (testing / assertion use)
pub fn check_night_balance_invariant(&self) -> Result<(), InvariantViolation>;
```

There are also three `batch_apply_*` variants (`independant`, `all_or_nothing`, `until_first_failure`) on `LedgerState` for processing multiple pre-verified transactions at once. These are convenience wrappers over `apply`, not new entry points in a semantic sense.

### Summary

| Aspect | Finding |
|---|---|
| Substrate crate dependencies in `ledger/` | **Zero** |
| State supplied by host runtime | Via `StateReference<D>` trait — fully pluggable |
| User transaction verification | Single entry point: `Transaction::well_formed()` |
| User transaction application | Single entry point: `LedgerState::apply()` |
| Additional block-level entry points | 3: `apply_system_tx`, `post_block_update`, `check_night_balance_invariant` |
| Ledger mutability model | Immutable + return-new-state; pallet writes result to storage |
| Portability | Fully portable to any host runtime implementing `StateReference<D>` and `DB` |

The claim holds. The ledger is a self-contained domain library with zero framework coupling. The Substrate pallet that hosts it is a thin adapter: implement `StateReference`, call `well_formed`, call `apply`, write state back. From the pallet's perspective, the ledger is a black box with two ports.

### No structural notion of blocks

The ledger has no concept of block headers, block hashes, block height, transaction ordering within a block, or finality. All block structure is managed by Substrate. The ledger's model is a sequence of state transitions (`apply` calls) with a periodic boundary signal carrying two numeric inputs:

| Input | Function | Where it appears |
|---|---|---|
| `tblock: Timestamp` | Block time — used for TTL validation and Dust value decay | `well_formed`, `apply_system_tx` |
| `detailed_block_fullness: NormalizedCost`, `overall_block_fullness: FixedPoint` | Fullness metrics — used for fee-market parameter adjustment | `post_block_update` |

The host runtime (Substrate) aggregates fullness across the block and calls `post_block_update` once after all transactions are applied. The ledger receives the timestamp and fullness as plain scalars; it does not know what block produced them.

📐 **DESIGN:** This is architecturally significant for the NEARFall options. Running the ledger in a streaming or rollup context with a differently-defined block boundary requires only that `tblock` and fullness metrics be supplied on whatever cadence is appropriate. The ledger itself is unmodified. The minimal block coupling is a natural fit for a Layer-2 or rollup host that controls its own block production schedule independently of the Midnight L1.

---

## Transaction Processing Flow

Processing a single transaction proceeds in two sequential phases: **verification** (`well_formed`) followed by **application** (`apply`). The `VerifiedTransaction<D>` return type from `well_formed` is the only accepted input to `apply`, so the type system enforces the ordering — application of an unverified transaction is not expressible.

### Phase 1: Verification (`Transaction::well_formed`)

`well_formed` reads only from the immutable `StateReference` snapshot. It never mutates state. The checks run in this order:

1. **Per-offer checks** — the guaranteed Zswap offer and each fallible Zswap offer are individually validated (valid ZK proofs, commitments well-formed, nullifiers not already spent).
2. **Per-intent checks** — each intent (one per segment) is individually validated, including its unshielded offer, its contract actions (validated against `ref_state.contract`), its Dust actions (validated against `ref_state.dust` and `ref_state.utxo`), and its binding commitment.
3. **Disjoint check** — across all offers and intents, no input UTXO or nullifier appears more than once; no output commitment is duplicated.
4. **Sequencing check** — enforces causal ordering of contract calls across segments: if two segments call the same contract, one must be purely guaranteed and the other purely fallible; transitivity is enforced across the full call graph.
5. **Balance check** — per-token, per-segment: sum of inputs ≥ sum of outputs + fees for every token type in every segment.
6. **Pedersen check** — the `binding_commitment` fields across all intents collectively open to the declared net balance (homomorphic Pedersen consistency).
7. **Effects check** — a bijection between the nullifiers and commitments claimed in the ZK proofs and those actually present in the transaction structure; prevents proofs from claiming effects they don't produce.
8. **Weak TTL check** — the transaction's `ttl` timestamp is ≥ `tblock`; transaction has not expired.

`WellFormedStrictness` controls which of these checks are enforced. During transaction *construction* and *balancing*, signature and balance checks are relaxed so that a partially-built transaction can be validated incrementally. Full strictness (all checks active) applies at submission time.

### Phase 2: Application (`LedgerState::apply`)

`apply` iterates over segments in order. **Segment 0 is the guaranteed section**; all other segments are fallible. The failure semantics differ:

- **Segment 0 failure** → the entire transaction is rejected; no state mutation persists.
- **Segment *n* > 0 failure** → only segment *n* is rolled back; segment 0 and all previously committed segments remain.

The possible outcomes are `SucceedEntirely`, `FailEntirely`, and `SucceedPartially { segment_success: Map<u16, bool> }`.

#### Segment 0 — guaranteed, all-or-nothing

Mutations within segment 0 apply in this order:

| Step | Sub-ledger | Mutation |
|---:|---|---|
| 1 | Replay protection | Intent hashes written to the TTL-bounded replay-protection set |
| 2 | Zswap (guaranteed offer) | Coin commitments appended to `coin_coms` tree; nullifiers inserted into `nullifiers` set |
| 3 | Zswap (fallible offers) | **Pre-check only — no state change.** All fallible offers are validated against the post-step-2 state to confirm feasibility before any fallible segment executes |
| 4 | Unshielded / Night (guaranteed) | Input UTXOs removed from `utxo` set; output UTXOs inserted |
| 5 | Dust generation (guaranteed) | Night-to-Dust delegations and registrations updated |
| 6 | Contract actions (guaranteed) | Contract ledger state updated for each guaranteed action, in intent order |
| 7 | Dust spends | Dust nullifiers inserted; Dust commitments consumed |
| 8 | Dust registrations + fee settlement | Dust generation entries created; accumulated fees reconciled to zero |

The pre-check at step 3 is notable: it verifies all fallible Zswap offers against the state *as it stands after segment 0*, without applying them. This means a fallible offer that would have been valid at block start but is invalidated by the guaranteed offer (e.g., double-spending a coin) will fail at its own segment rather than causing a surprise later.

#### Segments *n* > 0 — fallible, per-segment rollback

Each fallible segment applies independently against the state accumulated so far:

| Step | Sub-ledger | Mutation |
|---:|---|---|
| 1 | Zswap (fallible offer for segment *n*) | Coin commitments appended; nullifiers inserted |
| 2 | Unshielded / Night (fallible offer for segment *n*) | Input UTXOs removed; output UTXOs inserted |
| 3 | Contract actions (fallible, segment *n*) | Contract ledger state updated for each fallible action |

No Dust operations occur in fallible segments; all fee settlement is anchored in segment 0.

### Summary diagram

```
Transaction
│
├─ well_formed(ref_state, tblock)          [reads only; 8 checks in order]
│   ├─ per-offer ZK proof validation
│   ├─ per-intent validation (contract + dust + unshielded)
│   ├─ disjoint, sequencing, balance, Pedersen, effects, TTL
│   └─ → VerifiedTransaction  (or MalformedTransaction error)
│
└─ LedgerState::apply(verified_tx, context)
    │
    ├─ Segment 0 (guaranteed — all-or-nothing)
    │   ├─ 1. replay protection
    │   ├─ 2. Zswap guaranteed (commitments + nullifiers)
    │   ├─ 3. Zswap fallible pre-check (no mutation)
    │   ├─ 4. Night UTXOs (guaranteed)
    │   ├─ 5. Dust generation (guaranteed)
    │   ├─ 6. contract actions (guaranteed)
    │   ├─ 7. Dust spends
    │   └─ 8. Dust registrations + fee settlement
    │
    ├─ Segment 1 (fallible — rollback on failure)
    │   ├─ 1. Zswap fallible
    │   ├─ 2. Night UTXOs (fallible)
    │   └─ 3. contract actions (fallible)
    │
    ├─ Segment 2 … (same pattern)
    │
    └─ → (LedgerState, TransactionResult)
```

### Fallible segments: design rationale and balance constraints

**Partial success is intentional.** `SucceedPartially { segment_success: Map<u16, bool> }` is a first-class outcome. A transaction in which segment 0 succeeds and segment 2 fails is valid and committed. This is not an edge case — it is the designed behaviour for multi-party and intent-based transactions.

**Typical single-user transactions use only segment 0.** A standard send, contract call, or fee payment has no need for fallible segments. Because segment 0 is all-or-nothing, it provides the same atomicity guarantee as a conventional blockchain transaction. Fallible segments are an extension mechanism layered on top.

**Why fallible segments exist — two stated reasons from the spec:**

1. *Frontrunning mitigation.* The spec notes: *"This has the added benefit that it prevents malicious 'frontrunning', as a user can simply use segment ID 1 to avoid being frontrun."* The claim requires careful interpretation.

   **Within a transaction, segment ordering is cryptographically locked.** Segment IDs are pre-images to the Zswap delta commitment hash (`hash_to_curve(token_type, segment_id)`) and are embedded in the ZK proof inputs for contract actions. Changing a segment ID invalidates both the ZK proofs and the intent's Pedersen/Fiat-Shamir binding commitment. An adversary without the private key cannot reconstruct valid proofs with different segment assignments — execution order is fixed at signing time.

   **Between transactions, block producers can order freely.** Midnight's AURA/GRANDPA/BEEFY consensus does not eliminate mempool-level frontrunning. A block producer can insert a transaction ahead of a user's.

   The useful property is subtler: a user whose sensitive operation (e.g., a DEX trade) is in a **fallible segment** can design it so that if a frontrunner changes the relevant contract state first, the user's segment **fails cleanly with no token loss** rather than executing at a worsened price. The ZK proof and contract interaction encode expected state; a frontrun that invalidates those conditions causes a clean rollback. This is the same protection as a DEX slippage tolerance — it does not prevent the frontrun, it prevents the user from being harmed by it. The spec's phrase "use segment ID 1" describes specifically a multi-party intent scenario (solver-bundled transactions) where the user's action is in a fallible segment so that a malicious solver cannot exploit segment 0 to manipulate the state the user's action sees.

   | Adversary capability | Possible without secrets? | Reason |
   |---|---|---|
   | Reorder segments within a transaction | No | Segment IDs in ZK proof pre-images; changing them invalidates proofs |
   | Add a segment to a signed transaction | No | Requires a valid proof and signature under the owner's key |
   | Remove a fallible segment from a signed transaction | No | Fiat-Shamir binding commitment covers all intents |
   | Reorder transactions relative to each other in the mempool | **Yes** | Block producer has free ordering; standard MEV applies |
   | Read Zswap coin amounts or private contract inputs | No | ZK proofs reveal nothing; ciphertexts are recipient-only |
   | Predict whether a fallible segment will succeed | Partially | Public contract state and public action inputs are visible, but private witnesses are not |

2. *Multi-party composition without cascade failure.* Different actors in a collaborative transaction occupy different segment IDs. If one actor's contract call reverts (e.g., insufficient liquidity in a DEX pool), only that actor's segment rolls back. The other actors' contributions remain committed. This enables intent-based and solver-based architectures where a solver may partially fulfil a batch of user intents in a single transaction, with each intent's success or failure recorded independently.

**How fallibility is reconciled with balance invariants.**

The naive concern is that if a fallible segment fails, its coins are neither consumed nor created, leaving the ledger unbalanced relative to what `well_formed` checked. The spec resolves this by requiring that **each segment balance independently**. The balance check in `well_formed` operates on a map keyed by `(TokenType, segment_id)`, not `TokenType` alone. Every `(token, segment)` pair must net to zero independently of every other.

This independence is cryptographically enforced in Zswap, not just asserted at validation time. The Zswap value commitment hash incorporates the segment ID as a pre-image:

```
value_commitment = Σ inputs − Σ outputs − Σ transients − Σ (hash_to_curve(token_type, segment) × delta)
```

Because `segment` is part of the hash base for delta commitments, a delta declared in segment 1 is homomorphically unmixable with any element in segment 2. A coin in segment 1 cannot offset a balance shortfall in segment 2, even in principle. The spec states directly: *"a transaction can be divided into independent segments, that are each balanced independently."*

The practical consequence: if segment *n* fails and is rolled back, the sub-ledger returns to exactly the state it had before that segment was applied. No other segment's balance is affected, because no cross-segment balance dependency can exist. The global token supply invariant holds regardless of which combination of fallible segments succeeds or fails.

**Fee settlement.** All Dust fee operations are anchored in segment 0. Fallible segments carry no Dust actions. This means fees are always fully settled or the entire transaction is rejected — there is no path to a partial execution that leaves fees unpaid.

---

## Intents and Segments

The terms *intent* and *segment* are closely related but not synonymous. Understanding their relationship is essential for reading the `StandardTransaction` structure correctly.

### Structural definition

Every intent in `StandardTransaction.intents: HashMap<u16, Intent<…>>` is keyed by a `u16` integer. This integer is the **segment ID** — the same value used as a key in `fallible_coins: HashMap<u16, ZswapOffer<…>>`. The link between an intent and its fallible Zswap offer is purely by matching map keys.

The non-obvious point is that **a single intent spans both execution phases**. It carries fields that execute in segment 0 (the guaranteed phase) *and* fields that execute in segment N (the fallible phase keyed by its segment ID):

| Field in `Intent<…>` | Execution phase | Where it runs |
|---|---|---|
| `guaranteed_unshielded_offer` | Guaranteed | Segment 0 — all-or-nothing |
| `dust_actions` | Guaranteed | Segment 0 — all-or-nothing |
| `actions` (contract calls, guaranteed part) | Guaranteed | Segment 0 — all-or-nothing |
| `fallible_unshielded_offer` | Fallible | Segment N — per-segment rollback |
| `actions` (contract calls, fallible part) | Fallible | Segment N — per-segment rollback |
| `fallible_coins[N]` (transaction-level) | Fallible | Segment N — alongside intent N’s fallible portion |

Segment 0 is not a separate intent. It is the **aggregate** of the guaranteed portions of *all* intents across the transaction, plus the transaction-level `guaranteed_coins` Zswap offer.

### Execution layout

```
StandardTransaction
│
├─ guaranteed_coins (ZswapOffer) ─────────────────────────────┬
│                                                              │
├─ intents[1]                                                  ▼
│   ├─ guaranteed_unshielded_offer ────────────────── SEGMENT 0 (guaranteed — all-or-nothing)
│   ├─ dust_actions ─────────────────────────────────
│   └─ actions (guaranteed part) ────────────────────
│
├─ intents[2]                                                  │ continues segment 0
│   ├─ guaranteed_unshielded_offer ──────────────────         │
│   ├─ dust_actions ─────────────────────────────────         │
│   └─ actions (guaranteed part) ─────────────────────────┘
│
├─ intents[1] (fallible part) ──────────────────── SEGMENT 1 (fallible — rollback on failure)
│   ├─ fallible_unshielded_offer
│   └─ actions (fallible part)
│
├─ fallible_coins[1] ────────────────────────────── SEGMENT 1 (same segment, separate offer)
│
├─ intents[2] (fallible part) ──────────────────── SEGMENT 2 (fallible — rollback on failure)
│   ├─ fallible_unshielded_offer
│   └─ actions (fallible part)
│
└─ fallible_coins[2] ────────────────────────────── SEGMENT 2 (same segment, separate offer)
```

Zswap shielded coin offers (`fallible_coins`) sit at the transaction level, not inside intents. Each `fallible_coins[N]` executes alongside `intents[N]`’s fallible fields in segment N.

### Common use cases

| Use case | Typical segment structure |
|---|---|
| Simple send / single-user contract call | Segment 0 only: guaranteed Night UTXO spend or shielded transfer; no fallible segments needed |
| DEX / AMM trade with slippage protection | Segment 0: Dust fee (guaranteed); Segment 1: swap intent (fallible — fails cleanly if price moved beyond tolerance) |
| Intent-based / solver-bundled transaction | Segment 0: fee + solver coordination (guaranteed); Segments 1+: each solver’s fill in a separate fallible segment |
| Multi-party collaborative transaction | Each party holds a distinct segment ID and signs their own intent; all parties agree on the full intent set off-chain before submission |
| Guaranteed update + contingent side-effect | Segment 0: unconditional state write (guaranteed); Segment 1: conditional operation that reverts without affecting segment 0 |

For the majority of wallets and DApp interactions, only segment 0 is populated. Fallible segments are an extension mechanism for advanced patterns — DEX slippage guards, intent bundling, and multi-party coordination — not a requirement for ordinary use.

### Why segment boundaries are cryptographically enforced

The segment ID appears as a pre-image in two independent cryptographic commitments, making cross-segment interference structurally impossible:

**1. Zswap delta commitments.** The Pedersen delta commitment hash is `hash_to_curve(token_type, segment_id)`. A coin declared in segment 1 is homomorphically unmixable with any element in segment 2. No imbalance in segment 1 can be offset by surplus in segment 2, even in principle. This is why per-segment balance independence holds without additional trust assumptions.

**2. Intent signatures.** Each Night UTXO spend is signed over `hash("midnight:hash-intent:" || segment_id || erased_intent)`. The segment ID is a pre-image to the signature. No one without the signing key can reassign an intent to a different segment.

Together, when a fallible segment fails and is rolled back, the state returns exactly to where it stood before that segment applied. No other segment’s balance is affected; no substitution of one segment’s assets for another’s is possible.

---

## Multi-Party Transaction Construction

Two questions arise naturally from the segment model: can multiple parties each contribute a segment, and can one party leave the transaction "open" for another to complete?

### How signing works: per-intent, not per-transaction

There is no single transaction-level signature. Authorization is distributed across two independent mechanisms:

- **Night UTXO spends**: each input in an `UnshieldedOffer` carries one Schnorr signature per spending key. The signed data is `hash("midnight:hash-intent:" || segment_id || erased_intent)` — it covers that specific intent (the segment ID plus the erasure of all proof and signature fields), but **not** any other intent in the same transaction.
- **Zswap coin spends**: authorized by ZK proofs, one per input coin. Each proof is self-contained to its offer.
- **Dust spends**: similarly ZK-proof-authorized within their own intent.

Because signatures are scoped to a single intent, **adding a new intent to a transaction does not invalidate the signatures on existing intents**. There is no top-level transaction signature that would need to be remade.

### Transaction-level binding randomness: the coordination obstacle

The transaction does carry one global field that is not per-intent:

```rust
pub binding_randomness: PedersenRandomness  // sum of all Zswap offer + intent randomnesses
```

This is recomputed as:

```rust
pub fn recompute_binding_randomness(&mut self) {
    self.binding_randomness =
        guaranteed_coins.binding_randomness()
        + fallible_coins.values().fold(0, |acc, o| acc + o.binding_randomness())
        + intents.values().fold(0, |acc, i| acc + i.binding_randomness());
}
```

It is the arithmetic sum of every Zswap offer's and every intent's Pedersen randomness. This is not itself signed, but it is used in the overall Pedersen balance check. Because it is a simple sum, each party's contribution to it is independent — but someone must compute and hold the running total. In a trust-free multi-party setting this requires an off-chain coordination round (or MPC) to aggregate without any single party learning the others' randomness.

### Replay protection: all intents must be known at submission

A more fundamental obstacle to "open" transactions is replay protection. During segment 0 application, the intent hashes for the entire transaction are written to the replay-protection set. All intents must therefore be finalised — with their hashes determined — before the transaction is submitted. A party cannot add a segment after submission; the hash of their intent would not be in the replay-protection set and the transaction would be invalid on re-submission.

### Question 1: Can several parties each contribute a signed segment?

**Architecturally yes, with off-chain coordination required.** Because signatures are per-intent and do not cross segment boundaries, each party can sign their own intent independently. The steps that require coordination are:

1. All parties must agree on the final set of intents (so that intent hashes for replay protection are known) before anyone submits.
2. All parties must share their Pedersen randomness contributions so the transaction-level `binding_randomness` can be assembled correctly.
3. The Zswap Pedersen check verifies the combined balance across all segments; each party's randomness must be incorporated before the proof is finalised.

Step 2 can be done non-interactively if parties exchange Pedersen commitments to their randomness and the final sum is computed by a coordinator — or interactively via a threshold scheme. There is no built-in protocol for this in the ledger spec; it would be an application-layer concern.

### Question 2: Can one party provide DUST in segment 0 and leave the rest open for another party?

**No, not in a single atomic workflow.** Even though Party A's signature over segment 0 is not invalidated by Party B adding segment 1, three constraints prevent "open" construction:

1. **Replay protection requires all intent hashes at submission time.** Party B's intent hash must be included when the transaction is submitted; it cannot be added after the fact.
2. **The binding randomness must incorporate Party B's contribution** before the Pedersen check passes.
3. **The Zswap fallible pre-check in segment 0** (step 3 of the guaranteed section) validates all fallible Zswap offers against the post-segment-0 state. This check runs at application time, not submission time, so it does not block late addition — but it does mean Party B's Zswap offers must be well-formed relative to the state at the time the transaction is applied, not at the time it was constructed.

The practical model is therefore: both parties agree on the full transaction structure off-chain, Party A contributes and signs segment 0, Party B contributes and signs segment 1, a coordinator assembles the final `binding_randomness`, and the complete transaction is submitted as a unit. This is a standard two-round multi-party signing protocol with a trusted (or MPC-replaced) coordinator for the binding randomness step.

### Summary

| Property | Finding |
|---|---|
| Signature scope | Per-intent (segment ID + erased intent); no transaction-level signature |
| Adding a segment invalidates other intents' signatures? | No |
| Binding randomness | Transaction-global sum of all components; requires coordination to assemble |
| Replay protection | All intent hashes must be final before submission |
| Native multi-party protocol | None in the ledger spec; application-layer concern |
| "Open" transaction for late-added segments | Not possible in current design |
| Multi-party construction (all parties agree upfront, then each signs their intent) | Architecturally feasible; requires one coordination round for binding randomness |

---

## Proof Time and State Growth

### Does Dust/Zswap proof time scale with historical UTXOs?

**No. Proof time is constant, not logarithmic.**

The Midnight Dust circuit (and Zswap spend circuit) must include a Merkle inclusion proof as a ZK witness. That proof has exactly `depth` hashes — 32 for both the Dust commitment tree (`DUST_COMMITMENT_TREE_DEPTH: u8 = 32`) and the Zswap coin commitment tree. The ZK circuit is compiled against a fixed circuit topology; the number of constraints does not change as the tree fills. Regardless of whether the tree contains 1 leaf or 2³² leaves, the prover executes the same fixed circuit over 32 hash gates.

| Quantity | Scales with history? | Reason |
|---|---|---|
| ZK proof generation time (spend) | **No** | Fixed-depth tree → fixed-size circuit |
| Merkle path length | **No** | Always exactly `depth` = 32 sibling hashes |
| Prover memory per proof | **No** | Circuit is statically compiled |
| Node state storage | **Yes — unbounded** | Nullifiers never deleted; commitment tree never pruned |
| Wallet scan time (trial decryption) | **Yes — O(S_total)** | Must attempt decryption of every historical output |

The ~0.6 s figure measured for Dust proof generation on an x86-64 laptop reflects the cost of one PLONK (or PLONK-like) proof over a fixed circuit on a BLS12-381 curve. That number will not change as the chain accumulates history.

### What does scale with history?

**1. Wallet scanning (trial decryption).** To discover its own UTXOs a wallet must trial-decrypt every output in the chain. This is an O(S_total) operation — linear in the total number of historical shielded outputs. At a modest 10 TPS with 50% shielded activity:

- Outputs/year ≈ 10 × 0.5 × 31.5 M s ≈ 157 M outputs/year
- Each trial decryption is a Poseidon hash (~microseconds); scanning a year of history takes on the order of minutes to hours depending on parallelism and index structure.

This is already a documented UX pain point on ZCash, and Midnight wallets will face the same issue at scale. The mitigation used by ZCash is *compact blocks* (ZIP-307): transmit only a 43-byte "compact output" (note commitment + ephemeral key) per shielded output, rather than the full transaction, so scanning bandwidth is reduced.

**2. Full-node state size.** The three unbounded append-only structures documented in the persistent storage section (Zswap commitment tree, Zswap nullifier set, Dust generation tree) mean full-node disk usage grows without bound. The nullifier set is the dominant concern: it is a flat hash-set with no TTL, and entries are 32 bytes each. At the same 10 TPS / 50% shielded rate:

- Nullifier set growth ≈ 157 M × 32 bytes/year ≈ 5 GB/year of raw leaf data
- With the MPT 2–3× storage multiplier, full nodes accumulate ~10–15 GB/year for nullifiers alone.

### ZCash's real-world experience

ZCash is the closest analogue: same Zerocash commitment/nullifier paradigm, same fixed-depth Merkle tree.

| ZCash tree | Depth | Capacity |
|---|---|---|
| Sprout (original) | 29 | 2²⁹ ≈ 536 M leaves |
| Sapling (2018) | 32 | 2³² ≈ 4.3 B leaves |
| Orchard (2021, Halo2) | 32 | 2³² ≈ 4.3 B leaves |

**Documented problems:**

- **Wallet rescan slowdown.** GitHub issue [zcash/zcash#6052](https://github.com/zcash/zcash/issues/6052) tracks the problem where full rescans from genesis take hours to days. As of 2023–2024 with several years of history, the default zcashd rescan has been effectively unusable without server-side assistance.
- **June 2022 shielded activity spike.** A large burst of shielded transactions (driven by automated memos and airdrop activity) caused a noticeable jump in zcashd RAM usage and sync times. ZCash documented ≥4 GB RAM required for zcashd during heavy shielded activity.
- **wallet.dat bloat.** Wallet files tracking large note histories grew to 150 MB+; users reported 30–60 minute startup times.
- **Light client dependency on a trusted server.** The ZCash compact block / light client protocol (Lightwalletd, ZIP-307) reduces scan bandwidth, but the light client must still download and trial-decrypt all compact outputs from genesis if rescanning from scratch; it delegates the full note ciphertext retrieval to a server, introducing a trusted intermediary.

**Mitigations shipped by ZCash:**

- *Compact blocks (ZIP-307)*: 43-byte-per-output scan data transmitted by `lightwalletd`, reducing bandwidth by ~100× versus full blocks.
- *Wallet birthday / checkpoint*: wallet remembers a block height "birthday" and only scans from there, avoiding genesis-to-now rescans after wallet recovery if the birthday is known.
- *Server-assisted spending (zcashd 5.6.0+)*: the full node can outsource note witness retrieval to a Lightwalletd server during spending, avoiding a full local scan.
- *State expiry proposals*: several EIPs/ZIPs have proposed expiring old shielded notes after an inactivity period, but none have been adopted because discarding unspent commitments breaks the soundness guarantee (a spent commitment that disappears from state could be re-inserted, breaking double-spend prevention).

### ZCash Tachyon — the fundamental solution

The [ZCash Tachyon project](https://electriccoin.co/blog/the-zcash-2-0-tachyon-era-our-updated-technology-roadmap/) (announced 2024, part of "Zcash 2.0") proposes eliminating the unbounded nullifier set entirely via **proof-carrying data (PCD)**:

- Each spend produces a PCD proof that (a) the commitment existed in some prior state and (b) the note has not been spent in the proof's ancestry chain.
- The chain state reduces to a single accumulator (a constant-size cryptographic commitment to the entire history), rather than an explicit nullifier hash-set.
- Full nodes only store the current accumulator; historical nullifiers are implicit in the proof chain.

This is a fundamental architectural rethink rather than an incremental optimisation. It removes the O(S_total) state-storage problem but adds recursive proof composition overhead per transaction. Tachyon requires a new proof system (Halo2 recursive composition, already used in Orchard) and a hard fork.

### Implications for Midnight

Midnight currently has the same structural exposure as ZCash:

| Concern | Midnight today | Mitigated? |
|---|---|---|
| Proof generation time | Constant (fixed-depth trees) | Not a concern |
| Wallet scan time | O(S_total) — grows linearly | Not yet (no compact block spec seen) |
| Full-node state | Unbounded (nullifiers + commitments never pruned) | Not yet |
| Commitment tree exhaustion (2³² = 4.3 B leaves) | Theoretical; ~1,360 years at 10 TPS / 50% shielded | Not a near-term concern |

The near-term risk for Midnight is wallet scan time and full-node storage growth, not proof generation time. If Midnight targets 500+ TPS with significant shielded activity, these concerns become acute within years rather than decades. A compact-output scan protocol and/or a Tachyon-style PCD accumulator would be the architectural answers.

---

## Wallet Recovery

This section answers: after deleting and restoring a Midnight wallet from seed, what private data can the wallet recover from the ledger, and what is permanently lost?

### Key derivation is deterministic

All Midnight key material is deterministically derived from a 32-byte seed (`zswap/src/keys.rs`):

```rust
// Domain-separated, deterministic
fn derive_coin_secret_key(seed: &Seed) -> coin::SecretKey   { /* "midnight:csk" */ }
fn derive_encryption_secret_key(seed: &Seed) -> encryption::SecretKey { /* "midnight:esk" */ }
```

The spending key (`coin::SecretKey`) authorises note spends. The encryption key (`encryption::SecretKey`) decrypts received outputs. Both are stable across wallet restores from the same seed, which is the foundation for all recovery.

### Night (Unshielded) sub-ledger — fully recoverable

Night UTXOs are public state. The wallet re-derives its Night verifying key → Night address (`Hash<VerifyingKey>`) from seed and scans the public unshielded UTXO set directly. All current balances and the public history of every Night transaction the wallet participated in are immediately available, without even a shielded scan.

### Zswap (Shielded) sub-ledger — asymmetric recovery

**Received coins: fully recoverable.**
The `encryption::SecretKey` derived from seed is the incoming viewing key. The wallet scans every historical `Output` on the chain, trial-decrypts its `CoinCiphertext` (6 BLS12-381 field elements, ECDH-encrypted to the recipient's public key), and recovers the full `CoinInfo` — nonce (ρ), token type, and value — for every output addressed to this wallet. Whether the note has since been spent is determined by checking the nullifier set.

**Sent coins: permanently lost.**
Midnight Zswap has **no outgoing ciphertext** and **no outgoing viewing key (OVK)**, unlike ZCash Sapling which records a `out_ciphertext` that allows the sender to recover their own sent transactions. In Midnight, each output carries a single ciphertext encrypted to the recipient's public key only. Furthermore, the note nonce ρ is chosen uniformly at random per output (`rng.gen()`), not derived deterministically. The upshot: once a wallet is deleted, there is no path — not from seed, not from chain data — to recover the amount sent, the asset type of sent outputs, or any other details of transactions where this wallet was the sender.

**Memo fields: N/A.**
The encrypted payload is exactly three field elements (nonce, type, value). There is no memo field in Midnight Zswap. Contrast with ZCash Sapling's 512-byte encrypted memo. Memos are therefore neither present nor recoverable.

### Dust sub-ledger — recoverable (with a caveat)

Dust key derivation is also seeded from the wallet seed (producing `DustSecretKey = Fr` and `DustPublicKey = Poseidon(DustSecretKey)`). The Dust generation infrastructure is entirely public on-chain:

- `DustGenerationState.address_delegation` maps Night addresses → Dust public keys (public)
- `DustGenerationState.generating_tree` contains `DustGenerationInfo` per Night UTXO (public)

A restored wallet re-derives its Dust public key and scans `address_delegation` and `generating_tree` to find all Night UTXOs that delegated to it. Dust commitments are deterministically computable from the `InitialNonce` (itself derived from the originating Night UTXO's `IntentHash`), the sequence number, and the `DustSecretKey`. A restored wallet can recompute expected commitment values and check them against the chain.

**Caveat:** The Dust nonce contains an `Fr` component in `field::Hash<(InitialNonce, u32, Fr)>`. If this `Fr` is a further Poseidon derivation of the secret key (likely), recovery is fully deterministic. If it were random, Dust coins would not be recoverable. The spec suggests deterministic derivation, but this should be verified against the actual Compact circuit constraints before making a strong claim.

### Local wallet state — permanently lost

The following is stored only in the local wallet database and is not recoverable from any on-chain data:

- **Wallet birthday / sync checkpoint.** The block height at which the wallet was created. Without it, a restored wallet must scan from genesis — potentially hours to days at current chain size, growing to days or weeks over years.
- **Sent Zswap transaction history.** All records of amounts sent, asset types, and recipients are lost. Only the fact that a nullifier appeared on-chain (implying *some* spend occurred) remains. Totalling a historical "outgoing" balance is impossible.
- **Address book and contact labels.** These are entirely local metadata.
- **Wallet-internal annotations.** Any user notes, transaction labels, or custom metadata attached to coins or operations.
- **Pending / partially constructed transactions.** Unsigned transactions and in-progress operations are ephemeral and never on-chain.

### Summary table

| Data item | Where stored | Recoverable from seed + chain scan? | Permanently lost on wallet delete? |
|---|---|---|---|
| Night address (unshielded) | Derived from seed | Yes | No |
| Night UTXO balance | Public on-chain | Yes | No |
| Night TX history (received) | Public on-chain | Yes | No |
| Night TX history (sent) | Public on-chain | Yes (Night is fully public) | No |
| Zswap spending key | Derived from seed | Yes | No |
| Zswap encryption (viewing) key | Derived from seed | Yes | No |
| Zswap received coin details (value, type) | Encrypted on-chain | Yes — trial decrypt with viewing key | No |
| Zswap received coin memo | Not present (no memo field) | N/A | N/A |
| **Zswap sent coin details (value, type, recipient)** | **NOT on-chain (recipient ciphertext only)** | **NO** | **Yes — permanently lost** |
| Dust public key | Derived from seed | Yes | No |
| Dust generation history | Public on-chain | Yes — fully public | No |
| Dust UTXO balance | Derivable from chain + secret key | Yes (assuming deterministic nonce) | No |
| Wallet birthday / sync checkpoint | Local DB only | No | Yes — forces genesis rescan |
| Address book / contact labels | Local DB only | No | Yes |
| Sent-transaction annotations | Local DB only | No | Yes |
| Pending / unsigned transactions | Local DB only | No | Yes |

### Architectural contrast with ZCash

ZCash Sapling introduced an **Outgoing Viewing Key (OVK)** for exactly this reason: each output includes an `out_ciphertext` encrypted to the sender's OVK, allowing wallet restore to recover full sent-transaction history. Midnight Zswap omits this mechanism entirely. The result is a stronger privacy property (senders cannot be compelled to reveal sent amounts even if they surrender their seed) but an irreversible loss of sent-transaction auditability on wallet restore.

If sent-transaction history matters to users or compliance requirements, the mitigation must happen at the application layer — e.g., wallets that encrypt and back up a local transaction log, or DApp-layer transaction indexing keyed to the user's public identity.

---

## Address Lookup and Explorer Visibility

Block explorers for account-model chains (Ethereum, Cardano) treat addresses as first-class indexes: every transaction records a `from` and `to`, so address history is a natural query. Midnight's three-sub-ledger design makes this substantially more complex, with different answers for each sub-ledger.

### Night (Unshielded) — data is public, but not address-indexed

Each Night UTXO contains a public `owner: NightAddress = Hash<VerifyingKey>` field. The data is on-chain in cleartext. However, the UTXO set is keyed by UTXO content hash (the UTXO ID), not by owner. Retrieving all UTXOs for a given address requires a full scan of the UTXO map, or a secondary inverted index built by the explorer. If the explorer does not maintain that index, address lookup is absent — not because the data is private, but because it is not indexed. This is a tooling gap, not an architectural privacy property. A motivated indexer can construct address history by scanning all blocks.

### Zswap (Shielded) — address lookup is cryptographically impossible

The public fields on a Zswap `Output` are:

- `coin_com: Commitment` — Pedersen hash of the coin contents
- `value_commitment` — blinded Pedersen commitment to value
- `contract_address: Option<ContractAddress>` — present only for contract outputs
- `proof`

None of these reveal the recipient address. The `CoinCiphertext` is ECDH-encrypted to the recipient's public key; without the wallet's `encryption::SecretKey`, there is no way to determine which commitments belong to which address. Even knowing a user's Zswap public key, an external observer cannot identify any of their outputs in the commitment tree. Address-level history for shielded outputs is ruled out by the Zerocash cryptographic model, not by a missing feature in the explorer.

### Dust — generation history is public, spending history is shielded

The Dust generation infrastructure is fully public on-chain:

- `DustGenerationState.address_delegation`: Night address → Dust public key (cleartext map)
- `DustGenerationState.generating_tree`: per-Night-UTXO leaf containing Dust public key, Night value, and timing

An observer who knows a Dust public key *can* look up all Night UTXOs that ever registered for Dust generation under that key, and the amounts involved. The Night address that funded each registration is also public. This is the most privacy-revealing link in the Dust model.

Dust *spending* is shielded: Dust commitments and nullifiers follow the same Zerocash pattern as Zswap, so the timing and frequency of fee payments are not attributable to any address.

### Summary table

| Sub-ledger | Current balance visible? | Full address history visible? | Mechanism |
|---|---|---|---|
| Night (unshielded) | Yes — if explorer indexes by owner | Yes — if explorer indexes by owner; raw data is on-chain | Secondary index over public UTXO map |
| Zswap (shielded) | No | No | Cryptographically impossible without viewing key |
| Dust generation | Yes — public on-chain | Yes — public on-chain | `address_delegation` + `generating_tree` are cleartext |
| Dust spending | No | No | Shielded commitments/nullifiers; no address revealed |

### Why the Midnight Explorer lacks address lookup

The Midnight Explorer shows blocks, transactions (by hash), individual commitments, and nullifiers — block-level and transaction-level views rather than address-level views. This is consistent with ZCash explorers (e.g., zcashblockexplorer.com), which likewise cannot attribute shielded outputs to addresses.

For 2/3 of the ledger (Zswap spending + Dust spending), address lookup is architecturally impossible. For Night UTXOs, it would be implementable via a block-scanning indexer, but providing it prominently would be at odds with the chain's privacy positioning.

**Practical implication for developers:** "Show me the history of this address" is only possible for Night addresses, and only by building a custom indexer over block history. For shielded history, the user must provide their `encryption::SecretKey` (incoming viewing key). There is no chain-native address index for shielded activity.

---

## Sources

### General Sources

- [midnight-ledger — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger)

### Specification Sources

- [spec/intents-transactions.md — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/intents-transactions.md)
- [spec/night.md — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/night.md)
- [spec/zswap.md — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/zswap.md)
- [spec/dust.md — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/dust.md)
- [spec/storage-io-cost-modeling.md — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/storage-io-cost-modeling.md)
- [spec/contracts.md — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/contracts.md)

### Implementation Sources

- [ledger/src/structure.rs — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/src/structure.rs)
- [ledger/src/dust.rs — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/src/dust.rs)
- [zswap/src/structure.rs — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/zswap/src/structure.rs)
- [zswap/src/ledger.rs — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/zswap/src/ledger.rs)
- [zswap/src/local.rs — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/zswap/src/local.rs)
- [coin-structure/src/coin.rs — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/coin-structure/src/coin.rs)
- [storage-core/src/db.rs — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/storage-core/src/db.rs)
- [storage/src/storage.rs — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/storage/src/storage.rs)

- [zswap/src/keys.rs — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/zswap/src/keys.rs)
- [ledger/src/lib.rs — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/src/lib.rs)
- [ledger/src/semantics.rs — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/src/semantics.rs)
- [ledger/src/verify.rs — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/src/verify.rs)
- [ledger/Cargo.toml — midnightntwrk/midnight-ledger (GitHub)](https://github.com/midnightntwrk/midnight-ledger/blob/main/ledger/Cargo.toml)

### ZCash / State Growth Sources

- [zcash/zcash #6052: Wallet rescan slowdown — GitHub](https://github.com/zcash/zcash/issues/6052)
- [ZIP-307: Compact Block Filters — ZCash Improvement Proposals](https://zips.z.cash/zip-0307)
- [The Zcash 2.0 "Tachyon Era" — Electric Coin Co. blog](https://electriccoin.co/blog/the-zcash-2-0-tachyon-era-our-updated-technology-roadmap/)
- [Zcash Sapling upgrade overview (note commitment tree depth) — ZCash documentation](https://z.cash/upgrade/sapling/)
- [Zcash Orchard (Halo2, depth-32 tree) — ZCash documentation](https://z.cash/upgrade/nu5/)
