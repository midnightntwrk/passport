# 👱🤖 TEE as an Alternative Proof Path for Midnight Features

**Date:** 2026-04-08
**Context:** NEARFall feasibility study — evaluating where TEE attestation can serve as a fast-path substitute for ZK proofs in Midnight, independently of the MPC/chain-signing use case covered in [`tee-cheat-codes.md`](./tee-cheat-codes.md).

---

## Summary

TEE attestation can play two distinct roles in Midnight. The first — a TEE-attested remote proof server — is available without protocol changes but does not eliminate ZK and does not solve the mobile proving problem. The second — TEE attestation as a first-class alternative to ZK proofs for certain operations — requires a Midnight protocol change but would unlock mobile participation, remove circuit complexity limits, and enable a "fast-path" for features where ZK circuits are prohibitively expensive or not yet built. The two proof modes (ZK and TEE) are complementary, not competing: ZK remains the stronger guarantee for core privacy primitives; TEE is the pragmatic fast path for everything ZK cannot yet cover.

---

## 1. Two Distinct TEE Roles

It is important to separate two architecturally different uses of TEE in the Midnight context:

| Role | What the TEE does | Protocol change required? | Eliminates ZK? |
|---|---|---|---|
| **TEE-attested remote proof server** | Protects witnesses sent to a remote prover; ZK proof still generated inside enclave | No | No |
| **TEE attestation as alternative proof mode** | Replaces the ZK proof entirely for certain operations; on-chain verifier checks attestation | Yes — validator must accept attestations | Yes (for those operations) |

These are often conflated. The remainder of this document addresses both but treats §3 as the more strategically significant option.

---

## 2. TEE-Attested Remote Proof Server

**The problem it solves.** The Midnight local proof server generates ZK proofs client-side. This works on desktops and high-end laptops but may be impractical on mobile devices or in browser contexts due to compute and memory constraints.

**What TEE adds.** A remote proof server running inside a TEE enclave:
- Accepts private witnesses from the client over an encrypted channel.
- Generates the ZK proof inside the enclave (private inputs never touch the host OS).
- Produces a remote attestation certificate: a signed, hardware-rooted proof that the correct prover code ran unmodified and that inputs were not logged or exfiltrated.
- Returns the ZK proof and attestation to the client.

The on-chain privacy guarantee is unchanged — validators still verify a ZK proof. The TEE attestation improves the trust relationship between the client and the remote proving service, replacing "trust our privacy policy" with "verify our attestation chain."

**Mobile limitation.** The TEE on a mobile device (ARM TrustZone, Apple Secure Enclave, Google Titan) cannot run the proof server directly. These enclaves have ~16–64 MB of secure memory and are designed for key operations, not polynomial arithmetic. A BLS12-381 PLONK prover is orders of magnitude too compute- and memory-intensive for TrustZone. The TEE-attested **remote** server can serve mobile clients; the TEE on the mobile device itself cannot replace the prover.

---

## 3. TEE Attestation as an Alternative Proof Mode

**The more significant option.** If Midnight's validator logic were extended to accept TEE attestations alongside ZK proofs, the computational flow changes:

```
Current (ZK):  Client computes → generates ZK proof → chain verifies proof
TEE mode:      Client computes inside enclave → generates attestation → chain verifies attestation
```

