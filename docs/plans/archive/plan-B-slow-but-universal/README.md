# Midnight Passport — Plan

> **Date:** 2026/04/20
> **Status:** Draft
> **Audience:** Partners, collaborators, and stakeholders

> **Status as of 2026/04/21:** This is the architecture for **Plan B — slow but universal**, the original MVP plan. Following the 2026/04/21 stakeholder call, Plan B has been parked in favour of Plan A (decentralised but limited); see [`../plan-A-decentralised-but-limited/README.md`](../plan-A-decentralised-but-limited/README.md) for the current MVP plan. The FROST-based architecture below remains the reference for Milestone 2 (cross-chain support) and as a fallback should Plan A hit a blocking risk.

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

Midnight's privacy technology is powerful but hard to access directly.
Today, interacting with the network requires managing cryptographic
keys, understanding multiple address types, and navigating proof
generation. No standard exists for how wallets connect to dApps, how
users prove identity attributes without revealing personal data, or
how accounts span multiple devices. Each implementor solves these
problems independently and incompatibly.

Midnight Passport addresses this by defining a common architecture and
the standards needed to make it interoperable.

## The Delivery Arc

The path from today to full self-custody is staged across four named
milestones. Each is an independently demoable product. The user
experience is stable across milestones — only the trust model
underneath improves.

The full week-by-week schedule lives in the delivery plan
([`site/delivery-plan.html`](../site/delivery-plan.html)). The
summary:

### MVP 1 — end of June 2026

The user authenticates with a **passkey** (WebAuthn/FIDO2). An
***n*-of-*t* FROST threshold committee** (default n=5, t=4) holds the
user's private key via distributed key generation from day one — no
single node ever possesses the full key. The committee is operated
by a single trust party at MVP 1; federation across multiple
independent trust parties is *not* a planned milestone — custody moves
straight on-device at v2.0 Stream B.

When the user transacts, the committee collaboratively produces a
FROST (threshold-Schnorr) signature bound to the exact transaction
parameters. The signature is verified inside a zero-knowledge proof
and never appears on-chain.

An **account provider** (OAuth-like) manages user registration,
passkey credentials, and capability tokens. At MVP 1 each user has
one OAuth account with one passkey; accounts are referenced by their
raw Midnight address — human-readable names arrive at MVP 1.1.

### MVP 1.1 — multi-device, names, connection protocol

The first post-MVP beat (~90-day effort cycle). **No new crypto** —
the threshold committee, keys, and circuits are unchanged. What gets
added is user-facing:

- **Multi-device OAuth accounts** — the one OAuth account per user
  now accepts multiple passkeys, with a device-addition ceremony. The
  key in the threshold committee is still one per account. The
  device-to-account mapping is held by the account provider at this
  step; it moves on-chain at v2.0 Stream A.
- **Human-readable names** — `alice.midnight` arrives as the name
  layer. Accounts gain a name alongside their address.
- **On-chain name registry** — the names live on-chain with
  commit-reveal registration, multi-address resolution, and anti-squat
  mitigations.
- **Device-key ↔ wallet-grant CRUD** — users see, add, revoke, and
  scope which devices and which dApp connections have which grants.
- **QR onboarding returns** with channel-binding, timestamp, and
  visual-confirmation mitigations.
- **The dApp-wallet connection protocol** becomes a full MIP with
  named external co-authors.

### v2.0 — decentralisation (Stream A and Stream B, in parallel)

Two research streams run in parallel to remove the centralised
components introduced in MVP 1. Each is a ~90-day effort cycle.

**Stream A — multi-key account contract.** The account becomes a
smart-contract object on Midnight representing a *set of authorised
device keys*. Any registered device key can authorise transactions via
a ZK witness. Scoped function-call keys give dApps bounded permissions.
Delivers **principle 4 (one key per device)** in its full form.

**Stream B — on-device cryptography.** The user's key moves into the
device's trusted execution environment (Secure Enclave on iOS,
StrongBox/TEE on Android) with AES-256-GCM wrapping. Zero-knowledge
proof generation runs on-device. A decentralised recovery protocol
replaces the signing network's implicit recovery model. With Stream B
complete, the signing network retires. Delivers **principles 1 and 2**
in full.

