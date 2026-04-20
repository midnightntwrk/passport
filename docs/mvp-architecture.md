# ARC Passport — MVP Architecture

## Problem Statement

Midnight's zero-knowledge technology offers strong privacy guarantees for
identity credentials, but the user experience for key management remains a
significant barrier. On-device cryptography (BLS12-381 in a TEE, ZK proof
generation, seed management) requires solving hard unsolved problems before
users can interact with the platform.

We propose an MVP that delivers the target user experience immediately by
using a federated threshold signing network (FROST on JubJub), then
progressively migrates to on-device cryptography as the underlying
components mature.

## Architecture Overview

```
┌──────────────────────┐       ┌──────────────────────┐
│     User Device      │       │   Account Provider   │
│                      │       │   (OAuth-like)       │
│  ┌───────────┐       │ auth  │                      │
│  │  Passkey  │───────┼──────▶│  - Device registry   │
│  │ (WebAuthn)│       │       │  - JWT issuance      │
│  └───────────┘       │◀──────│  - Session mgmt      │
│       │              │ JWT   │                      │
│       │ sign req     │       │                      │
│       │ + JWT        │       └──────────────────────┘
│       │              │
│       └──────────────┼──────▶┌──────────────────────┐
│                      │       │  Threshold Signing   │
│                      │       │  Nodes (FROST)       │
│                      │       │                      │
│  ┌────────────────┐  │       │  Node₁ (share₁)      │
│  │ ZK Proof       │◀─┼───────│  Node₂ (share₂)      │
│  │ Generation     │  │  sig  │  Node₃ (share₃)      │
│  │                │  │       │  ...                 │
│  │ tx + signature │  │       │                      │
│  │ → witness      │  │       │  DKG: no node ever   │
│  │ → ZK proof     │  │       │  sees the full key   │
│  └───────┬────────┘  │       │                      │
│          │           │       │  FROST (Schnorr)     │
│          │ proof+tx  │       │  on JubJub           │
└──────────┼───────────┘       └──────────────────────┘
           │ submit
           │
           ▼
┌──────────────────────┐
│   Midnight Network   │
│                      │
│  Registry contract   │
│  (name → public key) │
└──────────────────────┘
```

### Components

**User Device** — The user authenticates with a passkey (WebAuthn/FIDO2).
The device does not hold Midnight key material. It constructs the
transaction parameters (token, amount, recipient), then requests a
signature from the threshold signing network. The signature is **bound
to the exact transaction parameters** — the Schnorr challenge hash
includes the token colour, amount, recipient address, and a monotonic
transaction counter. A signature produced for one transaction is invalid
for any other. The device then submits the signature along with the
transaction to a proof server, which generates the ZK proof. The
signature is consumed inside the proof and never appears on-chain —
only the proof (which reveals nothing about the signature or the key)
is submitted to the blockchain.

**Account Provider** — An OAuth-like service responsible for:

- User registration and device management
- Passkey credential verification
- JWT issuance for authenticated sessions
- Enforcing the device addition ceremony (QR code between existing and
  new device)

**Threshold Signing Nodes (FROST)** — A federated network of nodes that
collectively hold the user's JubJub private key via Distributed Key
Generation (DKG). No single node ever possesses the full key. When a
user requests a signature, the nodes verify the JWT with the account
provider, then collaboratively produce a FROST (threshold Schnorr)
signature on the JubJub curve. The nodes sign the **user-specified
transaction parameters** — they cannot alter the recipient, amount, or
token without invalidating the signature, because these values are
bound into the Schnorr challenge hash. The signature is returned to the
user's device — the signing nodes do not generate proofs or submit
transactions.

**Midnight Network** — The blockchain itself. A registry contract maps
human-readable names (`alice.midnight`) to public keys. Because the
signing network manages a single key per user, each name resolves to
exactly one key — no multi-device wallet fragmentation.

## User Flows

### Onboarding

1. User opens the app or scans a QR code
2. User is directed to the account provider to create an account
3. User registers a passkey on their device
4. The signing network runs DKG to generate a new JubJub key (no node
   sees the full key)