For this to work on-chain, Midnight validators would need:
1. A registry of accepted enclave code hashes (analogous to a ZK circuit's verifying key).
2. Support for attestation verification for specific TEE platforms (SGX, SEV-SNP, TrustZone).
3. A policy distinguishing which operations may use TEE attestations vs. which require ZK proofs.

**Mobile viability.** Unlike the remote prover case, TEE-as-proof-mode enables genuine mobile participation: the attestation produced by a mobile device's secure enclave is small (a few KB, comparable to a ZK proof) and the enclave need only run the application logic — no polynomial arithmetic required. ARM TrustZone attestation infrastructure is less standardised than Intel SGX or AMD SEV-SNP, requiring more integration effort, but is technically feasible.

---

## 4. Midnight Features Suited to a TEE Fast Path

The features most likely to benefit from TEE-as-proof-mode are those where ZK circuits are absent, prohibitively expensive, or statically bounded in ways that rule out the required computation:

| Feature | ZK difficulty today | TEE fast-path value |
|---|---|---|
| Complex Compact contract logic exceeding circuit bounds | High — circuits must be statically bounded; unbounded computation is inexpressible | TEE removes the static circuit size constraint entirely |
| ZK-unfriendly hash functions (SHA-256, AES, keccak) | High — expensive in arithmetic circuits | Native to any processor; cheap in an enclave |
| Arbitrary iteration and recursion | Blocked — Starstream/Nightstream targets this but is not production-ready | Unconstrained in a TEE |
| Regulatory compliance / selective auditor access | Awkward — ZK proves a fact without revealing data; auditors may need to inspect data | Auditor sees data inside attested enclave; data never becomes public |
| Complex private state queries | Moderate | TEE-attested query service with attestation as the trust anchor |

These correspond directly to the features Charles Hoskinson described as candidates for TEE "cheat codes" — capabilities that are needed in the near term but whose ZK circuit equivalents are months or years away.

---

## 5. Mobile Viability Summary

| TEE application | Mobile viable? | Notes |
|---|---|---|
| TEE-attested remote proof server | No (for proving) — Yes (as client) | Mobile client delegates proving to remote TEE; cannot run prover inside its own enclave |
| TEE attestation as proof mode | Yes | Mobile enclave runs application logic, produces attestation; no prover required |
| Key management / wallet security | Yes (native) | Secure key storage and signing already available on all modern mobile TEEs; no protocol changes needed |

The key management case is available immediately without any Midnight protocol changes and is the most tractable near-term improvement for mobile wallet security.

---

## 6. The Layered Model: ZK and TEE as Coexisting Proof Modes

If Midnight were extended to accept TEE attestations, the two proof modes would coexist rather than compete:

| Operation | Recommended proof mode | Rationale |
|---|---|---|
| Core privacy primitives (ZSwap, contract state hiding, spending keys) | ZK | Mathematical guarantee; no hardware trust assumption acceptable for the foundation |
| Complex or ZK-unfriendly contract logic (fast-path features) | TEE | Circuit does not exist or is too expensive; TEE delivers the capability now |
| Remote proof generation (mobile clients) | TEE-attested remote prover (ZK output) | Protects witnesses without protocol change |
| Mobile-native transaction submission | TEE attestation | No local prover required |

This mirrors the trajectory of other privacy systems: deploy conditional-trust mechanisms first to ship features, then replace them with mathematical guarantees as the ZK infrastructure matures. Zcash's evolution from trusted-setup SNARKs through Sapling to Orchard is the canonical precedent.

---

## 7. Outstanding Questions

1. **Protocol change scope.** What is the minimum change to Midnight's validator and consensus layer to support attestation verification alongside ZK proof verification? What is the weight/fee model for attestation verification vs. ZK proof verification?
2. **Platform selection.** Which TEE platforms would be accepted? Intel SGX has supply chain concerns and was discontinued on consumer chips. AMD SEV-SNP and AWS Nitro Enclaves have better operational records for server deployment. ARM TrustZone is ubiquitous on mobile but less standardised for remote attestation.
3. **Enclave code governance.** Who controls the registry of accepted enclave code hashes? How are upgrades authorised? This is the governance analogue of the ZK trusted-setup ceremony.
4. **Failure mode policy.** A compromised enclave exposes only that node's secrets, not past privacy globally. But for a mobile device: if the device's TEE is compromised, what is the recovery path for keys and private state?
5. **Interaction with Compact's static circuit model.** TEE-mode operations bypass the circuit system entirely. How are Compact contracts that mix ZK-proven and TEE-attested steps authored, typed, and audited?

---

## 8. Device Key Registration Pattern

Rather than verifying a full TEE attestation certificate chain inside a Compact circuit (expensive — requires foreign-field arithmetic over non-native curves), the attestation verification can be separated into a one-time registration step and cheap per-transaction signature verification.

### 8.1 Two-Phase Design

**Registration (once per device):**

```
Mobile TEE generates a signing key pair
        │
        ▼
TEE produces attestation:
  (enclave_code_hash, device_public_key, hardware_signature)
        │
        ▼  [expensive — done once, off-chain]
Oracle or relayer verifies attestation certificate chain
        │
        ▼
Posts (user_account, device_public_key, enclave_code_hash)
to registry Compact contract
```

**Subsequent transactions (every time):**

```
Mobile TEE runs computation, signs result with registered key
        │
        ▼  [cheap — standard signature verification in Compact circuit]
Compact contract: verify signature against registered device key → accept
```

The expensive certificate chain verification happens once at registration, off-chain. After that, the contract performs only standard signature verification — tractable in a ZK circuit.

### 8.2 Key Type Selection

The choice of signing key determines the per-transaction circuit cost:

| Key type | In-circuit verification cost | Notes |
|---|---|---|
| BLS12-381 | Trivial — native to Midnight's circuit | TEE must generate this in software inside the enclave; hardware enclaves don't offer it natively |
| secp256k1 | Moderate — foreign-field arithmetic | Midnight likely has relevant infrastructure from chain abstraction work |
| Ed25519 | Moderate — foreign-field arithmetic | Well-studied; used in NEAR, Solana |
| P-256 | Expensive — foreign-field arithmetic | Apple Secure Enclave's native curve; Ethereum addressed this with RIP-7212 precompile |

Optimal design: have the TEE generate a BLS12-381 key pair in software inside the enclave, attest to the public key at registration, and use that key for all subsequent signing. On-chain verification is then native — no foreign-field arithmetic. The hardware attestation at registration proves the key was generated inside a specific enclave; subsequent signatures prove the TEE is involved because the private key never leaves the enclave.

Practical constraint: hardware enclaves (TrustZone, SGX, Secure Enclave) do not natively generate BLS12-381 keys. A software layer inside the TEE is required, which adds engineering effort but is feasible.

### 8.3 Global vs. Per-User Registry

| | Global registry contract | Per-user registry (in user's Compact contract) |
|---|---|---|
| Composability | High — any contract can check a registered key | Low — contracts must call into the user's personal registry |
| Governance | Central authority manages accepted enclave code hashes | User-sovereign — each user decides which enclaves they accept |
| Key rotation policy | Centralised | User-managed |
| Privacy | Public mapping of user → device key | Can be kept in private Compact state — observers cannot link device to user |
| Blast radius on compromise | Registry compromise affects all users | Per-user compromise is isolated |

A two-tier design is natural: a **global registry of accepted enclave code hashes** (governance-controlled, updated when enclave code is audited), combined with **per-user device key registration** within a personal Compact contract. The global registry answers "is this enclave code trusted?"; the personal contract answers "is this key registered to me?"

### 8.4 Trust Assumptions at Each Stage

| Stage | What must be trusted | Trust type | Mitigation |
|---|---|---|---|
| **Hardware manufacture** | Chip manufacturer did not backdoor the TEE | Hardware supply chain | Multi-vendor support; independent hardware audits |
| **Firmware measurement** | Firmware correctly measures enclave code at boot | Firmware supply chain | Open-source enclave code; independent builds |
| **Enclave code hash registry** | Governance body correctly approves accepted enclave hashes | Institutional / governance | DAO or multisig governance; public enclave code audits |
| **Registration oracle** | Oracle correctly verifies the attestation certificate chain | Operational / institutional | Multiple independent oracles; oracle's verification logic is auditable |
| **Key generation (TEE)** | Private key was generated inside the enclave and never left | TEE hardware guarantee | Attested by the same hardware root of trust at registration |
| **Per-user registry contract** | Compact circuit correctly verifies device signatures | Mathematical | ZK proof — same trust model as all Compact contracts |
| **On-chain signature verification** | Discrete log assumption holds for the key's curve | Mathematical | Same as all Midnight ZK operations |
| **ZK fallback path** (§8.5) | KZG polynomial binding + discrete log | Mathematical | Same as all Midnight ZK operations; no hardware trust |

The registration oracle is the most sensitive trusted party in the design. It sees the raw attestation and determines which device keys enter the registry. Mitigations: require M-of-N independent oracles to agree before a key is registered; make oracle verification logic open-source and auditable.

### 8.5 Dual Path: ZK Proof or TEE Attestation

A Compact contract can accept either form of authorisation by exposing two separate circuits. The user calls whichever applies; both are ZK-proven in the normal Midnight sense (the validator verifies the proof of circuit execution). The distinction is what the circuit *checks internally*:

```
// TEE path — verifies a device signature in-circuit using EC operations
export circuit execute_tee(action: Action, device_sig: Sig): [] {
  key ← registry.get_key(user_account)     // from private Compact state
  verify_device_sig(key, device_sig, action) // EC check in-circuit
  apply_action(action)
}

// Recovery path — verifies a recovery secret in-circuit
export circuit execute_recovery(action: Action, recovery_secret: Field): [] {
  assert(persistentHash(recovery_secret) == stored_recovery_commitment)
  apply_action(action)
}
```

> ⚠️ **`verify_zk_proof` does not exist in Compact.** Compact contracts never call a proof verification function. Proof verification is handled exclusively by the Midnight validator (`pallet-kachina`) as part of accepting the transaction. The "ZK proof" in both circuits above is the proof of the circuit's own correct execution, generated by the proof server and verified by the validator — not an argument the contract inspects.

**Recovery from device loss:** the user calls `execute_recovery` with their recovery secret (set up at wallet initialisation, independent of the device). No device registration is needed. The recovery secret's commitment is stored in private Compact state — observers never see it. The two circuits are fully independent.

**Trust implications of the dual path:**

| Path | Hardware trust required? | Prover required on device? | Recovery if path fails |
|---|---|---|---|
| ZK proof (standard) | No — mathematical only | Yes (can delegate to remote prover) | Always available from seed material |
| TEE attestation | Yes — hardware manufacturer + oracle | No — enclave signs; no ZK prover needed | Fall back to ZK path |

The dual-path design means that TEE attestation is a **convenience and capability enhancement** (enabling mobile participation, removing circuit limits) rather than a single point of failure. A user who loses their device is never locked out; they simply use the ZK path until they re-register a new device.

This pattern is closely analogous to WebAuthn / FIDO2 (hardware authenticator key + password backup), and to Ethereum ERC-4337 smart contract wallets that accept both passkey signatures and traditional ECDSA recovery keys.

---

## 9. Privacy Analysis of the Dual-Path Design

### 9.1 What the Application Contract Leaks

Midnight's private contract state is always ZK-proven regardless of which authorisation path is used. The Compact compiler generates a ZK circuit for the entire state transition; private witnesses (action content, old and new private state) never appear on-chain. What an observer can see is:

- The fact that a transaction occurred with this contract (always visible)
- The **public inputs** to the contract call — which, on the TEE path, may include `device_id` and `signature`

The action content and the contract's internal private state are not leaked. The linkability risk is specifically that `device_id`, if passed as a public input, becomes a stable on-chain pseudonym: all transactions authorised by the same device can be correlated. This is a metadata leak about *who authorised*, not about *what was authorised*.

If `device_id` is a private witness instead, the linkability disappears on-chain — but the circuit must then verify the signature in ZK, which reintroduces the proving overhead the TEE path was designed to avoid. There is no free middle ground: either the device identity is observable, or ZK work is required to hide it.

### 9.2 Which Parts of the Application Contract Involve ZK Circuits?

In Midnight, **all contract state transitions involve a ZK circuit** — the Compact compiler generates one for every function call. What varies is which inputs are public (visible) and which are private witnesses (hidden):

| Element | Public input (visible on-chain) | Private witness (hidden) |
|---|---|---|
| `device_id` | If passed as public argument | If passed as private witness (requires ZK signature verification) |
| `signature` | If passed as public argument | If passed as private witness |
| Action content | Only if explicitly surfaced | If kept as witness material |
| Old private contract state | Never | Always a witness |
| New private contract state | Never | Always a witness |
| ZSwap nullifiers / commitments | Nullifiers appended to public set | Note values and keys remain witnesses |

On the **ZK path**, the proof itself is witness material — no external identifier appears at all, and the circuit designer controls exactly what public outputs are exposed.

On the **TEE path**, the circuit's job is narrower: verify that the public signature is valid and that the state transition is consistent with the signed result. If `device_id` and `signature` are public inputs and the action content is derivable from them, the circuit may need no private witnesses beyond what is already public.

### 9.3 Proof Server Requirements by Path

The separation of application logic (handled by the TEE) from private asset operations (handled by ZSwap) determines what private material the proof server must access:

**For the TEE path's authorisation step:** if `device_id`, `signature`, and the claimed result are all public inputs, the proof server inputs are entirely public. A non-private (unatteested) proof server is sufficient — there is nothing private in its inputs.

**For ZSwap / private asset operations:** spending keys, note values, and nullifier preimages are always private witnesses. Any transaction that moves private assets still requires a proof server with access to those witnesses, regardless of whether the application logic was TEE-handled.

The ZSwap component and the application logic component are independent. A transaction can include both; the proof server's privacy requirement is determined by the ZSwap component alone.

### 9.4 Mobile Proof Server Capability

**The ZSwap prover cannot run inside the mobile TEE.** This is a hard constraint, not a performance trade-off. ARM TrustZone's secure world has approximately 16–64 MB of total memory, shared with all trusted applications on the device. A BLS12-381 PLONK prover requires hundreds of megabytes for polynomial operations and MSM tables even for a small circuit. The memory gap is not closable by optimisation.

Additionally, TrustZone's secure world typically lacks access to SIMD/vector instructions (NEON is a normal-world feature on many implementations), making field arithmetic slower than the already-borderline estimates for the normal world.

**For the normal-world mobile processor** (outside the TEE):

| Circuit type | Approximate proving time on flagship mobile | Feasibility |
|---|---|---|
| TEE-only application logic (public inputs, minimal circuit) | < 1 second | ✅ Fully feasible |
| ZSwap note transfer (small fixed circuit) | ~5–20 seconds | ⚠️ Borderline; acceptable for payments |
| Complex private contract logic (large circuit) | Minutes or longer | ❌ Not feasible |
| TEE application logic + ZSwap (combined) | ~5–20 seconds (ZSwap dominates) | ⚠️ Borderline |

Running the ZSwap prover in the normal world means the witness package (including `sk_in`) leaves the TEE and enters the host OS — which is precisely what the TEE was meant to prevent.

**Constructing the witness package is feasible inside the mobile TEE.** The required operations — a handful of Jubjub EC point multiplications, hash evaluations, and Pedersen commitment constructions — are field arithmetic with no FFT or large MSM. Working memory is well under TrustZone's 16–64 MB and total computation is under 100 ms. The TEE generates all private witness material internally; only the prover step is offloaded.

**The mobile TEE's role in the complex (ZSwap) case** is therefore: trusted local environment for business logic and witness generation; verifier of the proof server's work. After receiving the ZK proof, the TEE checks that its public inputs (amount_commitment, P, R, nullifier, cm_out) match what the TEE itself computed, and may optionally run full BLS12-381 proof verification (≈6 ms). The transaction is signed only if verification passes.

**The natural architectural resolution** is a TEE-attested remote proof server (§2): the mobile TEE holds all private wallet material, encrypts the witness package to the remote server's attestation key, and the server's enclave decrypts, proves, and discards. `sk_in` is never in plaintext outside a TEE at any point in this flow.

The TEE-attested remote proof server is therefore not an optional upgrade for mobile wallets — it is the architecturally correct complement to the mobile TEE. The two TEEs together cover the full transaction lifecycle without plaintext exposure of private material.

### 9.5 dApp Categories and Proof Server Requirements

| dApp category | Examples | Private proof server required? | Mobile feasible? |
|---|---|---|---|
| **Pure computation, fee only (DUST)** | Gaming moves, voting, AI inference, identity verification | **No** — DUST is unshielded/account-model; no ZSwap spending key; all circuit inputs are public | **Yes** — circuit is trivial |
| **Pure computation, no private assets** | Hash-chain verification, Web2 data proofs, ZK-unfriendly operations | **No** — TEE computes natively; result is a public signature | **Yes** — circuit is trivial |
| **Private asset transfers only** | Confidential payments, private token transfers | **Yes** — ZSwap witnesses require a trusted prover | **Borderline** — ZSwap circuit ~5–20 s on flagship |
| **TEE computation + private assets** | Private DeFi, confidential auctions with asset settlement, private gaming economies | **Yes — for the ZSwap component only**; application logic component is public | **Borderline** — only the ZSwap component drives proving cost |
| **Complex private contract logic** | Regulatory compliance with hidden rules, complex private state machines | **Yes** — large circuit with private witnesses | **No** — circuit too large without TEE optimisation |
| **Complex private contract logic with TEE** | Same as above, but TEE handles the complex computation | **Yes — for the ZSwap component only**; TEE collapses the application circuit to near-zero | **Borderline** — depends on ZSwap component only |

The practical rule: **a private proof server is required if and only if the transaction involves private Midnight assets (ZSwap nullifiers and note commitments).** Application logic, however complex, does not require a private proof server when handled by a TEE — the TEE substitutes for the private computation, and the resulting signature is a public input to a minimal circuit.

### 9.6 Are the ZK and TEE Paths Equally Private?

No. The ZK path is strictly more private:

| Dimension | ZK path | TEE path |
|---|---|---|
| On-chain pseudonym | None — no identifier required | `device_id` potentially visible; creates linkable pseudonym |
| Transaction linkability | Unlinkable by construction (no persistent identifier) | Linkable if same device key used across transactions |
| Oracle knowledge | None | Oracle knows device-to-user mapping at registration |
| Hardware trust | None | Hardware manufacturer + firmware supply chain |
| Action content | Always hidden in witnesses | Hidden in witnesses (same as ZK path) |
| Private state | Always hidden | Always hidden (same as ZK path) |

The TEE path trades unlinkability for convenience and capability. It is appropriate for operations where the linkability is acceptable — a user already identified by their account, or operations where transaction correlation is not a concern. It is not a privacy-equivalent substitute for the ZK path in contexts where unlinkability matters.

The honest characterisation: **the TEE path offers Midnight's full data privacy (action content and private state are never revealed) but weaker metadata privacy (device identity may be observable).** The ZK path offers both.

---

## 10. TEE as Decision Engine, ZK as Asset Movement Engine

### 10.1 The Pattern

The TEE and ZK circuit have naturally complementary roles that, when separated cleanly, give the TEE access to arbitrary logic while preserving the full privacy of private asset movements:

- **TEE (decision engine):** runs application logic of any complexity; produces a signed public authorisation stating what should happen — amount, recipient, conditions. Never holds spending keys or note data.
- **ZK circuit (asset movement engine):** takes the TEE's public authorisation as a public input alongside private ZSwap witnesses; proves the authorisation is valid *and* the assets are correctly moved. Never sees the application logic.

```
TEE (mobile)                        ZK circuit (any prover)
────────────                        ────────────────────────
Arbitrary application logic         Public inputs:
        │                             TEE signature
        ▼                             nullifier
Signed authorisation:                 output commitments
  (amount, recipient,               Private witnesses:
   conditions, nonce)                 spending key
        │                             note preimage
        ▼                             Merkle proof
  public input          ──────────▶  Proves:
                                       TEE sig valid ✓
                                       note correctly spent ✓
                                       outputs match authorisation ✓
```

The TEE's application logic complexity has zero impact on the proof server's witness set or proving time. Whatever the TEE computed, the proof server sees only a signature and standard ZSwap material.

### 10.2 Binding TEE Authority to Asset Constraints

A **budget commitment** stored in private Compact state binds the TEE's signing authority to specific asset constraints without revealing them on-chain:

```
C = Commit(max_amount, asset_type, authorized_counterparties, tee_public_key)
```

Created once when the user configures the TEE's authority. The ZK circuit proves all of the following simultaneously:

1. The TEE signature is valid for the authorised `tee_public_key` in the commitment
2. Payment amount ≤ `max_amount` (from the commitment preimage — not revealed)
3. Recipient is within `authorized_counterparties` (from the commitment preimage — not revealed)
4. The note is validly spent: nullifier correctly derived from known preimage in the commitment tree
5. Output commitments are correctly formed for the authorised amount and recipient

Public inputs: TEE signature, nullifier, output commitments, the budget commitment (opaque hash).
Private witnesses: spending key, note preimage, Merkle proof, budget commitment preimage.

The TEE holds none of the private witnesses. The proof server holds none of the application logic or TEE state.

### 10.3 Proof Server Witness Set is Always ZSwap-Standard

The proof server's private inputs are identical to a standard ZSwap payment regardless of what the TEE computed. They are:

- **Fixed and bounded** — determined by the ZSwap circuit, not by application logic
- **Independent** — the TEE's signed output is just one more public input; it adds no new private data
- **Familiar** — the same witnesses a regular private payment already requires

This means the private proof server problem for the TEE path is exactly the private proof server problem for any private payment — no harder, no larger. The full separation is:

| Role | Runs where | Holds | Never sees |
|---|---|---|---|
| Decision engine | Mobile TEE | TEE signing key, application state | Spending key, note values, note randomness |
| Asset movement engine | Any prover | Spending key, note preimage, Merkle proof | Application logic inputs, TEE state |

### 10.4 Revised Proof Server Requirements

| Scenario | Private proof server needed? |
|---|---|
| TEE logic only, no asset movement | **No** — all circuit inputs are public |
| TEE logic + private asset movement (ZSwap) | **Yes — for ZSwap witnesses only**; same as a standard private payment |
| ZSwap circuit feasible locally on device | **No** — run the ZSwap proof locally; ~5–20 s on flagship mobile |
| ZSwap delegated to cloud | **Yes** — TEE-attested proof server; witnesses encrypted in attested channel |

The TEE path cleanly contains the private proof server requirement to a small, well-defined, application-logic-independent task. A TEE-attested remote proof server is sufficient; the server never needs to know what the TEE computed.

---

## 11. Hiding Recipient and Amount in TEE-Authorised Transfers

The stealth address scheme implemented in [`experiments/compact-named-accounts`](../experiments/compact-named-accounts/contracts/single-named.compact) can be applied directly to TEE-authorised transfers to hide both the recipient identity and the amount from on-chain observers.

### 11.1 Stealth Address Recap

The named account experiment registers two public keys per account on the Jubjub curve:

- `K_scan = k_scan_scalar * G` — used by senders to derive a shared secret via ECDH
- `K_spend = k_spend_scalar * G` — combined with the shared secret to form a one-time address

A sender computes a stealth address without the chain learning who the recipient is:

```
R = r * G                       (ephemeral public key — published)
S = r * K_scan                  (ECDH shared secret — sender computes; never published)
P = K_spend + H(S) * G          (one-time stealth address — only recipient can derive)
```

The recipient scans by computing `k_scan_scalar * R = S` and checking whether `P − H(S)*G` equals their `K_spend`. No observer can link `P` to the registered name without knowing `k_scan_scalar`.

**Current limitation in the PoC:** `pending_amount` is a public ledger field — the amount is disclosed in plaintext. The recipient is hidden; the amount is not yet.

### 11.2 Hiding the Recipient in a TEE-Authorised Transfer

Directly applicable. Instead of signing a plaintext recipient address, the TEE:

1. Looks up the recipient's `K_scan` and `K_spend` from the registry (both public — no private access needed)
2. Generates an ephemeral scalar `r` inside the enclave
3. Computes `P = K_spend + H(r * K_scan) * G`
4. Signs `(amount_commitment, P, R)` as the public authorisation

Observers see a one-time stealth address `P` and ephemeral key `R`. Without `k_scan_scalar` they cannot link `P` to the named recipient.

### 11.3 Hiding the Amount

The TEE commits to the amount rather than including it in plaintext:

```
amount_commitment = Commit(amount, randomness)
```

The TEE signs `(amount_commitment, P, R)`. The ZK circuit proves:

1. TEE signature is valid over `(amount_commitment, P, R)`
2. The note being spent has value consistent with `amount_commitment` — private witness
3. Committed amount ≤ `max_amount` from the budget commitment — private witness
4. Nullifier correctly derived from known note preimage
5. Output note correctly committed to `P`

In ZSwap, amounts are already private witnesses by design. The commitment seals the only remaining gap: the TEE's signed authorisation would otherwise expose the amount.

### 11.4 What Observers See

| On-chain field | Reveals |
|---|---|
| TEE signature | A TEE-authorised transfer occurred; which device (pseudonym) |
| `R` (ephemeral key) | Needed for recipient scanning; reveals nothing about identity |
| `P` (stealth address) | One-time; unlinkable to named account without `k_scan_scalar` |
| `amount_commitment` | Opaque; hides the amount |
| Nullifier | Note consumed; reveals nothing about value or owner |
| Output commitment | Note created; reveals nothing about value or owner |

Neither recipient nor amount is revealed. The only residual linkability is the TEE device signature — the pseudonym concern from §9.

### 11.5 The Full Authorisation Structure

Combining the budget commitment (§10.2), stealth address (§11.2), and amount commitment (§11.3), the TEE's signed public authorisation becomes a compact opaque triple:

```
TEE signs: (amount_commitment, P, R)

where:
  amount_commitment = Commit(amount, r_amount)   — hides the transfer value
  R = r_ephemeral * G                            — ephemeral key for recipient scanning
  P = K_spend + H(r_ephemeral * K_scan) * G      — one-time stealth address
```

The ZK circuit ties all three to the private ZSwap witnesses without any of them being recoverable from public data alone.

### 11.6 Known Compact Limitation

The Compact code in the experiment notes that `H(S) mod JUBJUB_R` cannot currently be computed fully in-circuit: `persistentHash` returns a BLS12-381 Fr element (~255-bit) but `ecMulGenerator` requires a Jubjub scalar (EmbeddedFr, ~252-bit). The circuit therefore cannot verify that `P` was correctly derived from `(r, K_scan, K_spend)`. The TEE computes `P` correctly by construction, and the recipient verifies off-chain, but in-circuit enforcement of the derivation awaits a Compact API fix. This is a tooling gap, not a fundamental cryptographic obstacle.

---

## Relationship to Other Assessments

- [`tee-cheat-codes.md`](./tee-cheat-codes.md) — parent survey covering NEAR's TEE usage, the MPC/Chain Signatures pattern, and TEE for solvers/sequencers. The remote proof server (§5.1 there) overlaps with §2 here.
- [`starstream-nightstream.md`](./starstream-nightstream.md) — the ZK path to unbounded computation (Starstream + Nightstream IVC). TEE-as-proof-mode and Starstream/Nightstream are competing approaches to the same problem: removing the static circuit bound. TEE is faster to deploy; Starstream/Nightstream is the principled long-term solution.
- [`chain-abstraction-vs-bridge.md`](./chain-abstraction-vs-bridge.md) — TEE and chain abstraction overlap only at the MPC layer (covered in `tee-cheat-codes.md §5.2`), not in the proof-mode discussion here.

---

## Sources

- [`assessments/tee-cheat-codes.md`](./tee-cheat-codes.md) — parent TEE survey; primary source for NEAR's TEE usage and the remote proof server pattern
- [`assessments/starstream-nightstream.md`](./starstream-nightstream.md) — Starstream/Nightstream as the competing ZK path to unbounded computation
- **Background 6** — Charles Hoskinson: *"Heavy use of TEE's as 'cheat codes' to add privacy quickly."* Internal (`journal/project-increment-1.md`)
- [ARM TrustZone overview](https://developer.arm.com/ip-products/security-ip/trustzone)
- [Intel SGX overview](https://www.intel.com/content/www/us/en/developer/tools/software-guard-extensions/overview.html)
- [AMD SEV-SNP](https://www.amd.com/en/developer/sev.html)
- [AWS Nitro Enclaves](https://aws.amazon.com/ec2/nitro/nitro-enclaves/)