The streams are independent — neither blocks the other — but both
must complete before v3.0.

### v3.0 and beyond — credentials, KYC, chain abstraction

With self-custody delivered, v3.0 adds the layer that needed that
foundation:

- **Privacy-preserving credentials MIP** — selective disclosure of
  identity attributes via zero-knowledge. Built on Midnight's
  attestation-tree primitive. **Multi-issuer from day one** (zkMe and
  alternatives). Delivers principle 5.
- **KYC and compliance** — verifiable credentials issued by trusted
  third parties, reusable across dApps without re-verification.
- **Cross-chain intent engine** — intent-based transactions that
  settle on Midnight, other chains, or both, from the same account.
  Delivers principle 3 in full.
- **Social account linking** and **DeRec social recovery** — additive
  features on top of the decentralised foundation.

v3.0 is additive: it requires no changes to the custody architecture
and continues the 90-day cadence.

```
    MVP 1 (end June 2026)
    n-of-t threshold signing (single operator),
    single device, address-only accounts
            │
            ▼
    MVP 1.1 (~90 days later)
    multi-device OAuth, human-readable names,
    on-chain name registry, connection-protocol MIP
            │
            ▼
    v2.0 — parallel streams
    ┌───────┴───────┐
    │               │
    ▼               ▼
 Stream A        Stream B
 Multi-key       On-device
 account         cryptography
 contract        + recovery
    │               │
    └───────┬───────┘
            │
            ▼
    v3.0 and beyond
    credentials, KYC, chain abstraction
```

## What Needs to Be Built

### 1. Threshold signing service (FROST on JubJub)

MVP 1 ships with an ***n*-of-*t* FROST threshold committee** (default
n=5, t=4) holding the user's JubJub key via distributed key generation
— no single node ever possesses the full key. The committee is
operated by a single trust party for MVP 1 and MVP 1.1; custody moves
on-device at v2.0 Stream B (no inter-party federation milestone in
between).

The signing scheme is **FROST on JubJub**, chosen because Schnorr
verification on JubJub is native arithmetic inside Midnight's SNARK.
Midnight Passport consumes the **`threshold-signatures` crate
published by the NEAR-MPC project** as a library dependency — *this
is not an integration with the NEAR blockchain or protocol*. The
crate provides FROST, DKG, key-reshare, and key-refresh out of the
box. The only cryptographic delta we add on top is a **JubjubPoseidon
ciphersuite** so the challenge hash matches Midnight's native
`persistentHash`.

**Status:** Schnorr-verification-in-a-Compact-circuit validated
end-to-end on a local Midnight devnet. Rust and TypeScript signing
sides produce identical outputs across the language boundary.
Crate-consumption strategy decided at MVP 1 Week 3; cryptographer
sign-off at Week 4; end-to-end with an in-process n=5 committee at
Week 8.

### 2. Account provider

An OAuth-like service for user registration, passkey verification,
JWT issuance with request-binding claims, and capability-token
issuance. Handles the device-addition ceremony (QR code exchange
between existing and new device) from MVP 1.1 onward.

**Status:** Design. Implementation begins at MVP 1 Week 7.

### 3. Name registry

An on-chain smart contract that maps human-readable names
(`alice.midnight`) to public keys and address records. Includes
commit-reveal registration to prevent front-running, multi-address
resolution (shielded, unshielded, fee token), and anti-squat
mechanisms.

**Status:** Design. Ships at MVP 1.1. MVP 1 holds names off-chain in
the account provider as a named compromise.

### 4. Multi-key account contract

A Midnight smart contract representing an account as a set of
authorised device keys. Supports adding, removing, and rotating
device keys. Supports scoped function-call keys for dApp
authorisation with bounded permissions (expiry, value cap, allowed
contracts).

**Status:** Design. Ships at v2.0 Stream A.

### 5. dApp-wallet connection protocol