5. The account provider submits a transaction to register
   `username.midnight` on the registry contract
6. The service provider pays the DUST fees for registration
7. User lands on a fully functional account — passkey-authenticated, named,
   ready to transact

### Adding a Device

1. User opens the app on the new device
2. The new device displays a QR code (or the existing device does)
3. The existing device scans the QR code, establishing a secure channel
4. The existing device authorises the new device with the account provider
5. The new device registers its own passkey
6. Both devices can now authenticate and request transactions

No key transfer occurs. The signing network holds the JubJub key; the
devices hold only authentication credentials.

### Transacting

1. User initiates a transaction in the app
2. The device authenticates via passkey and obtains a JWT
3. The device sends a signing request and the JWT to the signing network
4. The signing nodes verify the JWT with the account provider
5. The nodes collaboratively produce a FROST (threshold Schnorr)
   signature on JubJub and return it to the device
6. The device uses the signature as a witness input to generate a ZK
   proof locally — the signature is embedded in the proof and never
   exposed on-chain
7. The device submits the proof and transaction to the Midnight network

## Why FROST on JubJub

The choice of signature scheme is driven by three constraints:

1. **The signature must be verifiable inside a Compact circuit** — if the
   circuit cannot check the signature, anyone could pass a forged
   signature as a witness and the proof would be accepted.
2. **Verification must be cheap in Midnight's SNARK** — Midnight uses
   Halo2/MidnightZK over BLS12-381. Operations on the **JubJub curve**
   (the embedded curve inside BLS12-381) are native arithmetic in the
   SNARK — cheap. Operations on other curves (Ed25519, secp256k1) or
   pairing checks (BLS signatures) are prohibitively expensive.
3. **The scheme must support threshold signing** — no single node should
   hold the full key.

**FROST (Flexible Round-Optimised Schnorr Threshold)** on the JubJub
curve satisfies all three:

- **Schnorr verification is SNARK-friendly** — it requires only scalar
  multiplications and point additions on JubJub, which are native
  operations in Midnight's constraint system. No pairings.
- **JubJub is Midnight's embedded curve** — the existing Compact
  experiment already uses `ecMulGenerator` on JubJub for key operations.
  Schnorr verification in-circuit is a natural extension.
- **FROST is threshold-native** — each node produces a partial signature
  from its key share, and the partials are combined into a valid Schnorr
  signature. No node ever reconstructs the full private key.

**Why not BLS (Boneh-Lynn-Shacham) signatures?** BLS signatures have
excellent threshold properties (no key reconstruction, simple
aggregation), but BLS verification requires pairing checks, which are
very expensive inside a SNARK. BLS12-381 is the right *curve* for
Midnight; BLS is the wrong *signature scheme* for in-circuit
verification.

**Why not FROST on Ed25519?** Ed25519 operates over a different prime
field (`2²⁵⁵ - 19`) than BLS12-381's scalar field. Verifying Ed25519
signatures inside a BLS12-381 SNARK requires non-native field
arithmetic — hundreds of constraints per field operation instead of one.

**Existing tooling:** NEAR's `threshold-signatures` crate includes a
fully implemented FROST for RedDSA on the JubJub curve, along with DKG,
key reshare, and key refresh protocols.

**Validated:** JubJub Schnorr verification has been tested end-to-end in
a Compact circuit on a local Midnight devnet. A contract was deployed
that registers a JubJub public key, holds unshielded tokens, and
releases them only when a valid Schnorr signature `s·G == R + c·PK` is
verified in-circuit. The challenge hash uses Midnight's native
`persistentHash` (Poseidon), keeping everything SNARK-friendly. The
signing was performed by a Rust CLI using the `jubjub` crate, producing
identical results to a TypeScript implementation. See
`experiments/redjubjub-wallet/` for the full experiment.

## What This MVP Achieves

- **Immediate user experience** — passkey authentication, human-readable
  names, no seed phrases, no address management
- **One key per name** — the registry contract maps each name to a single
  public key, avoiding the multi-device wallet fragmentation problem
