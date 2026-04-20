# Midnight Passport — Plan

> **Date:** 2026/04/15
> **Status:** Draft
> **Audience:** Partners, collaborators, and stakeholders

---

## What Is Midnight Passport?

Midnight Passport is a user-facing identity and wallet layer for the
Midnight network. The goal: a user scans a QR code and lands on a
fully functional account — named, authenticated, ready to transact —
without ever seeing a seed phrase, a cryptographic address, or a gas
token purchase screen.

Behind that experience, the system manages key custody, zero-knowledge
proof generation, privacy-preserving credentials, and multi-device
access. The user sees none of it.

## Why This Matters

Midnight's privacy technology is powerful but hard to access directly. Today,
interacting with the network requires managing cryptographic keys,
understanding multiple address types, and navigating proof generation.
No standard exists for how wallets connect to dApps, how users prove
identity attributes without revealing personal data, or how accounts
span multiple devices. Each implementor solves these problems
independently and incompatibly.

Midnight Passport addresses this by defining a common architecture and
the standards needed to make it interoperable.

## Three Steps to Self-Custody

The path from a working product to full decentralisation has three
steps. Each step delivers a usable system. The user experience does
not change between steps — only the trust model improves.

### Step 1: MVP — Managed Signing

The user authenticates with a **passkey** (WebAuthn/FIDO2). A
**threshold signing network** holds the user's private key in a
distributed fashion — no single node ever possesses the full key. When
the user transacts, the network collaboratively produces a signature
bound to the exact transaction parameters. The signature is verified
inside a zero-knowledge proof and never appears on-chain.

An **account provider** (OAuth-like) manages user registration, device
credentials, and session tokens. An on-chain **registry contract**
maps human-readable names (`alice.midnight`) to public keys.

The user experience is familiar: passkey login, named accounts, no
seed phrases. The trade-off is custodial trust in the signing network.

### Step 2: Decentralisation and Migration

Two research streams run in parallel to remove the centralised
components introduced in Step 1.

**Stream A — Multi-device accounts.** In Step 1, the signing network
holds a single key and devices authenticate to it. This stream moves
account management on-chain: the account is represented as a **set of
authorised keys** (one per device), and any registered key can
authorise transactions via zero-knowledge proof. This reduces the role
of the account provider — device-to-account mapping is enforced by
the smart contract, not by a centralised service.

**Stream B — On-device cryptography.** Move key material onto the
user's device. The device's secure hardware (TEE) holds the private
key. Proof generation runs locally. A **decentralised recovery
protocol** replaces the signing network's implicit recovery model.
This removes the signing network entirely.

These streams are independent. Stream A can ship while the signing
network is still active. Stream B can ship with a single-device
account model. Neither blocks the other. Both must complete before
Step 3.

### Step 3: Fully Decentralised

With both streams complete, the user has full self-custody with
multi-device support. No signing network. No centralised account
provider. The user experience has not changed.

From this foundation, new capabilities can be added:

- **Privacy-preserving credentials** — selective disclosure of
  identity attributes (age, residency, accreditation) via
  zero-knowledge proofs, without revealing personal data
- **KYC and compliance** — verifiable credentials issued by trusted
  third parties, usable across dApps without re-verification
- **Cross-chain operations** — intent-based transactions that span
  multiple networks from a single account

These are additive features that build on top of the decentralised
account model. They do not require further changes to the custody
architecture.

```
    Step 1: MVP
    (managed signing)
            │
            ▼
    Step 2: Decentralisation
    ┌───────┴───────┐
    │               │
    ▼               ▼
 Stream A        Stream B
 Multi-device    On-device
 accounts        cryptography
    │               │
    └───────┬───────┘
            │
            ▼
    Step 3: Fully Decentralised
    (self-custody + multi-device)
            │
            ▼
    + Credentials, KYC,
      cross-chain
```

## What Needs to Be Built

### 1. Threshold Signing Service

A federated network of nodes that collectively generate and hold user
keys via distributed key generation. Nodes collaboratively sign
transactions without any node ever seeing the full private key. The
signature scheme is chosen to be efficient inside Midnight's
zero-knowledge proving system.

**Status:** Signature verification validated end-to-end inside a
Compact circuit on a local devnet. Threshold protocol integration not
yet tested.