A formal interface between dApps and wallets — wallet discovery,
session authorisation with privacy scopes, asynchronous proof
coordination, credential disclosure, and sign-in. The equivalent of
Cardano's CIP-30 for Midnight. **Our top-priority ecosystem MIP.**

**Status:** Working draft published at MVP 1 Week 7; becomes a full
MIP at MVP 1.1 with named external co-authors.

### 6. Privacy-preserving credential system

A standard for issuing and verifying identity credentials (age,
residency, accreditation) using Midnight's attestation tree
mechanism. Users prove attributes via zero-knowledge proofs without
revealing personal data. Includes nullifier-based reuse prevention,
credential lifecycle management, and **multi-issuer interoperability
from day one** (zkMe and alternatives).

**Status:** Platform primitive exists; standard to be drafted at v3.0.

### 7. On-device cryptography and recovery

Key material in the device TEE with AES-256-GCM wrapping; local ZK
proof generation; decentralised recovery (DeRec or equivalent) to
replace the signing network's implicit recovery model.

**Status:** Design. Ships at v2.0 Stream B.

### 8. Onboarding SDK

A developer-facing SDK that collapses the entire onboarding flow (QR
channel, key generation, wallet derivation, name registration, fee
subsidisation, credential issuance) into a single API. Ensures
consistent user experience across all dApps.

**Status:** Design. Drafted alongside the connection protocol.

## Standards Required

All standards land as **Midnight Improvement Proposals (MIPs)** — the
process is ratified. Without interoperable MIPs, each implementor
builds incompatible solutions.

| MIP | Title | Depends on | First drafted at |
|-----|-------|------------|------------------|
| MIP-1 | **Key Derivation Paths** | — | MVP 1 Week 6 |
| MIP-2 | **Bech32 Address Format** | MIP-1 | MVP 1 Week 8 |
| MIP-3 | **Naming System** | MIP-2 | MVP 1.1 |
| MIP-4 | **Multi-Key Account Model** | MIP-3 | v2.0 Stream A |
| MIP-5 | **dApp-Wallet Connection Protocol** | MIP-4 | MVP 1.1 (working draft from MVP 1 Week 7) |
| MIP-6 | **Privacy-Preserving Credentials** | MIP-4 | v3.0 |
| MIP-7 | **FROST Threshold Signing on JubJub** | MIP-2 | MVP 1 Week 4 cryptographer sign-off |
| MIP-8 | **Onboarding SDK** | MIP-5 + MIP-7 | MVP 1.1 |

**Priority.** MIP-5 (connection protocol) and MIP-6 (credentials) are
the highest-value ecosystem MIPs — they define how the ecosystem
plugs together. MIP-1 and MIP-2 are smaller mechanical specifications
but are prerequisites for everything else, so they are the first two
we draft — with **Lace ID** as the expected external co-author, since
Lace's existing key-derivation and address implementation directly
informs them.

## What We Are Asking Of Partners

1. **Review the architecture** — does the staged approach (managed
   signing → federation → multi-device on-chain → self-custody) work
   for your use cases?
2. **Co-author MIPs** — the key-derivation MIP and address-format MIP
   are the first two out of the gate and benefit most from wallet
   implementer input. The connection protocol and credentials
   standards follow and benefit from input from wallet developers,
   dApp builders, and credential issuers.
3. **Identify gaps** — what does your integration need that is not
   covered here?

## Open Questions

1. **Account provider availability** — for production, the account
   provider should not be a single point of failure. Options include
   running redundant providers or using decentralised identity
   standards. Orthogonal to the custody question, since the provider
   authenticates but does not hold keys.
2. **Regulatory posture** — a managed-custody model (single-party
   operator of the threshold committee) may trigger regulatory
   requirements depending on jurisdiction. Needs legal review before
   MVP 1.1.
3. **Wallet partner for the MVP demo** — Lace is the default;
   commit-or-fallback decision is a Week-8 input on the MVP 1
   schedule.

---

*ARC — Input Output Global, 2026/04/20*
