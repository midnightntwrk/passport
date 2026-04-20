# 👱🤖 Design Proposal: TEE Device Key Registration for Midnight

**Date:** 2026-04-08
**Status:** Tier 1 (stub PoC) implemented — see `experiments/local-tee-poc`
**Based on:** [`assessments/tee-vs-zk.md`](../assessments/tee-vs-zk.md) §8

---

## Problem Statement

Midnight's proof server is computationally intensive and cannot run inside a mobile device's secure enclave. Mobile users either run an expensive local prover or delegate to a remote server they must trust. Neither path supports the goal of trustless mobile participation.

A further goal: allow Midnight contracts to accept TEE-attested computation as an alternative to ZK proofs, without requiring any changes to the Midnight validator or consensus layer.

---

## Proposed Design

### Core Idea

Separate the expensive work (verifying a TEE attestation certificate chain) from the cheap work (verifying a signature). Verify the certificate chain once at device registration via an off-chain oracle; thereafter, the Compact contract only performs standard signature verification.

A **dual-path contract interface** accepts either a ZK proof or a TEE device signature, ensuring the ZK path remains available as a fallback if the device is lost.

---

## Components

### 1. Enclave Code Hash Registry (global Compact contract)

A governance-controlled registry mapping enclave code hashes to their approval status.

```
contract EnclaveRegistry {
  // private state: map from enclave_code_hash → ApprovalRecord
  // public state: governance address, version

  fn register_enclave(code_hash: Hash, audit_reference: Text) // governance only
  fn revoke_enclave(code_hash: Hash)                          // governance only
  fn is_accepted(code_hash: Hash) -> Bool                     // public read
}
```

Governance: a multisig or on-chain DAO vote approves enclave code hashes after an independent security audit. This is the analogue of a ZK circuit's verifying key — it certifies that the enclave code is correct and unmodified.

### 2. Device Key Registry (per-user Compact contract)

Each user maintains a personal registry of their registered device keys, held in **private Compact state** so that observers cannot link device identities to the user's account.

```
contract DeviceKeyRegistry {
  // private state: map from device_id → DeviceRecord {
  //   public_key: BLS12381PublicKey,
  //   enclave_code_hash: Hash,
  //   registered_at: BlockHeight,
  //   active: Bool
  // }

  fn register_device(
    device_id: DeviceId,
    public_key: BLS12381PublicKey,
    enclave_code_hash: Hash,
    oracle_attestation: OracleAttestation   // oracle's signed confirmation
  )

  fn revoke_device(device_id: DeviceId)

  fn verify_device_signature(
    device_id: DeviceId,
    message: Bytes,
    signature: BLS12381Signature
  ) -> Bool   // verifies signature AND checks device is active AND enclave hash is accepted
}
```

### 3. Registration Oracle

An off-chain service that bridges the TEE attestation certificate chain to an on-chain Compact contract call.

**Oracle responsibilities:**
1. Receive a raw TEE attestation from the user's device.
2. Verify the certificate chain: hardware root → firmware measurement → enclave code hash + device public key.
3. Confirm the enclave code hash is in the `EnclaveRegistry`.
4. Sign an `OracleAttestation` struct: `(user_account, device_public_key, enclave_code_hash, timestamp)`.
5. Return the signed `OracleAttestation` to the user for submission to their `DeviceKeyRegistry`.

The oracle never submits the transaction itself — the user submits it, keeping the oracle stateless and reducing its authority. The oracle's signature is verifiable inside the Compact circuit.

**Trust mitigation:** Require M-of-N independent oracles to each produce a signature; the `register_device` function requires a threshold of oracle signatures. This distributes registration trust across multiple operators.

### 4. Application Contract (dual-path interface)

> ⚠️ **Compact API note.** `verify_zk_proof` does **not** exist in Compact. Proof verification is handled exclusively by the Midnight validator (`pallet-kachina`) as part of accepting the transaction — it is never called from within a contract. The two paths below are therefore **two separate Compact circuits**, each of which is a distinct entry point to the contract. The validator verifies the ZK proof for whichever circuit is called; the circuit body only needs to verify the non-ZK authorisation (device signature or recovery secret).

Any Compact contract that wishes to accept TEE-attested computation alongside a ZK-provable fallback exposes two circuits rather than one:

```
contract MyApp {
  // private state: registry reference, stored_recovery_commitment

  // TEE path — verifies a device signature in-circuit using EC operations
  // No hardware trust is assumed beyond the registered device
  export circuit execute_tee(action: Action, device_sig: Sig): [] {
    key ← registry.get_key(user_account)        // from private Compact state
    verify_device_sig(key, device_sig, action)  // EC check in-circuit (ecMulGenerator / ecAdd)
    apply_action(action)
  }

  // Recovery path — verifies a recovery secret in-circuit
  // Available from seed material; no device or oracle required
  export circuit execute_recovery(action: Action, recovery_secret: Field): [] {
    assert(persistentHash(recovery_secret) == stored_recovery_commitment)
    apply_action(action)
  }
}
```

The two circuits are independently sufficient. A user with a registered device calls `execute_tee`; a user who loses their device calls `execute_recovery` using a recovery secret derived from their seed phrase. The validator generates a ZK proof for whichever circuit is called; the circuit body enforces only the non-ZK check.

---

## Registration Flow

```
┌─────────────┐        ┌────────────┐        ┌───────────────────┐        ┌────────────────────┐
│ Mobile TEE  │        │   Oracle   │        │  EnclaveRegistry  │        │ DeviceKeyRegistry  │
└──────┬──────┘        └─────┬──────┘        └────────┬──────────┘        └──────────┬─────────┘
       │                     │                        │                               │
       │ generate BLS key     │                        │                               │
       │ inside enclave       │                        │                               │
       │                     │                        │                               │
       │ produce attestation  │                        │                               │
       │ (code_hash, pub_key, │                        │                               │
       │  hw_signature)       │                        │                               │
       │────────────────────▶│                        │                               │
       │                     │ verify certificate     │                               │
       │                     │ chain                  │                               │
       │                     │ check code_hash ──────▶│                               │
       │                     │                        │ is_accepted? ✅               │
       │                     │◀───────────────────────│                               │
       │                     │ sign OracleAttestation  │                               │
       │◀────────────────────│                        │                               │
       │                     │                        │                               │
       │ submit register_device(oracle_attestation) ──────────────────────────────────▶│
       │                     │                        │   verify oracle sig           │
       │                     │                        │   store (pub_key, code_hash)  │
       │                     │                        │◀──────────────────────────────│
```

---

## Transaction Flow (TEE path)

```
┌─────────────┐        ┌────────────────────┐        ┌─────────────┐
│ Mobile TEE  │        │ DeviceKeyRegistry  │        │   MyApp     │
└──────┬──────┘        └──────────┬─────────┘        └──────┬──────┘
       │                          │                          │
       │ compute action inside    │                          │
       │ enclave                  │                          │
       │ sign(action.encode())    │                          │
       │                          │                          │
       │ submit execute(action, device_id, signature) ──────▶│
       │                          │                          │
       │                          │◀── verify_device_sig ───│
       │                          │    check active          │
       │                          │    check code_hash ✅    │
       │                          │    verify signature ✅   │
       │                          │──────────────────────────▶
       │                          │                  apply action
```

---

## Transaction Flow (ZK fallback — device lost)

```
┌──────────────┐        ┌───────────────────────────────────────────┐
│ User (any    │        │   MyApp / Midnight validator               │
│ device /     │        │                                           │
│ proof server)│        │                                           │
└──────┬───────┘        └──────┬────────────────────────────────────┘
       │                       │
       │ generate ZK proof      │
       │ of correct computation │
       │                       │
       │ submit execute_recovery(action, recovery_secret) ──▶│
       │                       │  validator verifies ZK proof ✅
       │                       │  circuit checks: persistentHash(recovery_secret)
       │                       │                  == stored_recovery_commitment ✅
       │                       │  apply action
```

No device registration involved. No oracle involved. Trust is purely mathematical.
`verify_zk_proof` is not a Compact function — the validator handles proof verification automatically for every circuit call.

---

## Trust Model

| Stage | Trusted party | Trust type | Mitigation |
|---|---|---|---|
| Hardware manufacture | Chip manufacturer (Intel, AMD, ARM, Apple) | Hardware supply chain | Multi-vendor policy; independent hardware audits |
| Firmware measurement | Firmware supply chain | Firmware / software | Open-source enclave code; reproducible builds |
| Enclave code approval | Governance body (multisig / DAO) | Institutional | Public enclave code audit; on-chain governance vote |
| Registration oracle | Oracle operator(s) | Operational | M-of-N threshold of independent oracles required |
| Key generation | TEE hardware | TEE guarantee | Attested by same hardware root at registration |
| Device key registry contract | Compact circuit | Mathematical | ZK proof of contract execution |
| On-chain signature verification | BLS12-381 discrete log | Mathematical | Same as all Midnight ZK operations |
| **ZK fallback path** | **None beyond BLS12-381 / KZG** | **Mathematical only** | Same as all Midnight ZK operations |

The ZK fallback path carries no hardware trust and no oracle trust. It is the trust floor of the system — always available, independent of TEE infrastructure.

---

## Key Type Recommendation