- **Standard authentication patterns** — OAuth-like account provider,
  JWT tokens, WebAuthn passkeys. No novel UX required.
- **Service-provider-subsidised onboarding** — the provider pays DUST fees
  for registration and initial transactions
- **Auditable security** — DKG ensures no single node holds the full key.
  The threshold can be configured (e.g. 3-of-5) to balance availability
  and security.

## Trade-offs

| Trade-off | Impact | Acceptable for MVP? |
|---|---|---|
| Custodial trust in the signing network | Users must trust the federation will not collude | Yes — most wallet-as-a-service products work this way |
| Liveness dependency | If the signing network is down, users cannot transact | Yes — same as any service backend |
| Not self-custodial | The user does not hold their own keys | Yes — with a clear roadmap to self-custody |
| Centralised account provider | Single point for authentication | Yes — can be federated or decentralised later |

## Path to Self-Custody

The MVP is not the end state. It is the starting point. The signing
network is a scaffold. Two independent workstreams run in parallel to
remove it:

```
                        ┌─────────────────────────────┐
                        │           MVP               │
                        │                             │
                        │  Passkey + FROST + Account  │
                        │  Provider + Registry        │
                        └──────────┬──────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
          ┌─────────▼──────────┐       ┌──────────▼─────────┐
          │  Stream 1          │       │  Stream 2          │
          │                    │       │                    │
          │  Multi-device =    │       │  On-device         │
          │  one account on    │       │  cryptography      │
          │  Midnight          │       │                    │
          │                    │       │  JubJub key in TEE │
          │  Key-set Merkle    │       │  ZK proof on       │
          │  roots in Compact  │       │    device          │
          │  circuits          │       │  DeRec recovery    │
          └─────────┬──────────┘       └──────────┬─────────┘
                    │                             │
                    │Simplify the account         │Remove the
                    │provider: expose only        │signing network
                    │what the smart contract      │
                    │gives us                     │
                    │                             │
                    └──────────────┬──────────────┘
                                   │
                        ┌──────────▼──────────────────┐
                        │       Full Self-Custody     │
                        │                             │
                        │  Passkey + on-device keys   │
                        │  + multi-device account     │
                        │  on Midnight                │
                        │                             │
                        │  No signing network.        │
                        │  No centralised account     │
                        │  provider.                  │
                        └─────────────────────────────┘
```

### Stream 1: Multi-Device Accounts on Midnight

Solve the problem of multiple device keys mapping to a single on-chain
identity. This requires Compact circuits that maintain a key-set Merkle
root, where any registered device key can authorise transactions via ZK
witness proof. Once this is in place, the account provider can be
simplified — it no longer needs to manage device-to-account mapping
itself, because the smart contract enforces it.

### Stream 2: On-Device Cryptography

Move key material and proof generation onto the user's device. This
includes JubJub key management in the device's TEE (via AES-256-GCM
wrapping), local ZK proof generation, and a recovery mechanism (DeRec
or equivalent) to replace the signing network's implicit recovery model.
Once this is complete, the signing network is no longer needed — the
device signs and proves directly.

### Independent streams

These streams are independent. Neither blocks the other. Stream 1 can
ship with the signing network still active. Stream 2 can ship with a single-device
account model. When both converge, the user has full self-custody with
multi-device support — and the user experience has not changed once.

## Design Principles Alignment

The reference design (Midnight-Native Secure Onboarding Design)
establishes six design principles. This section maps each principle to
how the MVP addresses it and where the two parallel streams complete the
picture.

### 1. Keys Never Leave TEEs; Authorisation via ZK Witnesses

**MVP:** Deferred. Keys live in the signing network, not in device TEEs.
However, the ZK witness model is preserved — the FROST signature
produced by the signing nodes is verified inside the Compact circuit
as a witness. The proof reveals nothing about the signature or the key.
The authorisation pattern is correct; only the custody location differs.

**Stream 2** resolves this by moving key material into the device's TEE
with AES-256-GCM wrapping.

