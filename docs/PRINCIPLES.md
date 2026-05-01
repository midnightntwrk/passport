# Midnight Passport — Design Principles

The six design principles that the Midnight Passport onboarding model is
built on. Source of truth: section 2 of
[`docs/reference/machine-investigation/key-flows/secure-onboarding-design.md`](docs/reference/machine-investigation/key-flows/secure-onboarding-design.md).

This file is a summary. The detail, rationale, and threat-model context for
each principle live in the source document.

Last updated: 2026/04/27.

---

## At a glance

| Principle | Source section |
|-----------|----------------|
| Keys never leave TEEs; authorisation via ZK witnesses | [§ 2.1](docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#21-keys-never-leave-tees-authorization-via-zk-witnesses) |
| Single seed, three wallets | [§ 2.2](docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#22-single-seed-three-wallets) |
| Chain abstraction via intent model | [§ 2.3](docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#23-chain-abstraction-via-intent-model) |
| One key per device | [§ 2.4](docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#24-one-key-per-device) |
| Privacy-by-design identity | [§ 2.5](docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#25-privacy-by-design-identity) |
| Seedless user experience | [§ 2.6](docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#26-seedless-user-experience) |

---

## 1. Keys never leave TEEs; authorisation via ZK witnesses

Cryptographic key material never exists in exportable form outside a
Trusted Execution Environment. When a signing operation is needed, the seed
is decrypted into application memory for the minimum duration required,
used to derive the specific key, and then zeroised.

Authorisation maps directly onto Midnight's witness-based model: the key is
derived inside the TEE, passed as a witness to local proof generation, and
never touches the network. The blockchain node verifies the proof but
never sees the witness.

**Source.** § 2.1.

---

## 2. Single seed, three wallets

A single BIP39 mnemonic is the root of all key material. Through BIP32
hierarchical deterministic derivation following Midnight's CIP-1852 path
(`m/44'/2400'/{account}'/{role}/{index}`), this single seed deterministically
produces keys for all three wallet layers — Shielded (Zswap), Night
(NightExternal · NightInternal), and Dust — plus a Metadata role for
private contract state.

Recovery is simplified: restore the seed and every wallet layer is
restored automatically.

**Source.** § 2.2.

---

## 3. Chain abstraction via intent model

Users should not need to know which chain they are interacting with. The
user expresses an intent ("send 100 USDC to `alice.midnight`") and the
system figures out routing, fee estimation, and execution. On Midnight
itself, this resolves the dual-address complexity: a single
`username.midnight` name resolves to whichever address type the operation
needs, and the user sees neither.

Cross-chain operations are authorised via threshold MPC chain signatures
rather than separate per-chain private keys.

**Source.** § 2.3.

---

## 4. One key per device

Each device holds its own independent key pair. The account identity (the
`username.midnight` name) is decoupled from any individual key. Adding a
device generates a fresh seed in that device's TEE and registers the new
public key as an additional full-access key on the account's on-chain
record. Revoking a compromised device is a circuit call from any remaining
full-access key.

Function-call keys extend the same model to dApp authorisation: scoped,
revocable, enforced at the protocol level.

**Source.** § 2.4.

---

## 5. Privacy-by-design identity

Identity verification works without creating a surveillance infrastructure.
A trusted issuer verifies identity once and issues cryptographic
attestations encoded as leaves of a Midnight attestation tree
(`persistentHash([domain_separator, user_secret_key])`). The user holds
their secret key and Merkle proof locally.

When a service needs verification, the user provides a ZK proof of Merkle
membership. The service learns exactly one bit — eligible or not — and
records a domain-separated nullifier to prevent credential reuse. Domain
separation between the attestation leaf and the nullifier means even the
nullifier cannot be linked back to the attestation.

**Source.** § 2.5.

---

## 6. Seedless user experience

The user never sees a mnemonic phrase. The seed is generated inside the
TEE, encrypted immediately, and never displayed. Recovery goes through the
DeRec protocol: the seed is split via (3,5) Shamir secret sharing, with
encrypted shares distributed to designated helpers, and the user recovers
the account by contacting any three of five helpers — not by typing
24 words from a paper backup.

Mnemonic management — paper backups, cloud notes, phishing entry, missed
backups — is the single largest source of user error in cryptocurrency.
Removing the mnemonic from the user's awareness removes the failure mode.

**Source.** § 2.6.