**Preferred: BLS12-381** — native to Midnight's circuit; no foreign-field arithmetic for signature verification; requires software-layer BLS key generation inside the TEE.

**Acceptable fallback: secp256k1 or Ed25519** — foreign-field arithmetic required per transaction; moderate cost; leverage existing infrastructure from Midnight's chain abstraction work.

**Avoid: P-256** — Apple Secure Enclave's native curve; expensive foreign-field arithmetic; no existing Midnight tooling. If P-256 is the only option (e.g., strict iOS deployment), consider verifying only at registration (oracle path) and deriving a BLS12-381 key from a P-256-attested seed inside the TEE.

---

## What Needs to Be Built

| Component | Effort | Dependencies |
|---|---|---|
| `EnclaveRegistry` Compact contract | Low | Standard Compact contract patterns |
| `DeviceKeyRegistry` Compact contract with BLS12-381 signature verification | Moderate | BLS12-381 Compact circuit primitive (may already exist in Midnight stdlib) |
| Registration oracle (off-chain service) | Moderate | TEE SDK integration per platform (SGX, SEV-SNP, TrustZone) |
| Mobile TEE enclave with BLS12-381 key generation | Moderate–High | Platform-specific TEE SDK; BLS12-381 arithmetic in enclave |
| Application contract dual-path interface | Low | Builds on registry contracts |

No changes to the Midnight validator, consensus layer, or proof system are required.

---

## Design Notes

### Circuit Complexity: Application Layer vs. Fee Layer

The TEE device key pattern shifts a significant fraction of the total circuit work out of the ZK proof:

| Operation | In circuit | In TEE |
|---|---|---|
| KYC evaluation (document checks, string matching) | ✗ | ✓ |
| Identity commitment hash (`SHA-256` / Poseidon) | ✗ | ✓ |
| Schnorr nonce derivation (HKDF) | ✗ | ✓ |
| Schnorr signing (`s = r + c·sk` mod JUBJUB_R) | ✗ | ✓ |
| `sk_device` custody (all update calls) | ✗ | ✓ |
| Schnorr **verification** (`s·G == R + c·pk`) | ✓ | ✗ |

For the compliance PoC, `update_compliance` contains approximately two JubJub scalar multiplications, one point addition, and one hash — roughly 10,000–15,000 PLONK gates. This is one of the smallest possible Midnight application circuits. In a naive pure-ZK design, the same functionality would require KYC verification logic and commitment hashing inside the circuit, likely adding hundreds of thousands of constraints.

**Observed proof times** (local proof server, 2026-04-09):

| Circuit | Observed time | Dominant operation |
|---|---|---|
| `update_compliance` | ~1.66 s | Two `ecMul` (Schnorr verification) |
| DUST fee spend | ~0.62 s | Poseidon-based Merkle path |

**Why `update_compliance` is slower than DUST despite the smaller circuit description:** The Schnorr verification requires two Jubjub scalar multiplications (`ecMulGenerator(sig_s)` and `ecMul(device_pk, c)`). Each scalar multiplication requires ~252 constraint-level doublings and additions — roughly 2,000–3,000 PLONK gates per operation with standard windowing, even with the generator fixed. By contrast, the DUST Merkle path uses **Poseidon hashes**, which are designed for ZK-native evaluation: ~30 constraints per node × 32 levels ≈ 960 constraints total. The Poseidon-based Merkle tree is cheaper in-circuit than a single `ecMul`.

| Operation | Approx. PLONK gates |
|---|---|
| Poseidon hash (one Merkle node) | ~30 |
| 32-level DUST Merkle path | ~960 |
| `ecMulGenerator` / `ecMul` (one scalar mul) | ~2,000–3,000 |
| Two `ecMul` in `update_compliance` | ~4,000–6,000 |
| `persistentHash` + `ecAdd` | ~300 |

The key generalisation: **the ZK bottleneck in Midnight-style applications is elliptic curve arithmetic, not Merkle tree depth.** Any circuit that verifies a Schnorr or ECDSA signature in-circuit will be dominated by the ecMul cost, regardless of how short the circuit description looks. Designs that can express authorisation using hash-based commitments alone (without in-circuit EC operations) will have substantially cheaper application circuits.

**Security consequence of the split:** The Schnorr challenge hash covers both `new_tier` and `new_identity_commitment` jointly. Neither can be altered in transit without breaking the Schnorr verification `s·G == R + c·device_pk`. The tier need not be embedded in the identity commitment: the commitment is a stable fingerprint of *who someone is* (name, DOB, jurisdiction); the tier is a policy judgement that can change without the identity changing. The Schnorr signature already provides the necessary joint attestation of both fields at the time of signing.

### DUST Fee Payment Also Requires a ZK Proof

tDUST (testnet DUST — the "t" stands for **testnet**, not "transparent") is the fee token on Midnight testnets; DUST is the equivalent on mainnet. Despite operating as a fee resource rather than a value-transfer asset, DUST uses the **same commitment/nullifier paradigm as ZSwap**. Per the [Midnight ledger specification](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/dust.md): each DUST UTXO has a commitment inserted into an append-only Merkle tree at creation and a nullifier inserted into a nullifier set when spent; spending requires a ZK proof of Merkle tree membership.

Consequently, even for dApps with no ZSwap NIGHT movements, the DUST fee payment requires a ZK proof with a Merkle path over the DUST commitment tree. For the compliance PoC, the DUST fee proof (~0.62 s observed) is structurally similar to a ZSwap note spend. Counterintuitively, the application circuit (`update_compliance`, ~1.66 s observed) takes longer than the DUST proof, because Schnorr verification requires two in-circuit `ecMul` operations whereas the DUST Merkle path uses Poseidon hashes (~30 gates/node). The DUST proof is **not** the dominant cost when Schnorr verification is present.

### Split Proving: On-Device Application Circuit, Server-Side Fee Proof

The two proof obligations have fundamentally different privacy properties, which suggests an optimal split:

| Proof | Private inputs? | Observed time | Natural location |
|---|---|---|---|
| `update_compliance` | **None** — all inputs public (`sig_r`, `sig_s`, `new_tier`, `new_identity_commitment`, `nonce`) | ~1.66 s | Mobile device |
| DUST fee spend | **Yes** — `dustSecretKey` (nullifier derivation) | ~0.62 s | Remote server |
| `register_device` | **Yes** — `sk_device` (private witness) | (not measured) | TEE-attested server |