### 2. Single Seed, Three Wallets

**MVP:** Achieved differently. The signing network holds one key per user.
The three wallet types (Shielded, Night, Dust) are derived from it via
CIP-1852 hierarchical deterministic derivation. The outcome is the same
— one identity, three wallet layers — but the seed lives in the signing network rather than on-device.

**Stream 2** moves the seed onto the device, achieving the reference
design's intent fully — a single BIP39 seed in the device's TEE from
which all three wallet layers are derived.

### 3. Chain Abstraction via Intent Model

**MVP:** Achievable. The NEAR threshold-signatures crate supports
multiple schemes — ECDSA (secp256k1), EdDSA (Ed25519), and FROST on
JubJub. The same infrastructure that signs Midnight transactions can
also sign for Ethereum, Bitcoin, Cardano, Solana, NEAR, and others.
Chain abstraction becomes an API layer on top of the existing signing
network rather than a separate system to build.

### 4. One Key Per Device

**MVP:** Inverted. The reference design gives each device its own key
pair and maps multiple keys to one account. The MVP has one key in the signing network and multiple devices
authenticating to it via passkeys. The user
experience is identical — multiple devices, one account — but the
mechanism is centralised rather than on-chain.

**Stream 1** converges toward the reference design's intent by
implementing multi-key accounts on Midnight (key-set Merkle roots in
Compact circuits). Each device would then hold its own key and register
it on-chain, removing the need for the account provider to manage
device-to-account mapping.

### 5. Privacy-by-Design Identity

**MVP:** Not in scope, but not blocked. The ZK credential layer
(attestation trees, selective disclosure, nullifier-based reuse
prevention) is independent of the key custody model. Identity
credentials work the same whether the key is in the signing network or
on-device. This can be added as an incremental feature on top of the
MVP without architectural changes.

### 6. Seedless User Experience

**MVP:** Fully achieved. The user never sees a seed phrase, a mnemonic,
or a raw address. Authentication is passkey-only. This is arguably
stronger than the reference design's approach, which generates a BIP39
mnemonic inside the TEE and hides it — the MVP never generates a
user-facing seed at all.

### Summary

| Principle | MVP | Stream 1 | Stream 2 | Full product |
|---|---|---|---|---|
| 1. Keys in TEEs | Signing network | — | On-device TEE | Fully met |
| 2. Single seed, three wallets | Network-held seed | — | Device-held seed | Fully met |
| 3. Chain abstraction | Achievable via signing network | — | — | Fully met |
| 4. One key per device | One key, multi-device auth | Multi-key on-chain | — | Fully met |
| 5. Privacy-by-design identity | Not blocked | — | — | Additive feature |
| 6. Seedless UX | Fully met | — | — | Fully met |

## Validated Assumptions

1. **Schnorr verification in Compact** — Confirmed working. A full
   Schnorr verification (`s·G == R + c·PK`) executes successfully inside
   a Compact circuit using `ecMulGenerator`, `ecMul`, and `ecAdd` on
   JubJub. The challenge hash uses `persistentHash` (Poseidon) with a
   nonce-retry loop to ensure the hash < JUBJUB_R. The `withdraw`
   circuit (k=14, 11,436 rows) compiles and verifies on-chain.
   See `experiments/redjubjub-wallet/`.

2. **Contract-held tokens with signature-gated withdrawal** — Confirmed
   working. A Compact contract can receive unshielded tokens via
   `receiveUnshielded` and release them via `sendUnshielded`, gated by
   Schnorr signature authorisation. Replay protection via a monotonic
   `tx_count` bound into the challenge hash.

3. **Rust/TypeScript signing interoperability** — Confirmed. The `jubjub`
   Rust crate and TypeScript bigint arithmetic produce identical Schnorr
   signatures for the same inputs. The signing boundary is clean: Rust
   handles scalar arithmetic (`s = r + c·sk mod JUBJUB_R`), TypeScript
   handles the Midnight-specific Poseidon challenge hash via the
   contract's `pureCircuits`.

## Known Issues

