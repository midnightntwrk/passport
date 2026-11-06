# Knowledge Base

Dated technical observations and corrections for the ARC Passport project.
Entries apply to their stated source and toolchain; they do not override
current standards, source code, or measured evidence. Start with the
[architecture reference](arc42.md) and [documentation map](README.md).
The 2026/11/06 review corrects the threshold-signing claim below; older
platform/library observations are historical, not a current support matrix.

Entries are dated for traceability. If an entry becomes outdated, it should
be updated or removed, not left stale.

---

## Cryptographic Curves

### P-256 (secp256r1 / prime256v1)

- NIST standard elliptic curve over a 256-bit prime field.
- Used by Apple's Secure Enclave (iOS and macOS) — the **only** curve
  supported natively by Secure Enclave hardware.
- Also known as: secp256r1, prime256v1, NIST P-256.
- **Not** the same as secp256k1.

*Verified: 2026/04/09*

### secp256k1

- Elliptic curve used by Bitcoin, Ethereum, and many other blockchains.
- **Not** supported by Apple's Secure Enclave.
- Distinct from P-256 (secp256r1) — different curve parameters,
  incompatible key material.

*Verified: 2026/04/09*

### BLS12-381 (Barreto-Lynn-Scott)

- **BLS12-381 is an elliptic curve, not a signature scheme.**
- Pairing-friendly elliptic curve used by Midnight, Ethereum 2.0, and
  Zcash.
- Not natively supported by any mobile TEE hardware (Secure Enclave,
  StrongBox). Requires software implementation with AES-256-GCM key
  wrapping for TEE-based protection.
- Do not confuse with BLS (Boneh-Lynn-Shacham), which is a signature
  scheme that can operate over BLS12-381 (among other pairing-friendly
  curves).

*Verified: 2026/04/10 — confirmed by Jesus Diaz Vico (cryptographer)*

### BLS (Boneh-Lynn-Shacham) Signatures

- **BLS is a digital signature scheme, not an elliptic curve.**
- Can operate over any pairing-friendly curve, including BLS12-381.
- Natively friendly to aggregation: multiple signatures can be combined
  into a single signature that verifies against multiple public keys.
- Friendly to threshold schemes: partial signatures can be combined via
  Lagrange interpolation.
- **BLS signature verification requires pairing checks**, which are very
  costly to verify inside a SNARK/ZK circuit. This is an important
  constraint for any design that requires on-chain or in-circuit
  verification of BLS signatures.

*Verified: 2026/04/10 — confirmed by Jesus Diaz Vico (cryptographer)*

## Threshold Cryptography

### Threshold signing versus secret reconstruction

FROST participants generate signature shares using their own secret shares;
the coordinator aggregates signature shares, not the private key. Normal
FROST signing does **not** reconstruct the group private key. Threshold
signing is a multiparty computation; “threshold” does not mean
“reconstruct then sign”. See [RFC 9591, section 5](https://www.rfc-editor.org/rfc/rfc9591.html#section-5).

Reconstructing a secret for recovery is a different operation. A recovery
scheme can deliberately reconstruct a secret without implying that a
threshold-signing protocol does so. Key generation may also use a trusted
dealer; distinguish setup assumptions from signing behaviour.

*Corrected: 2026/11/06. Supersedes the 2026/04/10 claim that FROST
reconstructs the key at signing time.*

### NEAR `threshold-signatures` Crate

- Supports ECDSA (secp256k1), EdDSA/FROST (Ed25519), RedDSA/FROST
  (JubJub), and BLS12-381 (DKG only, signing hashes unimplemented).
- The ECDSA path has both "robust" and "OT-based" variants.
- The BLS12-381 support covers DKG, reshare, and refresh, but **not**
  threshold signing (hash functions are stubbed as `unimplemented!()`).
- These library-capability observations are a historical snapshot. They
  require a pinned revision before reuse; they do not imply private-key
  reconstruction during FROST signing.

*Verified: 2026/04/10*

## Platform TEE Capabilities

### Apple Secure Enclave (iOS / macOS)

- Hardware-backed TEE available on all modern Apple devices.
- Supports **P-256 (secp256r1) only** for asymmetric operations.
- Non-native curve key material (e.g. BLS12-381, secp256k1) must be
  protected via AES-256-GCM wrapping using a Secure Enclave-held
  symmetric key.

*Verified: 2026/04/09*

### Android StrongBox

- Hardware-backed keystore on certified Android devices.
- P-256 support guaranteed; additional curve support varies by hardware.
- Assume P-256 as the baseline for cross-device compatibility.

*Verified: 2026/04/09*

## Midnight Platform

### Proof System

- Midnight uses Halo2/MidnightZK for its SNARKs, over BLS12-381.
- BLS signature verification (pairing checks) inside a Compact circuit
  would be very expensive. Not viable for in-circuit authorisation.
- **JubJub is the embedded curve inside BLS12-381.** JubJub operations
  (scalar multiplication, point addition) are native arithmetic in
  Midnight's SNARK — cheap. This makes Schnorr (and FROST) on JubJub
  the natural choice for in-circuit signature verification.
- Ed25519 operations inside a BLS12-381 SNARK require non-native field
  arithmetic (different prime field: `2²⁵⁵ - 19` vs BLS12-381 Fr).
  This is prohibitively expensive — hundreds of constraints per field
  operation.

*Verified: 2026/04/10 — confirmed by Jesus Diaz Vico (cryptographer)*

### In-Circuit Signature Verification

- Any signature used as a witness in a Compact circuit **must be
  verified inside the circuit**. Otherwise, a malicious user could pass
  a forged signature and the proof would be accepted.
- **FROST (Schnorr) on JubJub** is the recommended scheme: Schnorr
  verification requires only scalar multiplications and point additions
  on JubJub, which are native operations in Midnight's constraint
  system. No pairings required.
- The existing Compact experiment (`compact-named-accounts`) uses
  `ecMulGenerator` on JubJub for key operations, confirming that JubJub
  arithmetic is available in Compact.

*Verified: 2026/04/10 — based on guidance from Jesus Diaz Vico*

### JubjubPoint Equality Bug in compact-runtime 0.15.0

- Compact's `==` operator on `JubjubPoint` is compiled to JavaScript `===`
  (reference equality), which **always returns false** for distinct objects
  even when they have identical `(x, y)` coordinates.
- This affects any circuit that compares the result of `ecMulGenerator`,
  `ecMul`, or `ecAdd` — including Schnorr signature verification.
- **Workaround**: post-compile patch the generated `index.js` to replace
  `A === B` with `((a,b)=>a.x===b.x&&a.y===b.y)(A, B)` in the assert
  expression. See `experiments/redjubjub-wallet/scripts/patch-point-eq.js`.
- This bug was not present in `compact-runtime 0.14.0` (used by the
  `local-tee-poc` experiment).
- Should be reported to the Midnight team.

*Verified: 2026/04/13 — confirmed by direct testing*