The primary motivation for routing `update_compliance` to the mobile device is **privacy**, not performance: the circuit has no private inputs, so any prover can generate it without confidentiality concern. Performance-wise, the application circuit (~1.66 s) is actually *slower* than DUST (~0.62 s) because Schnorr verification requires two in-circuit `ecMul` operations (see [Circuit Complexity section](#circuit-complexity-application-layer-vs-fee-layer)).

**Benefit:** server load is reduced to the fixed DUST overhead regardless of application circuit complexity. For dApps with large application circuits (complex private state machines, multi-step compliance workflows), offloading the application proof to the device eliminates the variable component entirely. The server handles one standard DUST proof per transaction no matter how much computation the contract performs. The compliance PoC inverts the expected ordering: the "small" application circuit takes 2.7× longer than the "expensive" DUST Merkle proof, due to the ecMul cost of in-circuit Schnorr verification.

**DUST server trust level:** The DUST proof requires `dustSecretKey`, which controls fee-paying capacity but not NIGHT value. Whether this warrants a TEE-attested server is a product decision; a lower-trust proof service may be acceptable for fee keys in many deployments.

**SDK architecture:** The Midnight SDK (`httpClientProofProvider`) already makes **one HTTP call per circuit** — it does not use a bundled `/prove-tx` endpoint. Internally it wraps `httpClientProvingProvider`, which calls `POST /prove` once per circuit via `unprovenTx.prove(baseProvingProvider, costModel)`. This means split proving — routing different circuits to different proof servers — is architecturally natural: a custom `provingProvider` implementation that inspects the `keyLocation` argument and dispatches to different HTTP endpoints would work without any changes to the SDK core. No SDK extension is needed, only a composing dispatcher at the provider boundary.

### The Application Contract Can Be Generic

The ZSwap verification component (nullifier derivation, commitment tree membership, output commitment formation) is identical for any ZSwap transfer regardless of what authorised it. TEE signature verification is similarly generic (BLS12-381 curve arithmetic). A contract can therefore be designed as a generic executor:

```
verify TEE signature over (amount_commitment, P, R, nullifier, cm_out, action_hash)
verify ZSwap proof
execute action identified by action_hash
```

Business logic is encoded in the TEE's payload and referenced by `action_hash` rather than hard-coded in the contract. The contract enforces *that* a valid TEE authorised a valid ZSwap transfer; it does not need to interpret what the transfer means. This separates the ZSwap + TEE plumbing (stable, reusable) from the application semantics (variable, per-dApp).

### Trusted Parties Summary

| Party | Trusted for |
|---|---|
| Hardware manufacturer | TEE key generation and attestation integrity |
| Registration oracle(s) | Correctly verifying attestation at device registration |
| Enclave code governance | Approving the correct enclave code hashes |
| GraphQL indexer operator | Not logging recipient name lookups or Merkle queries |
| TEE-attested proof server | Not exfiltrating witness package from its enclave |

---

## TEE as Decision Engine: Authorising Private Asset Movements

The device key registration pattern can be extended so the TEE runs arbitrary application logic and authorises private asset movements via signed public outputs — without the TEE ever holding spending keys or note data.

### Budget Commitment

A **budget commitment** stored in private Compact state binds the TEE's signing authority to specific asset constraints:

```
C = Commit(max_amount, asset_type, authorized_counterparties, tee_public_key)
```

Registered once when the user configures the TEE's authority. Held in private state — on-chain observers see only the opaque commitment hash.

### Spending Flow

```
┌─────────────┐           ┌────────────────────────┐           ┌──────────────┐
│ Mobile TEE  │           │    ZK circuit / prover  │           │  Midnight    │
│             │           │                         │           │  contract    │
└──────┬──────┘           └──────────┬─────────────┘           └──────┬───────┘
       │                             │                                 │
       │  runs application logic     │                                 │
       │  decides: pay A to P        │                                 │
       │  signs(amount, recipient,   │                                 │
       │    nonce, tee_key)          │                                 │
       │─────────────────────────── public authorisation ────────────▶│
       │                             │                                 │
       │                   wallet provides private witnesses:          │
       │                   (spending_key, note_preimage,               │
       │                    merkle_proof, budget_preimage)             │
       │                             │                                 │
       │                             │  proves all of:                 │
       │                             │  ✓ TEE sig valid                │
       │                             │  ✓ amount ≤ max_amount          │
       │                             │  ✓ recipient authorised         │
       │                             │  ✓ nullifier correctly derived  │
       │                             │  ✓ output commitments correct   │
       │                             │──────── ZK proof ──────────────▶│
       │                             │                                 │  apply state
       │                             │                                 │  append nullifier
       │                             │                                 │  add commitments
```

### Hiding Recipient and Amount

The TEE's signed authorisation can be made fully opaque by combining a stealth address for the recipient with a commitment for the amount. Instead of signing `(amount, recipient_address)` in plaintext, the TEE signs:

```
TEE signs: (amount_commitment, P, R)

  amount_commitment = Commit(amount, r_amount)
    → hides the transfer value; ZK circuit proves consistency with note preimage

  R = r_ephemeral * G
    → ephemeral public key published for recipient scanning

  P = K_spend + H(r_ephemeral * K_scan) * G
    → one-time stealth address; only the recipient can derive it from K_scan
```

`K_scan` and `K_spend` are the recipient's public keys, available from the named account registry in [`experiments/compact-named-accounts`](../experiments/compact-named-accounts/contracts/single-named.compact). The TEE looks them up without any private access; the computation of `P` happens inside the enclave so the ephemeral scalar `r_ephemeral` is never exposed.

**What observers see:** an opaque triple `(amount_commitment, P, R)` plus a nullifier and output commitment. Neither recipient identity nor amount is recoverable without `k_scan_scalar` (recipient) and the amount witness (prover).

**Known limitation:** the Compact circuit cannot currently verify the full stealth address derivation in-circuit (BLS12-381 Fr vs. Jubjub EmbeddedFr scalar range mismatch). This is a Compact tooling gap, not a cryptographic obstacle; the TEE computes `P` correctly and the recipient verifies off-chain.

### What Each Party Holds

| Party | Holds | Never sees |
|---|---|---|
| Mobile TEE | TEE signing key, application state, budget commitment | Spending key, note values, note randomness |
| Proof server (wallet/remote) | Spending key, note preimage, Merkle proof | Application logic inputs, TEE internal state |
| On-chain observers | Budget commitment (opaque), nullifier, output commitments, TEE signature | Everything else |

The TEE's application logic complexity has zero impact on the proof server's witness set. Whatever the TEE computed, the prover sees only a signature and standard ZSwap material.

---

## TEE Processing Flow: User Input to Signed Triple

This section covers the full-wallet model: the TEE holds the sender's wallet material and generates both the signed triple and the witness package.

### Phase 0 — What the TEE Holds Persistently

```
TEE persistent state (inside enclave):
  device_key       ← registered BLS12-381 signing key
  sk_in            ← sender's spending key for owned notes
  notes[]          ← list of { value, asset_type, randomness ρ_in, Merkle position }
  budget_preimage  ← (max_amount, asset_type, authorized_recipients, tee_public_key)
```

`K_scan` and `K_spend` are the **recipient's** public keys — published in the registry, looked up per transaction.

### Phase 1 — Secure User Input

The user enters `(amount, recipient_name)` via one of:

- **Trusted display path** — on platforms with a secure input channel (some TrustZone implementations), keystrokes go directly to the secure world without passing through the host OS.
- **Encrypted input channel** — user encrypts `(amount, recipient_name)` to the enclave's public key before submission; host OS sees only ciphertext.

### Phase 2 — Inside the Enclave

All of the following executes inside the enclave. Items marked *secret* never leave it.

> ⚠️ **GraphQL indexer leakage.** The registry lookup queries the Midnight GraphQL indexer for `K_scan`/`K_spend` by recipient name. The indexer operator learns who the sender intends to pay. If the Merkle inclusion proof for the input note is also fetched here, the indexer learns which commitment is being spent — linkable to the historical deposit that created it. The GraphQL indexer is a **trusted party in the privacy model**, analogous to the registration oracle. Mitigations: route queries via Tor or a mixing proxy; pre-fetch registry entries and Merkle state in bulk rather than per-transaction.

```
1. Registry lookup
   (K_scan, K_spend) ← query GraphQL indexer for recipient_name
   [public keys — no private access needed; see leakage note above]

2. Generate fresh randomness
   r_ephemeral  ← secure RNG    [secret]
   r_amount     ← secure RNG    [sent in witness package]
   ρ_out        ← secure RNG    [sent in witness package]

3. Stealth address (Jubjub curve)
   R  = r_ephemeral · G          [public — for recipient scanning]
   S  = r_ephemeral · K_scan     [secret — ECDH shared secret]
   h  = H(S) mod JUBJUB_R        [secret — hash to scalar]
   P  = K_spend + h · G          [public — one-time stealth address]

4. Select input note and derive nullifier
   note      ← select from notes[] with value ≥ amount
   nullifier ← H(note.note_id, sk_in)   [public — posted to nullifier set]

5. Compute output commitment (standard ZSwap note targeted at P)
   cm_out ← Commit(amount, asset_type, P, ρ_out)   [public]

6. Compute amount commitment (binds the signed amount without revealing it)
   amount_commitment ← Commit(amount, r_amount)     [public]

7. Sign the triple plus ZSwap artifacts
   sig_TEE ← sign(device_key,
               amount_commitment ‖ P ‖ R ‖ nullifier ‖ cm_out)
```

> ✅ **Feasibility inside TrustZone.** Steps 2–7 require only EC point multiplications over Jubjub, hash evaluations, and Pedersen commitment constructions — field arithmetic with no FFT or large MSM. Working memory is well under 16 MB and total computation is under 100 ms. Witness package construction is entirely feasible inside the mobile TEE; only the ZK prover step (Phase 4) is offloaded.

### Phase 3 — TEE Outputs

**Public** (posted to Midnight or sent to proof server as circuit inputs):
```
sig_TEE, amount_commitment, P, R, nullifier, cm_out
```
None reveals amount, recipient identity, or sender identity to chain observers.

**Witness package** (sent to proof server — see below for what this leaks):
```
{
  sk_in,             ← sender's spending key
  note.value,        ← input note balance
  note.randomness,   ← input note ρ_in
  note.merkle_proof, ← Merkle path to input commitment
  r_amount,          ← amount commitment blinding factor
  ρ_out,             ← output note randomness
  budget_preimage    ← (max_amount, asset_type, authorized_recipients, …)
}
```

### Phase 4 — Proof Server

Generates a single ZK proof over:

| Constraint | Public inputs | Private witnesses |
|---|---|---|
| TEE signature valid | `sig_TEE`, all public outputs | — |
| Amount commitment consistent | `amount_commitment` | `note.value`, `r_amount` |
| Output commitment consistent | `cm_out` | `note.value`, `P`, `ρ_out` |
| Nullifier correctly derived | `nullifier` | `sk_in`, `note.note_id` |
| Input note in commitment tree | Merkle root (chain state) | `note.merkle_proof` |
| Amount within budget | Budget commitment (on-chain) | `budget_preimage` |

After the proof server returns the ZK proof, the mobile TEE checks that the proof's public inputs match what it computed (amount_commitment, P, R, nullifier, cm_out) and optionally runs full BLS12-381 proof verification (≈6 ms, well within TrustZone). The transaction is signed only if this check passes — this is how the TEE verifies the work of the proof server.

---

## What the Witness Package Leaks

The witness package is sent to the proof server each transaction. Its contents are not protected by the TEE's attestation guarantee — they are private inputs to a computation, not secrets held inside an enclave. What the proof server learns:

| Witness item | What it reveals | Severity |
|---|---|---|
| `sk_in` | The sender's spending key — persistent across all notes that share this key | **High** — `sk_in` alone is not sufficient to spend other notes (each note also requires its own `ρ` and `value`), but a proof server that logs `sk_in` and subsequently processes further transactions for this key progressively accumulates `(sk_in, ρ, value)` tuples, gaining the ability to spend all notes it has seen |
| `note.merkle_proof` | Which specific commitment in the tree is being spent, i.e., its position and Merkle path | **Medium** — if the commitment's origin is known (e.g., the proof server processed the transaction that created it), this links the current spend to a historical deposit |
| `note.value` | The input note's full balance, not just the transfer amount; the change is implicit as `note.value − amount` | **Medium** — reveals how much the sender holds in this specific note |
| `budget_preimage` | Maximum authorised spend amount, asset type, and set of authorised recipients | **Medium** — exposes financial limits and the sender's relationship graph |
| `note.randomness` | The input note's randomness; combined with `sk_in` and `note.value`, fully characterises the note | **Low-medium** — enables fingerprinting of this specific note |
| `r_amount` | The transfer amount (recoverable from `amount_commitment`) — already implied by `note.value` | **Low** — redundant given `note.value` |
| `ρ_out` | The output note's randomness; combined with `cm_out`, enables future recognition of the output note | **Low** — the proof server would also need `P` (public) to track the output |

**The dominant concern is `sk_in`.** Unlike all other items, the spending key is persistent across notes. `sk_in` alone is not sufficient to spend other notes — each note also requires its own randomness `ρ` and value, which are not derivable from `sk_in`. However, a proof server that logs `sk_in` and processes further transactions for the same key accumulates `(sk_in, ρ, value)` tuples over time, progressively gaining the ability to spend all notes it has seen. The first transaction reveals `sk_in`; each subsequent transaction adds another spendable note to the server's capability.

**Why one-time per-note spending keys are awkward.** Deriving a fresh `sk_in` per note from a root key limits each exposure to a single note, but introduces significant wallet engineering cost: per-note key tracking, more complex recovery from seed phrase, and key rotation logic. It is a valid mitigation but not a clean default.

**The ZSwap prover cannot run inside the mobile TEE.** ARM TrustZone's secure world has approximately 16–64 MB of total memory. A BLS12-381 PLONK prover for even a small circuit requires hundreds of megabytes. This is a hard constraint — not a performance trade-off. Running the prover in the normal world (outside the TEE) means `sk_in` leaves the enclave and enters the host OS, negating the TEE's protection.

**The architecturally correct solution: two TEEs.**

```
Mobile TEE                             TEE-attested proof server
──────────────────────────────         ──────────────────────────────
holds sk_in, notes, device_key         holds server enclave key

computes witness package
        │
        │  encrypted to server's
        │  attestation public key
        ▼
[ciphertext on network]  ──────────▶  decrypts inside server enclave
                                       generates ZK proof (~5–20 s)
                                       discards witnesses
                                       returns proof (~5 KB)
        │
        ◀─────────────────────────────
        │
TEE verifies proof (≈6 ms)
TEE signs transaction
```

`sk_in` is never in plaintext outside a TEE at any point. The mobile TEE holds all private material; the server enclave runs the heavy computation; the mobile TEE verifies the returned proof before signing. The two TEEs together cover the full transaction lifecycle.

The TEE-attested remote proof server is the natural complement to the mobile TEE wallet — not an optional upgrade, but the architecturally correct pairing.

**Proof server options, in order of preference:**

| Model | `sk_in` exposure | Notes |
|---|---|---|
| **TEE-attested remote server** *(recommended)* | Encrypted to enclave; server cannot log | Natural pairing with mobile TEE; `sk_in` never in plaintext outside an enclave |
| Local prover (normal world) | Plaintext to host OS | Acceptable on a trusted device; not suitable on shared or compromised hardware |
| Commodity server (trust-on-use) | Plaintext; server must not log | User accepts operational trust in the server operator; accumulation risk applies |
| Fully public (TEE trusted for ZSwap) | None sent | TEE replaces ZK for note validity; weakens the mathematical guarantee for that component |

---

## Proof Server Requirements

### Which dApps Need a Private Proof Server?

A private (TEE-attested or locally-run) proof server is required if and only if the transaction involves **private Midnight assets** — ZSwap nullifiers, note commitments, and spending keys. Application logic handled by the TEE does not require a private proof server, because the TEE's signed result is a public input to a minimal circuit.

| dApp type | Examples | Private proof server needed? |
|---|---|---|
| Pure computation, no private NIGHT assets | Gaming, voting, AI inference, identity verification, ZK-unfriendly hash verification | **No** — application circuit has only public inputs; DUST fee proof is public |
| Private asset transfers only | Confidential payments, private token transfers | **Yes** — ZSwap witnesses require a trusted prover |
| TEE computation + private assets | Private DeFi, confidential auctions with asset settlement | **Yes — ZSwap component only**; application logic is public |
| Complex private contract logic (TEE-handled) | Compliance, complex private state machines | **Yes — ZSwap component only**; TEE collapses the application circuit |
| ZK-unfriendly operations (SHA-256, AES, keccak) | Web2 data proofs, document integrity | **No** — TEE computes natively; result is a public signature |

For dApps with no private NIGHT asset operations, proof generation requires only public inputs. Any server can act as proof server without privacy concern. Note that DUST fee payment always requires a ZK proof (Merkle path over the DUST commitment tree), but this proof has no private inputs — it can be generated by any public proof server.

### Mobile Proof Server Capability

The ZSwap prover **cannot run inside the mobile TEE** — ARM TrustZone's 16–64 MB secure world memory is orders of magnitude too small for a BLS12-381 PLONK prover. Running it in the normal world (outside the TEE) exposes `sk_in` to the host OS.

For dApps with **no private NIGHT asset operations**, the optimal split is: the mobile device proves the application circuit locally (no private inputs — feasible in principle on modern mobile hardware), while a remote server proves only the DUST fee circuit (requires `dustSecretKey`, Merkle path). This minimises server load to the fixed DUST overhead, regardless of application complexity. The DUST proof server need not be TEE-attested (the fee key has lower sensitivity than ZSwap spending keys), so a standard proof server suffices.

**Measured timing on mobile hardware (2026-04-09):** the `midnight-proof-server` binary from the `midnight-ledger` source tree was compiled as a static ARM64 musl binary and run on a Samsung Galaxy Tab S7 (Snapdragon 865+, Cortex-A77 @ 3.09 GHz) via ADB. Comparison across hardware:

| Circuit | x86-64 server | AWS c6g.large (Graviton2) | Samsung Tab S7 (Snap. 865+) |
|---|---|---|---|
| `update_compliance` | 1.66 s | 15.60 s | 6.79 s |
| DUST fee | 0.62 s | 5.53 s | 3.62 s |
| Total | 2.28 s | 21.13 s | 10.41 s |

The S7 result (~10 s total) is significantly better than the Graviton2 result (~21 s), confirming that Graviton2 is a poor proxy for mobile performance on single-threaded cryptographic workloads. The Neoverse N1 core is throughput-optimised for multi-threaded server scale-out; the Snapdragon 865+ Cortex-A77 prime core runs 600 MHz faster and has competitive IPC for single-threaded integer arithmetic, giving a ~2.3× advantage despite being a 2020 mobile chip.

**Revised estimates based on measured S7 baseline** (Pixel 8a uses Tensor G3, Cortex-X3 @ ~3.0 GHz — ~20–25% better IPC than A77):

| Circuit | Samsung Tab S7 (measured) | Pixel 8a (est.) | Feasibility |
|---|---|---|---|
| `update_compliance` | 6.79 s | ~5–6 s | Acceptable for rare KYC updates |
| DUST fee | 3.62 s | ~3 s | Acceptable |

**ecMul is the real bottleneck.** Despite the DUST circuit involving a 32-level Poseidon Merkle path, the application circuit is slower because Schnorr verification requires two in-circuit Jubjub scalar multiplications (~2,000–3,000 gates each). This generalises: any Midnight circuit containing in-circuit EC signature verification will be bottlenecked by the `ecMul` cost, not by hash depth or data size. Circuits that can express authorisation via hash-based commitments (no in-circuit EC operations) will prove significantly faster and are better candidates for mobile proving.

For dApps **with ZSwap NIGHT movements**, the full ZSwap witness package (spending key, note preimage, Merkle path) still requires a TEE-attested remote proof server. The mobile TEE encrypts the witness to the server's attestation key and verifies the returned proof (~6 ms) before signing.

For dApps **with ZSwap**, the TEE-attested remote proof server is the recommended path. Proof *verification* (≈6 ms) runs comfortably inside TrustZone, so the mobile TEE can verify the returned proof before signing.

### Mobile Proof Server: Experimental Setup (2026-04-09)

The following steps produced a working proof server on a Samsung Galaxy Tab S7 (Android, ARM64) accessed from a laptop running the `local-tee-poc` TUI.

**Step 1 — Build a static ARM64 binary on an EC2 c6g.large (Debian ARM64)**

```bash
# Clone the proof server source
git clone https://github.com/midnightntwrk/midnight-ledger --branch ledger-7.0.0
cd midnight-ledger

# Install toolchain prerequisites
sudo apt-get install -y build-essential rustup musl-tools
rustup toolchain install stable
rustup target add aarch64-unknown-linux-musl

# Build a fully static binary (no glibc dependency — runs in bare Termux or proot)
RUSTFLAGS="-C target-feature=+crt-static" \
  cargo build -p midnight-proof-server --release \
  --target aarch64-unknown-linux-musl

# Verify: should say "statically linked" or "not a dynamic executable"
ldd target/aarch64-unknown-linux-musl/release/midnight-proof-server
```

The static musl build is required because Android's ADB shell environment does not provide glibc. A dynamically linked binary would fail with a missing linker error.

**Step 2 — Pre-download the ZK proving keys on the EC2**

The proof server fetches ~10 proving key files from an S3 bucket on first startup. The ADB shell user has no internet access (Android iptables blocks outbound traffic for unprivileged UIDs), so the files must be copied manually.

Run the server once on the EC2 to populate the cache, then identify the cache directory:

```bash
HOME=/tmp/ps-cache ./target/aarch64-unknown-linux-musl/release/midnight-proof-server \
  --port 6300 --num-workers 1 &
# Wait for "Actix runtime found; starting in Actix runtime", then Ctrl-C

# Find where the key files landed
find /tmp/ps-cache/.cache -name "bls_midnight*" -o -name "*.prover" | head -20
```

**Step 3 — Transfer binary and key cache to the tablet**

```bash
# Enable developer mode + USB debugging on the tablet, then:
adb devices   # confirm tablet visible

# Push binary
adb push target/aarch64-unknown-linux-musl/release/midnight-proof-server /data/local/tmp/
adb shell chmod +x /data/local/tmp/midnight-proof-server

# Push pre-downloaded key cache (adjust source path to match Step 2 find output)
adb push /tmp/ps-cache/.cache/midnight-proof-server-keys /data/local/tmp/.cache/midnight-proof-server-keys
```

**Step 4 — Run the proof server on the tablet**

```bash
# HOME must be set to a writable directory; /data/local/tmp is writable
# The binary writes its own cache there as HOME/.cache/...
adb shell "HOME=/data/local/tmp /data/local/tmp/midnight-proof-server \
  --port 6300 --num-workers 1"
```

**Step 5 — Forward the port and configure the TUI**

```bash
# On the laptop — forward laptop port 6301 to tablet port 6300
adb forward tcp:6301 tcp:6300
```

In the TUI's Network screen, set the proof server URL to `http://localhost:6301`. The ADB forward is transparent to the SDK.

**Note on app-on-device deployment:** if the `local-tee-poc` TUI were running on the tablet itself (e.g., via Termux + Node.js), it could connect directly to `http://localhost:6300` — no ADB forwarding needed. The forwarding was only required because the app ran on the laptop.

**Pitfalls encountered**

| Issue | Cause | Fix |
|---|---|---|
| Official `linux/arm64` Docker tag contains an x86-64 binary | Publishing bug in `midnightnetwork/proof-server` image | Compile from source |
| `midnight-zk` repo has no HTTP server | `midnight-zk` is a library collection; HTTP server is in `midnight-ledger/proof-server` | Clone the correct repo |
| `Error: Os { code: 30, kind: ReadOnlyFilesystem }` | Proof server writes key cache relative to `$HOME`; ADB shell has `HOME=/` (read-only on Android) | Set `HOME=/data/local/tmp` |
| Network timeouts downloading key files | ADB shell UID has no internet access (Android iptables) | Pre-download on EC2, copy via ADB |
| Second `/prove` used stale proof server URL | Wallet initialised with `provingServerUrl` in a `useEffect` that did not include `proofServerUrl` in its dependency array | Add `network.proofServerUrl` to the effect deps |

**Alternatives to ADB shell for production deployment**

The ADB shell workarounds above (no internet, `HOME` override, manual key copy) arise because `adb shell` runs as the unprivileged `shell` UID with no Android permissions. A proper deployment would use one of the following approaches, in order of increasing robustness:

*Termux (zero development work).* Termux is an APK with `android.permission.INTERNET` declared. Any process running inside Termux inherits the app's UID and its internet access. Pushing the static binary to `/data/data/com.termux/files/home/` and running it from the Termux terminal would have allowed the proof server to download the key material directly, eliminating the manual pre-download step entirely.

*Minimal wrapper APK (days of work).* A small Kotlin app that declares `INTERNET` permission, bundles the static binary in `assets/`, copies it to `getFilesDir()` on first launch (which is executable), and runs it via `ProcessBuilder`. This requires no changes to the proof server binary and produces something installable without developer mode.

*JNI library APK (production quality).* Compile `midnight-proof-server` as a shared library using the Android NDK (`aarch64-linux-android` target, Bionic libc — distinct from the musl target used above) with a JNI entry point, and wrap it in an Android `ForegroundService`. This avoids subprocess management, handles Android lifecycle correctly, and is the appropriate architecture for a shipping product.

The `aarch64-linux-android` (Bionic) and `aarch64-unknown-linux-musl` targets are not interchangeable: the NDK provides its own toolchain and libc, so the JNI path requires a separate build from the static binary used in this experiment.

## Hardware Platform Survey

### Detection (Linux)

```bash
grep -ow 'sgx[^ ]*' /proc/cpuinfo | sort -u   # SGX CPU flags
ls /dev/sgx* 2>/dev/null                        # SGX driver device nodes
ls /dev/tpm* 2>/dev/null                        # TPM device nodes
uname -m                                        # architecture
```

### Platform capabilities

| Platform | TEE type | Custom code | Jubjub in HW | Works on phone | Attestation |
|---|---|---|---|---|---|
| Intel SGX (6th–11th gen laptop) | SGX enclave | ✓ | software (in-enclave) | No | SGX DCAP |
| Intel SGX (Xeon / Azure DCsv3) | SGX enclave | ✓ | software (in-enclave) | No | SGX DCAP |
| TPM 2.0 (most x86_64 laptops) | Key storage only | Key ops only | No | No | TPM Platform Cert |
| ARM TrustZone (Android, custom) | Secure world | ✓ (custom TA) | software | Yes (native) | TrustZone attestation |
| Android StrongBox / Titan M2 | Fixed-function secure element | Key ops only | No | Yes (native) | Hardware Key Attestation |
| Ledger Nano S+/X | Dual-chip (SE + STM32) | ✓ (BOLOS app) | software (in-app) | Yes (USB-C OTG / BLE) | Ledger mfr. cert (EAL5+) |
| Ledger Stax / Flex | Dual-chip (SE + STM32WB55) | ✓ (BOLOS app) | software (in-app) | Yes (USB-C OTG / BLE / NFC) | Ledger mfr. cert (EAL6+) |
| Apple Secure Enclave | Fixed-function | Key ops only | No | Yes (iOS/macOS) | Apple attestation |

**Intel SGX availability:** Intel removed SGX from consumer/laptop CPUs starting with 12th-gen (Alder Lake). It remains available on Xeon server parts and older 6th–11th gen laptop chips. AMD CPUs have never included SGX.

**TPM 2.0** supports hardware-backed key storage and HMAC/ECDSA signing but cannot run arbitrary code — Jubjub operations cannot be offloaded to a TPM.

**Android TrustZone** on Pixel 6+ devices includes a dedicated Titan M2 security chip. The Android Keystore API (StrongBox tier) provides hardware-bound key generation and ECDSA/HMAC operations. Installing custom Trusted Applications into TrustZone requires firmware signing keys held by Qualcomm/Google; this is not possible on production Android regardless of bootloader state. GrapheneOS preserves and ships its own attestation keys, so hardware key attestation produces a valid certificate chain.

**Important distinction — secure component vs full device.** The table above describes what each device's *secure component* can do, not the device as a whole. A laptop is a full general-purpose computer: its CPU can run a ZK proof server; only its TPM is limited to key operations. Similarly, a phone's normal-world CPU is powerful enough to run a ZK prover for small circuits (mobile ZK provers have been demonstrated for Noir and Aztec circuits), but that execution is outside the secure enclave and carries no TEE protection guarantee. The practical consequence: **no portable consumer device can serve as a secure proof server** — the TEE memory ceiling (16–64 MB for TrustZone) is orders of magnitude too small for a BLS12-381 prover — but a laptop's normal-world CPU can serve as an unprotected local prover, which is acceptable on a trusted device.

### Implementation progression

The tiers address progressively stronger threat models. The ZK contract and circuit are unchanged across all tiers.

| Tier | Platform | `sk_device` protection | Attestation | Status |
|---|---|---|---|---|
| **1 — Stub** | Any (in-process) | HKDF-derived from wallet seed; plaintext RAM during proving; deterministic across restarts | None | Done — `experiments/local-tee-poc` |
| **2 — TPM-backed** | x86_64 laptop with TPM 2.0 | Root secret sealed by TPM; `sk_device` derived via HKDF; in RAM only during proving | TPM Platform Certificate | Not implemented |
| **2b — Android StrongBox** | Pixel + GrapheneOS | Root secret in Titan M2 (non-extractable); `sk_device` derived via HMAC; in RAM during proving | Hardware Key Attestation certificate chain | Not implemented |
| **2c — Ledger Nano** | USB dongle (laptop or phone via OTG/BLE) | Hardware-bound to Ledger secure element; released to host only on explicit button press | Ledger manufacturer attestation certificate | Not implemented |
| **3 — SGX enclave** | Azure DCsv3 (cloud) | `sk_device` generated and held in SGX enclave; Jubjub computed in-enclave; only ZK proof leaves | SGX remote attestation (DCAP) | Not implemented |

Tiers 2/2b/2c all preserve the same two-enclave limitation: `sk_device` enters host memory for the ZK proving step because proof generation is too computationally intensive for a TPM, secure element, or Ledger MCU. What they add is that releasing the key requires hardware consent and produces a verifiable attestation chain.

### Ledger Nano (Tier 2c)

**Ecosystem context.** The Ledger is not the only programmable hardware security token — Trezor Safe 3/5, ColdCard, Foundation Passport, and Keystone are all hardware wallets with custom-programmable cryptography and certified secure elements, and JavaCard-based smart card tokens also support custom crypto code. What makes the Ledger the most practical choice for this use case is its developer ecosystem: the BOLOS OS, the Rust SDK (`ledger-device-sdk`), the Speculos emulator, and the Obsidian Systems / Alamgu Nix-packaged apps (including `ledger-app-tezos`, which already contains Jubjub arithmetic).

**APDU interface.** A Ledger app for this use case exposes two commands:

| Command | Action |
|---|---|
| `GET_PUBLIC_KEY` | Derive `sk_device` from the Ledger seed at a custom BIP32 path; return `pk = sk_device · G` |
| `GET_SK_DEVICE` | Display "Release device key?" on screen; return `sk_device` only after the user presses the physical confirm button |

The app logic is roughly 200–400 lines of Rust. The dominant cost is toolchain setup.

**Can the Ledger compute the Commit function?** Yes. Both commitment constructions from the ZSwap protocol — the SHC `amount · H(ty) + r_amount · G` and the nested note commitment `Commit(Commit(a_pk, rn; rk), ā; rc)` — require at most six Jubjub scalar multiplications and four point additions. These run in software on the Ledger's **application MCU** (Cortex-M4 @ 64 MHz, 256 KB RAM) in roughly 100–300 ms, which is acceptable for an interactive flow. The Commit inputs are not secret (amount, randomness scalars, and public curve generators), so there is no requirement for Commit computation to happen on the secure element.

The two-chip architecture maps cleanly to the two concerns:

| Operation | Runs on | Reason |
|---|---|---|
| `sk_device` derivation and storage | Secure element (ST33) | Secret; must not leave the SE |
| `ecMulGenerator(sk_device)` → `pk` | Secure element software | Involves the secret scalar |
| Commit computations | Application MCU (STM32) | No secrets involved; ample RAM |
| BLAKE2 / SHA-256 hashing | Application MCU | Standard hash, no secrets |

**Ledger Stax / Flex comparison.** The Stax (and its smaller sibling the Flex) uses an ST33K1M5 secure element certified at **CC EAL6+**, one level above the Nano X's ST33J2M0 at EAL5+. Both models run the same BOLOS operating system and expose identical crypto APIs to custom apps, so cryptographic programming capability is the same for our use case. The meaningful differences are:

| Feature | Nano S+ / X | Stax / Flex |
|---|---|---|
| Secure element | ST33J2M0 (CC EAL5+) | ST33K1M5 (CC EAL6+) |
| Application MCU | STM32F0 / STM32WB55 | STM32WB55 (Cortex-M4 @ 64 MHz + M0+) |
| NFC | No | Yes (ISO 14443, Type A+B) |
| Bluetooth | Nano X only | Yes |
| USB | USB-C | USB-C |
| Display | Monochrome pixel, 2 buttons | E-ink touch (Stax) / 2-button touch (Flex) |
| Jubjub arithmetic timing | ~100–300 ms (same MCU class) | ~100–300 ms |

**The NFC capability is the most relevant difference for this use case.** It enables tap-to-authenticate: the user holds the Stax near an NFC-enabled phone to release `sk_device` and authorise the ZK proof — no USB cable, no Bluetooth pairing required. This is the natural interaction model for a mobile compliance flow where the Ledger acts as a hardware second factor.

The higher EAL6+ certification may satisfy regulators who require the top Common Criteria level for financial security hardware.

**Recommendation.** Use a Nano X for PoC development (Tier 2c). The two-button BAGL UI framework is simpler to target than the Stax's touchscreen (NBGL), and the Obsidian Systems / Alamgu apps and the `ledger-device-sdk` Rust crate primarily target the Nano X/S+ form factor. Having two Nano X units is also valuable during development: one can serve as a backup if developer-mode flashing goes wrong, and the second can be used to verify that two independently-registered devices produce distinct `device_pk` values.

Once the BOLOS app works end-to-end on the Nano X, porting to the Stax is primarily a UI layer swap (BAGL → NBGL). At that point the Stax's NFC capability becomes available for the mobile tap-to-authenticate flow — the correct production choice if the deployment targets a consumer mobile-first interaction with no USB cable. The EAL6+ certification may also satisfy higher regulatory requirements than EAL5+.

*Devices available for this experiment: two Ledger Nano X, one Ledger Stax.*

### Cloud SGX (Tier 3)

| Platform | TEE type | Custom code | Notes |
|---|---|---|---|
| **Azure DCsv3** | Intel SGX | ✓ | Best ecosystem; Gramine/EGo available |
| **AWS Nitro Enclaves** | Software isolation | ✓ | No hardware root-of-trust in the SGX sense |
| **Google Confidential VMs** | AMD SEV | VM-level only | Encrypts VM memory; no single-process isolation |
| **Alibaba Cloud ECS** | Intel SGX | ✓ | Less ecosystem support |

[Gramine](https://gramine.readthedocs.io/) is a LibOS that runs an unmodified Linux binary inside an SGX enclave with minimal porting effort, making Azure DCsv3 + Gramine the fastest path to a production-representative TEE.

---

## NixOS Toolchain Notes

### What is in nixpkgs

- `nixos/modules/hardware/ledger.nix` — udev rules for using a Ledger as a hardware wallet; not a development tool
- `ledger-live-desktop` — the Ledger desktop app
- `gcc-arm-embedded` — ARM cross-compilation toolchain (needed for all embedded Ledger targets)
- `fenix` / `rust-overlay` (community flakes) — Rust nightly with embedded ARM targets (`thumbv6m-none-eabi` for Nano S, `thumbv8m.main-none-eabi` for Nano S+/X)

**Speculos** (the Ledger device emulator) is **not** in nixpkgs. It has complex Python + QEMU + SDL2 dependencies and would need to be packaged from scratch or run via Docker.

### Obsidian Systems / Alamgu (recommended starting point)

[Obsidian Systems](https://github.com/obsidiansystems) has built several production Ledger apps in Rust with full Nix support using a framework they call **Alamgu**:

- [`ledger-app-tezos`](https://github.com/obsidiansystems/ledger-app-tezos) — most relevant; Tezos's Sapling privacy features use BLS12-381 / Jubjub, the same curves Midnight uses
- [`ledger-app-sui`](https://github.com/obsidiansystems/ledger-app-sui) — clean example of the Nix build structure
- [`ledger-app-nervos`](https://github.com/obsidiansystems/ledger-app-nervos)

Their repos have `release.nix` files and support loading the app onto a device with a single `nix run` command. The `ledger-app-tezos` repo in particular is the right template for a Midnight device key app — the curve arithmetic is already present and Nix-packaged.

### Tier 3 (SGX) toolchain

The enclave component would be written in **Rust** using the [Teaclave SGX SDK](https://github.com/apache/incubator-teaclave-sgx-sdk) or compiled as an unmodified Rust binary under **Gramine**. The `jubjub` crate provides Jubjub scalar arithmetic; no native TEE crypto support is required.

The host-side bridge from Node.js to the enclave would use either:
- **N-API / node-addon-api** — direct FFI into a native `.node` module wrapping the SGX host shim
- **Unix socket / gRPC** — enclave runs as a separate process; Node.js calls it over IPC

Neither Gramine nor the Teaclave SGX SDK is currently in nixpkgs; both would need to be packaged or pulled from their own flakes.

---

## Compact Tooling: `ecMul` and Schnorr Signature Verification

**Status: implemented in Compact 0.4.0 / runtime 0.14.0** (the version used in `experiments/local-tee-poc`).

`ecMul(a: NativePoint, b: Field): NativePoint` is available in the Compact standard library. Combined with `ecMulGenerator` and `ecAdd`, this enables full Schnorr signature verification inside the circuit.

**Design:**

| Step | What leaves the TEE | Proof server sees |
|---|---|---|
| **Register** (once) | `sk_device` as ZK private witness | `sk_device` — one-time; use a TEE-attested server |
| **Update** (repeated) | `(R, s, nonce)` Schnorr signature | Signature only — `sk_device` never leaves the TEE |

**In-circuit Schnorr verification:**
```compact
const h: Bytes<32> = persistentHash<[NativePoint, NativePoint, Uint<8>, Field, Uint<64>, Uint<64>]>(
  [sig_r, device_pk, new_tier, new_identity_commitment, update_count, nonce]);
const c: Field = h as Field;   // safe: TypeScript ensures h < JUBJUB_R before calling
assert(ecMulGenerator(sig_s) == ecAdd(sig_r, ecMul(device_pk, c)), "invalid device signature");
```

**Nonce retry:** `Bytes<32> as Field` is a range-checked cast (not a truncation) that fails when the hash value ≥ FIELD_MODULUS. Since JUBJUB_R < FIELD_MODULUS, a stricter constraint applies: `ecMul` requires its scalar argument < JUBJUB_R (~5.7% of 32-byte hashes satisfy this). The `nonce: Uint<64>` parameter is iterated by the TypeScript stub TEE (nonce = 0, 1, 2, …) until the hash (interpreted as a little-endian integer) is < JUBJUB_R, then the winning nonce is passed to the circuit. The circuit recomputes the identical hash and the cast always succeeds. Expected iterations: ~17. See `lessons-learned.md §10`.

**Pure circuit helpers:** Two exported pure circuits allow the stub TEE to produce correct Schnorr signatures using the contract's own curve parameters and `persistentHash` — no external Jubjub library required:
```compact
export pure circuit compute_nonce_point(r: Field): NativePoint           // R = r·G
export pure circuit compute_schnorr_challenge(..., nonce: Uint<64>): Bytes<32>  // raw hash
```

These are callable synchronously from TypeScript via `contractMod.pureCircuits.*` without generating a ZK proof.

---

## Open Questions

1. **Oracle governance.** Who operates the registration oracles? What is the minimum operator set for adequate trust distribution?
2. **Key rotation.** A device registration is tied to a specific enclave code hash. When the enclave code is updated (security patch), all existing registrations become stale. What is the re-registration UX?
3. **BLS12-381 in mobile TEE.** Can BLS12-381 arithmetic run performantly inside a mobile secure enclave (TrustZone)? The field operations are well-optimised in software but the enclave's constrained memory may be a bottleneck.
4. **Private registry composability.** If the `DeviceKeyRegistry` is in private Compact state, how does `MyApp` call into it? The contract-to-contract private state interface needs to be defined.
5. **Regulatory acceptability.** Would enterprise users accept a TEE-attested path for regulated operations, given the hardware trust assumption?
6. **Nonce-retry UX.** The Schnorr challenge requires ~17 iterations of `compute_schnorr_challenge` to find a hash < JUBJUB_R. Each call is synchronous and fast (no ZK proof), but on a constrained device (Ledger MCU) the latency may be noticeable. Investigate whether the nonce-retry loop is acceptable on Tier 2c hardware, or whether a different challenge domain-separation strategy (e.g., hash-to-scalar with rejection sampling inside the enclave) is more appropriate.

---

## Sources

- [`assessments/tee-vs-zk.md`](../assessments/tee-vs-zk.md) — analysis of TEE as alternative proof path; §8 is the direct precursor to this design
- [`assessments/tee-cheat-codes.md`](../assessments/tee-cheat-codes.md) — parent TEE survey
- [WebAuthn / FIDO2 specification](https://www.w3.org/TR/webauthn/) — analogous key registration pattern
- [ERC-4337 smart contract wallets with passkeys](https://eips.ethereum.org/EIPS/eip-4337) — Ethereum precedent for on-chain device key registration
- [RIP-7212: P-256 curve precompile](https://github.com/ethereum/RIPs/blob/master/RIPS/rip-7212.md) — Ethereum's approach to making mobile secure enclave keys affordable on-chain

---

## Appendix: ZSwap Commitment Scheme Mathematics

The `Commit` notation used in the TEE Processing Flow refers to two distinct constructions from the ZSwap protocol (Engelmann et al., 2022). Both operate over the **Jubjub** curve — a 254-bit twisted Edwards curve embedded in BLS12-381 — using scalar multiplications and point additions.

### A.1 Sparse Homomorphic Commitment (SHC)

Used for: `amount_commitment = Commit(amount, r_amount)`

**Formula (additive EC notation, over Jubjub):**

```
Commit({(tyᵢ, aᵢ)}, rc)  =  Σᵢ aᵢ · H(tyᵢ)  +  rc · G
```

For a single asset type this simplifies to:

```
amount_commitment  =  amount · H(ty)  +  r_amount · G
```

- `G` — fixed generator of the Jubjub curve
- `H : T → Jubjub` — hash-to-curve function mapping an asset type descriptor to a Jubjub point
- `amount ∈ ℤ_q` — transfer amount (scalar, bounded by `2^α`)
- `r_amount ∈ ℤ_q` — blinding randomness (sent to proof server in witness package)

This is a standard vector Pedersen commitment with type-hashed generators. Its critical property is **additive homomorphism**: for the same asset type,

```
Commit(ty, a, rc) + Commit(ty, a', rc')  =  Commit(ty, a + a', rc + rc')
```

This allows the validator to check that a transaction is balanced — inputs and outputs sum to zero per type — using only the public commitments. The ZSwap protocol additionally relies on the **HID-OR** property (Hiding with Open Randomness): the commitment remains hiding even when the blinding randomness `rc` is published, because `H(ty)` is modelled as a random oracle. This property enables non-interactive transaction merging.

### A.2 Note Commitment (OTA `Gen`)

Used for: `cm_out = Commit(amount, asset_type, P, ρ_out)`

This is a **nested Pedersen commitment** (ZSwap Appendix B, Zerocash-style OTA):

```
inner   =  Commit(a_pk, rn ; rk)           ← commits to recipient address + note nonce
cm_out  =  Commit(inner,  ā  ; rc)          ← commits to inner + attributes (amount, type)
```

where:

- `a_pk` — the recipient's address scalar; in this design, the canonical scalar encoding of the one-time stealth address point `P`
- `ā = (amount, asset_type)` — the note's attribute vector
- `ρ_out = (rk, rc, rn)` — the triple of randomness scalars sampled fresh in Phase 2; the recipient's wallet retains this to spend the note later
- Both inner and outer `Commit` use the same underlying Pedersen commitment over Jubjub

Expanded fully:

```
cm_out  =  Commit( Commit(a_pk, rn ; rk),  (amount, asset_type)  ; rc )
```

This is the value inserted as a leaf into the Merkle commitment tree on-chain. The recipient recovers it by scanning with `K_scan`, deriving the shared secret to identify `P`, decrypting the accompanying ciphertext `C`, reconstructing `ρ_out = (rk, rc, rn)`, and recomputing `cm_out` to verify the match.

### A.3 Operations Summary

| Output | ZSwap name | Formula | Jubjub operations |
|---|---|---|---|
| `amount_commitment` | `com^T` (SHC) | `amount · H(ty) + r_amount · G` | 1 hash-to-curve, 2 scalar-mults, 1 point-add |
| `cm_out` | `note` (OTA Gen) | `Commit(Commit(a_pk, rn; rk), ā; rc)` | 4 scalar-mults, 2 point-adds (inner then outer) |

All operations are a fixed small number of Jubjub scalar multiplications and point additions. This is the same class of operations as `ecMulGenerator` and `ecAdd` in Compact, and they fit well within TrustZone's 16 MB memory constraint.

### A.4 Subtlety: Stealth Address Point to Scalar

The note commitment requires `a_pk` as a **scalar**, but the stealth address computation (Phase 2, step 3) yields `P` as a Jubjub **point**. The conversion is the canonical compressed-point serialisation used by the ZSwap `Receive` algorithm when parsing `P(sk)` — a point serialisation, not a new elliptic curve operation.

### A.5 Source

Engelmann, F., Kerber, T., Kohlweiss, M., Volkhov, M. (2022). *Zswap: zk-SNARK Based Non-Interactive Multi-Asset Swaps.* IACR ePrint 2022/1002. Definitions 1–2 (SHC), Appendix B (Zerocash-style OTA note commitment).

---

## Appendix B: Mobile App Sandboxing — Security Properties for Midnight Wallet Apps

This appendix characterises the OS-level isolation guarantees on Android and iOS that are relevant to handling Midnight contract secrets (mnemonics, `sk_device`, proof witnesses, identity commitments) in a mobile wallet application.

### B.1 Isolation Model

Both platforms isolate apps at the OS level.

**Android**
- Each app is assigned a unique Linux UID (e.g., `u0_a123`). The kernel enforces memory isolation between UIDs — separate address spaces, separate `/proc` entries.
- Apps cannot read each other's private data directories (`/data/data/<package>/`) without root or explicit sharing.
- The `shell` UID (2000) used by ADB is *less* privileged than a normal app in some respects (no internet access, no `/data/data` read access).

**iOS**
- Each app runs in a dedicated sandbox enforced by the XNU kernel + mandatory access control (MAC/TrustedBSD).
- Apps are containerised at `/var/mobile/Containers/Data/Application/<UUID>/`; no app can read another's container.
- iOS additionally uses pointer authentication (PAC) and kernel integrity protection that Android lacks on most devices.

### B.2 Inter-App Attack Surface

| Attack vector | Android | iOS | Notes |
|---|---|---|---|
| Read another app's memory | No — separate address spaces, ptrace blocked | No — more restrictive | Non-issue on unrooted device |
| Read another app's files | No — UID-enforced filesystem permissions | No — container isolation | |
| Keylogger / screen scraper | Partial — Accessibility Services can read screen content if user grants permission | No — Accessibility restricted; screen recording requires explicit user consent | |
| Clipboard sniffing | Android 12+: apps only receive clipboard on explicit user action; older versions were vulnerable | iOS 14+: apps notified when reading clipboard | |
| Side-channel (cache timing, Spectre) | Theoretically possible; ARM Spectre mitigations partial | Same, plus additional hardware mitigations on Apple Silicon | |
| IPC eavesdropping (Intents, etc.) | Implicit broadcast Intents resolved in API 26+; explicit Intents are strongly scoped | IPC via XPC is capability-gated | |

### B.3 Secure Key Storage

**Android Keystore**
- Private keys generated with `PURPOSE_SIGN` never leave the secure hardware (StrongBox on Pixel 6+, TEE on earlier devices).
- Even a compromised app process cannot extract raw key material — it can only ask the hardware to sign a payload.
- Keys can be bound to biometric authentication, requiring fresh user verification per use.

**iOS Secure Enclave**
- Same model: keys generated inside the Secure Enclave are never exported.
- The Secure Enclave is a physically separate processor with independent firmware; compromise of the main CPU does not expose key material.
- Supports biometric binding (`kSecAccessControlBiometryCurrentSet`).

### B.4 Threat Model for a Midnight Wallet App

| Threat | Android | iOS | Mitigation |
|---|---|---|---|
| Malicious co-installed app reads `sk_device` | Low (UID isolation) | Very low (container isolation) | OS sandbox; no action needed |
| Malicious app intercepts proof witness in memory | Low | Very low | Separate address spaces |
| Accessibility service reads mnemonic from screen | Medium (user must grant) | Low (restricted) | Do not display mnemonic after initial setup |
| User grants screen recording to malicious app | Medium | Low | UX guidance; not an OS flaw |
| Physical access + forensics on unlocked device | High | Medium (Secure Enclave limits key extraction) | Out of scope for app sandboxing |
| Rooted / jailbroken device | Full compromise | Full compromise | Cannot defend at app level |

### B.5 Relevance to Midnight Contract Secrets

**Mnemonic phrase**: the most sensitive item. If stored encrypted on disk (as implemented in the local-tee-poc with OpenPGP AES-256), the plaintext exists only briefly in the app's address space. No other app can read it.

**`sk_device`**: currently derived in-process from the mnemonic via HKDF (stub TEE). On a production path, it would be generated inside the Secure Enclave or StrongBox and never exported — the hardware performs signing operations in response to requests without revealing the key. The stub is acceptable under the app sandbox on unrooted devices.

**Proof witness package**: lives briefly in memory during the `/prove` call. The sandbox prevents other apps from accessing this.

**Identity commitment (PII hash)**: stored in LevelDB in the app's private data directory, inaccessible to other apps.

**Summary:** On a stock (non-rooted/non-jailbroken) device, app sandboxing is strong enough that a Midnight wallet app handling `sk_device` and proof witnesses in process memory is not meaningfully weaker than a desktop wallet. The primary residual risks are the app's own supply chain (malicious SDK dependency) and the user granting dangerous permissions (Accessibility, screen recording). The production TEE improvement — `sk_device` generated inside the Secure Enclave and never exported — eliminates the last in-process exposure, complementing rather than substituting for the OS sandbox.

### B.6 GrapheneOS: Additional Hardening Beyond Stock Android and iOS

GrapheneOS is a security-hardened AOSP fork targeting Google Pixel hardware. It adds several layers directly relevant to Midnight wallet secrets.

**hardened_malloc** — a drop-in heap allocator replacement providing strong probabilistic protection against use-after-free, double-free, and buffer overflow exploits: randomised chunk placement, guard pages, and chunk quarantine. Makes extracting secrets from heap memory substantially harder than on stock Android or iOS, even for a compromised process or malicious library loaded in-process.

**Memory Tagging Extension (MTE) — Pixel 8 and newer** — hardware-level memory tagging, enabled by default on GrapheneOS (disabled on stock Android due to performance overhead). Detects memory safety violations at hardware speed. A heap spray or use-after-free attack targeting in-process secrets that would silently succeed elsewhere is caught deterministically here.

**Network permission revocation** — GrapheneOS allows revoking the `INTERNET` permission from any app, including those that declared it at install time. Stock Android treats `INTERNET` as non-revocable. A proof server app can therefore be configured to accept only loopback connections, eliminating remote exfiltration of witness packages entirely.

**Exec-based app spawning** — stock Android forks all app processes from a shared Zygote, which can leak pre-fork process state. GrapheneOS supports exec-based spawning, giving each app a clean address space and reducing timing side-channels and cross-app state leakage.

**Auto-reboot to BFU (Before First Unlock)** — configurable idle reboot (default 18 hours). After reboot the device returns to BFU state: full-disk encryption keys are not loaded, biometric auth is disabled, and any secrets that were in RAM are gone. Significantly limits the forensic window for an unattended device.

**Comparison across platforms**

| Property | Stock Android | iOS | GrapheneOS |
|---|---|---|---|
| App memory isolation | Strong (Linux UIDs) | Strong (XNU MAC) | Strong + hardened_malloc + MTE |
| In-process heap exploitation | Moderate | Moderate (PAC helps) | Strong (hardened_malloc + MTE) |
| Hardware key storage | StrongBox (Pixel 6+) | Secure Enclave | StrongBox (same hardware) |
| Network permission granularity | Cannot revoke INTERNET | Entitlements at build time only | Per-app revocation at runtime |
| Supply chain control | Moderate (sideloading allowed) | Strong (App Store review) | Same as AOSP (user responsibility) |
| Idle reboot to BFU | Not built-in | Not built-in | Configurable, default 18 h |
| Pointer authentication (PAC) | Partial (device-dependent) | Broad (A12+) | Partial (Pixel hardware-dependent) |

**Relevance to Midnight wallet deployment on GrapheneOS:**
- `sk_device` and proof witnesses in heap memory are substantially harder to extract via exploitation (hardened_malloc + MTE).
- Auto-reboot to BFU prevents secrets from persisting in RAM on an idle device.
- A dedicated proving device can run the proof server with `INTERNET` revoked, so witness packages can only be served to loopback clients — eliminating remote exfiltration even if the server process is compromised.
- iOS retains advantages in supply chain control (App Store review) and ecosystem-wide PAC deployment. GrapheneOS on Pixel 8+ is the strongest option for an Android-based Midnight wallet, and in the specific area of heap exploitation protection compares favourably with iOS.

### B.7 Android Virtualization Framework (AVF) Protected VMs for the Proof Server

The Android Virtualization Framework (AVF), available on Pixel 6+ with Android 13+, introduces **Protected Virtual Machines (pVMs)** — a mechanism for running arbitrary code in a hardware-isolated environment with DICE-based remote attestation. This is the most practical path to a TEE-attested proof server on a consumer Android device.

**What AVF pVM provides:**
- **Arbitrary Linux ARM64 execution**: Microdroid (the pVM guest OS) is a minimal Linux environment. The static musl `midnight-proof-server` binary runs directly without modification.
- **Full device CPU performance**: the pVM runs on the same physical cores via ARM Stage 2 virtualisation; proving times are identical to native (§Mobile Proof Server Capability above).
- **Sufficient memory**: pVMs can be allocated several hundred MB; the proof server requires ~100–200 MB (binary + proving keys + FFT working memory), well within range on any Pixel 6+ device.
- **DICE attestation**: the pVM attestation certificate covers the hash of the entire VM image, including the proof server binary. A remote client can verify the code measurement before sending a witness package — satisfying the remote attestation requirement described in §Proof-Server Trust Model.
- **vsock transport**: pVMs communicate with the host Android process via `virtio-vsock`; the proof server's TCP listener inside the VM is proxied through vsock to the host app.

**Architectural split:**

```
Host Android app
├── UI, wallet sync, UTXO management
├── StrongBox: P-256 device key  (or process memory for Jubjub)
└── vsock client → pVM

pVM (Microdroid, DICE-attested)
├── midnight-proof-server  (static musl ARM64 binary)
├── proving keys  (bls_midnight_2p*, *.prover)  via virtual block device
└── optional: sk_device (Jubjub) — generated here, non-extractable within VM boundary
```

Keeping `sk_device` inside the pVM is particularly attractive because StrongBox does not support Jubjub curve operations (only NIST P-256/P-384). The pVM can generate and use a Jubjub key natively while the DICE certificate covers both the key management code and the proof server in a single attestation.

**Comparison of mobile proving options:**

| Approach | Jubjub native | Code attestation | In-process exposure | Consumer device |
|---|---|---|---|---|
| Process memory (current stub) | Yes | No | Yes | Yes |
| StrongBox | No (NIST only) | Key attestation only | No | Yes |
| AVF pVM (Pixel 6+, Android 13+) | Yes | Yes (DICE) | No | Yes |
| SGX (remote server) | Yes | Yes (DCAP) | No | Server only |
| TrustZone custom TA | Yes | Yes | No | No (OEM gating) |

**Practical challenges:**

| Challenge | Severity | Notes |
|---|---|---|
| API maturity | Medium | `android.system.virtualmachine` is stabilising across Android 13/14/15; some operations required system app privileges in earlier releases |
| VM boot latency | Low | A few seconds for Microdroid to boot; acceptable for an infrequent compliance update |
| Proving key distribution | Low | Host app caches keys normally and provides them via a virtual block device at pVM launch |
| vsock proxy plumbing | Low | One-time engineering; vsock is well-supported in Microdroid |
| Isolation strength vs SGX | Low | pVM is hypervisor-isolated (ARM Stage 2), not hardware memory-encrypted like SGX; sufficient for the realistic mobile threat model |

**Conclusion:** AVF pVM closes both open gaps in the current stub design — Jubjub support and code measurement attestation — without OEM signing authority or server infrastructure. A prototype would compile the static musl binary as a Microdroid payload, allocate the proving keys as a virtual disk, expose the proof server over vsock, and verify the DICE attestation chain from the host app before initiating a `/prove` call.