1. **JubjubPoint equality bug in compact-runtime 0.15.0** — Compact's
   `==` on `JubjubPoint` compiles to JavaScript `===` (reference
   equality), which always returns `false`. Workaround: post-compile
   patch the generated JS. Bug report submitted to the Midnight team.
   See `docs/KNOWLEDGE_BASE.md` for details.

## Open Questions

1. **Account provider federation** — For production, the account provider
   itself should not be a single point of failure. Options include
   running multiple providers or using decentralised identity standards.
2. **Regulatory posture** — A federated custodial model may trigger
   regulatory requirements depending on jurisdiction. This needs legal
   review.
3. **FROST integration** — The single-signer Rust CLI validates the
   signing math, but replacing it with a FROST threshold protocol
   (multiple nodes, DKG, partial signatures) has not yet been tested
   end-to-end. NEAR's `threshold-signatures` crate provides the
   building blocks.

## Standards Roadmap

Midnight does not yet have a formal improvement proposal process
comparable to Cardano's CIPs. Several foundational standards that
Cardano takes for granted (key derivation paths, address formats,
dApp-wallet connection protocols) do not exist for Midnight. Today,
only 1AM and Lace Wallet implement key management and derivation, and
they do so without a shared public specification that third parties
can build against.

The following MIPs (Midnight Improvement Proposals) are needed to make
Midnight Passport — and the broader ecosystem — interoperable. They
are modelled on the CIP process (see CIP-0140, CIP-0118, CIP-0161,
CIP-0164 for structural reference).

### Standards That Do Not Exist Today

These are gaps — no specification exists, public or private.

| MIP | Title | Why it is missing today |
|-----|-------|------------------------|
| MIP-1 | **Key Derivation Paths** | 1AM and Lace implement CIP-1852-style derivation internally, but there is no published standard for Midnight's coin type (`2400`), role indices, or curve parameters. Third-party wallets cannot derive compatible keys. |
| MIP-2 | **Address Format** | No canonical Bech32m encoding for Midnight's three address types (shielded, unshielded, DUST). Each implementor invents its own representation. |
| MIP-3 | **Naming System** | No on-chain name registry exists. Human-readable names (`alice.midnight`) are a Passport design goal with no current protocol support. |
| MIP-4 | **Multi-Key Account Model** | Midnight accounts are currently single-key. There is no standard for mapping multiple device keys to one identity, nor for scoped function-call keys. |
| MIP-5 | **dApp-Wallet Connection Protocol** | Midnight has an early dApp connector API but no formal standard equivalent to Cardano's CIP-30. Privacy scoping, async proof coordination, and credential disclosure are unspecified. |
| MIP-6 | **Privacy-Preserving Credentials** | Midnight's attestation tree mechanism exists at the platform level, but there is no standard for domain separators, nullifier construction, credential lifecycle, or issuer interoperability. |
| MIP-7 | **FROST Threshold Signing on JubJub** | No specification exists for threshold Schnorr signing on Midnight's embedded curve. The MVP's signing network needs this. |
| MIP-8 | **SDK Onboarding Wrapper** | No standard onboarding API. Each dApp would implement its own flow. |

### Priority

**MIP-5** (Connection Protocol) and **MIP-6** (Credentials) are the
highest priority. MIP-5 is the interface that third-party dApp
developers build against — without it, the ecosystem cannot grow
beyond first-party apps. MIP-6 is what makes Midnight Passport
distinctive — portable, privacy-preserving credentials that any
issuer and any verifier can interoperate on.

**MIP-1** and **MIP-2** (Key Derivation, Address Format) are
prerequisites for everything else but are smaller, more mechanical
specifications. They should be written first and can likely be
extracted from 1AM and Lace's existing implementations.

**MIP-3** (Naming) and **MIP-4** (Account Model) are needed before
the Passport can offer named accounts with multi-device support.

**MIP-7** (FROST) and **MIP-8** (Onboarding SDK) support the MVP
architecture directly and can be drafted in parallel with the others.

---

*ARC — Input Output Global, 2026/04/15*