### 2. Account Provider

An OAuth-like service for user registration, passkey verification, JWT
issuance, and device management. Handles the device-addition ceremony
(QR code exchange between existing and new device).

**Status:** Design only. No implementation.

### 3. Name Registry

An on-chain smart contract that maps human-readable names
(`alice.midnight`) to public keys and address records. Includes
commit-reveal registration to prevent front-running, multi-address
resolution (shielded, unshielded, fee token), and anti-abuse
mechanisms.

**Status:** Design only. No on-chain name registry exists on Midnight
today.

### 4. Multi-Key Account Contract

A smart contract that represents an account as a set of authorised
keys (Merkle root of a key set). Supports adding, removing, and
rotating device keys. Supports scoped "function-call" keys for dApp
authorisation with limited permissions.

**Status:** Design only. Midnight accounts are currently single-key.

### 5. dApp-Wallet Connection Protocol

A formal interface between dApps and wallets, covering wallet
discovery, session authorisation with privacy scopes, asynchronous
proof coordination, credential disclosure, and sign-in. This is the
equivalent of Cardano's CIP-30 — the interface that the ecosystem
builds against.

**Status:** Midnight has an early dApp connector API. No formal
standard exists for privacy scoping, proof lifecycle, or credential
proofs.

### 6. Privacy-Preserving Credential System

A standard for issuing and verifying identity credentials (age,
residency, accreditation) using Midnight's attestation tree mechanism.
Users prove attributes via zero-knowledge proofs without revealing
personal data. Includes nullifier-based reuse prevention and
credential lifecycle management (issuance, expiration, revocation).

**Status:** The attestation tree primitive exists at the platform
level. No standard for credential types, domain separators, nullifier
construction, or issuer interoperability.

### 7. Onboarding SDK

A developer-facing SDK that collapses the entire onboarding flow (QR
channel, key generation, wallet derivation, name registration, fee
subsidisation, credential issuance) into a single API call. Ensures
consistent user experience across all dApps.

**Status:** Design only. No SDK exists.

## Standards Required

Midnight has an improvement proposal process, but no MIPs have been
written yet. The following standards are needed for interoperability.
Without them, each implementor builds incompatible solutions.

| Standard | Gap | Depends on |
|----------|-----|------------|
| **Key Derivation Paths** | 1AM and Lace implement derivation internally but no public spec exists. Third-party wallets cannot derive compatible keys. | — |
| **Address Format** | No canonical encoding for Midnight's three address types. | Key Derivation |
| **Naming System** | No on-chain name registry or resolution protocol. | Address Format |
| **Multi-Key Account Model** | No standard for multi-device accounts or scoped dApp keys. | Naming System |
| **dApp-Wallet Connection** | No formal equivalent to CIP-30 with privacy scoping and proof coordination. | Account Model |
| **Credential Standard** | No interoperable format for privacy-preserving credentials. | Account Model |
| **Threshold Signing** | No spec for the MVP's distributed signing protocol on Midnight's native curve. | Address Format |
| **Onboarding SDK** | No standard API for dApp onboarding flows. | Connection + Signing |

**Priority:** The dApp-wallet connection protocol and the credential
standard are the highest priority — they define how the ecosystem
plugs together and what makes Midnight Passport distinctive. Key
derivation and address format are prerequisites but are smaller
specifications that can be extracted from existing implementations.

## What We Are Asking Of Partners

1. **Review the architecture** — does the three-layer approach
   (managed signing → multi-device → self-custody) work for your use
   cases?
2. **Co-author standards** — the connection protocol and credential
   standard in particular benefit from input from wallet developers,
   dApp builders, and credential issuers.
3. **Identify gaps** — what does your integration need that is not
   covered here?

## Open Questions

1. **Standards process** — should Midnight adopt its own improvement
   proposal process (MIPs), extend Cardano's CIP process with a
   Midnight category, or use another governance model?
2. **Account provider federation** — for production, the account
   provider should not be a single point of failure. How should it be
   decentralised?
3. **Regulatory posture** — a federated custodial model may trigger
   regulatory requirements depending on jurisdiction.
4. **Credential issuer diversity** — the design currently references
   a single credential issuer. The standard must support multiple
   issuers from the start.

---

*ARC — Input Output Global, 2026/04/15*
