# Midnight Passport — Components

The functional surfaces feature-complete v1.0 needs to provide. A
*component* is named at the level where alternative mechanisms exist for
the same surface — not abstract enough to be a principle (those live in
[`../PRINCIPLES.md`](../PRINCIPLES.md)), not specific enough to be an
implementation. Each component carries a five-field canvas: outcome,
dependencies, open questions, failure modes, alternatives.

## CAKE-vocabulary anchor

The component inventory below maps to **CAKE's four-layer reference model**
(Chain Abstraction Key Encapsulation), the framework adopted as reference
for v1.0. CAKE is a vocabulary, not a protocol or library — adopting it is
a matter of architectural shape and intent primitive, not infrastructure.

| CAKE layer | What it is | Passport components |
|---|---|---|
| **Applications** | User-facing interface | C9 (auth) · C16 (storage) · C17 (sync) · C23 (dApp connection) · wallet UI |
| **Permission** | Wallet "holds the private key for the user and signs messages on their behalf" | C1 (account-custody) · C5 (signing) · C7 (witness) · C10 (grants) · C11 (lifecycle) · C12 (enforcement) |
| **Solver** | Estimates "fees and execution speed based on the user's initial balance and intent" | C24 (fee model) — single-chain, trivial; cross-chain machinery delivered upstream |
| **Settlement** | Ensures execution via bridging and transaction settlement | The Midnight chain itself — C25 (cross-chain integration interface) for the boundary with upstream cross-chain vaults |

Cross-chain machinery (oracles, bridges, multi-chain solver networks, MPC
chain signers for foreign curves) is delivered upstream by Shielded
Technologies; Passport integrates against that architecture via C25.

## Inventory

### Identity, naming, account

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C1**](C1-account-custody-contract.md) | Account-custody contract | The on-chain object representing an account — holds device set, name binding, grants. Whether it also holds assets directly is contingent on C4. | P1 · P3 · P4 · P5 · P8 |
| [**C2**](C2-name-service.md) | Name service | Name ↔ account binding plus resolution. Internal split between Registry (`name → owner`) and Resolver (`name → addresses`) is an alternative. | P2 · P8 |
| [**C3**](C3-did-surface.md) | DID surface | Interop with W3C DID standards — whether `alice.midnight` is itself the DID, or DID is a separate layer over Passport identity. **Workstream.** | P2 (tentative) |

### Asset custody and cryptographic operations

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C4**](C4-asset-custody-model.md) | Asset custody model | The design choice of how user assets are held and authorised: contract-custody, address-custody, or hybrid. Upstream of all key / derivation decisions. **Workstream.** | P3 · P4 · P5 · P6 |
| [**C5**](C5-signing-primitive.md) | Signing primitive | Schnorr-on-Jubjub for authorising chain operations. Whether keys are seed-derived or per-device-generated is contingent on C4. | P6 |
| [**C6**](C6-proof-generation.md) | Proof generation | Client-side ZK proving — the user is the prover, the node is the verifier. No hosted prover holds user data. | P6 · P8 |
| [**C7**](C7-witness-handling.md) | Witness handling | Passing key material into proof generation safely — the boundary where C5 / C6 interact with key non-exfiltration. | P6 |
| [**C8**](C8-domain-separation-registry.md) | Domain-separation registry | Cross-cutting hash-prefix discipline — every `persistentHash` use site gets a domain prefix. Prerequisite to credentials, signing, and naming. | P6 · P9 |

### Authentication

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C9**](C9-device-bound-authentication.md) | Device-bound authentication | How a device proves it is the user's device — passkey (WebAuthn) bound to the device's secure boundary. | P1 · P3 · P6 |

### Authorisation and access control

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C10**](C10-scoped-grant-primitive.md) | Scoped grant primitive | The authorisation primitive — operation type × object × quantitative bounds. Used for both intra-user and dApp grants. | P7 |
| [**C11**](C11-grant-lifecycle.md) | Grant lifecycle | Issue, modify, revoke, expire of grants. | P4 · P7 |
| [**C12**](C12-chain-side-enforcement.md) | Chain-side enforcement | Verifier contracts that reject out-of-scope operations. The protocol — not the application — enforces grant scope. | P4 · P7 |

### Recovery

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C13**](C13-lost-device-flow.md) | Lost-device flow | The flow by which a user revokes a lost or compromised device while retaining access via others. | P3 · P4 |
| [**C14**](C14-total-loss-recovery-flow.md) | Total-loss recovery flow | The flow by which a user recovers their account when all authorised devices are lost. | P1 · P5 · P6 |
| [**C15**](C15-helper-protocol.md) | Helper protocol | The protocol recovery helpers run — interface between C14 and the people / services holding shares. Substitutable per P8. | P5 · P8 |

### Wallet state and storage

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C16**](C16-wallet-local-storage.md) | Wallet local storage | Where the wallet persists private state on the user's device — wrapped seed, derived keys cache, sync state, name ownership, recently-issued attestations, arbitrary metadata. Includes the encryption envelope. | P1 · P3 · P6 |
| [**C17**](C17-view-key-indexer-sync.md) | View-key + indexer (sync) | The read half of the wallet — view keys handed to a substitutable indexer that reconstructs visible chain state for the UI. | P3 · P8 |

### Credentials and attribute privacy

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C18**](C18-attestation-tree.md) | Attestation tree | Merkle tree of attribute leaves anchored on-chain — the substrate for credentials. | P9 |
| [**C19**](C19-credential-issuance.md) | Credential issuance | Off-chain issuer verifying user attributes and contributing to the on-chain Merkle root. | P9 |
| [**C20**](C20-selective-disclosure-proof.md) | Selective-disclosure proof | The proof primitive — prove a property without revealing the attribute or other identifying information. | P9 |
| [**C21**](C21-nullifier.md) | Nullifier | Replay prevention — domain-separated hash that prevents re-use of the same proof but cannot be linked back to the underlying credential. | P9 |

### Midnight network integration

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C22**](C22-intent-surface.md) | Intent surface | How the user / dApp expresses operations relative to Midnight's native intent model. Whether intents are user-visible or internal-only is open. **Workstream.** | (tagged in workstream) |
| [**C24**](C24-fee-model.md) | Fee model | How transaction fees are paid given DUST's non-transferability and NIGHT-derived regeneration. Covers zero-DUST user bootstrap, sponsor patterns, DUST generation semantics, and the substitutability of any sponsor service. **Workstream.** | P1 · P3 · P5 · P8 |
| [**C25**](C25-cross-chain-integration-interface.md) | Cross-chain integration interface | The boundary between Passport and the upstream cross-chain architecture (solver network, threshold-Schnorr vaults, intent escrow contract). Defines what Passport hands off and what Passport consumes. **Placeholder — owned upstream; Passport-side integration sequenced post-v1.0 initial release.** | P3 · P5 · P7 · P8 · P10 |

### dApp and ecosystem integration

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C23**](C23-dapp-connection-protocol.md) | dApp connection protocol | The CAIP-25-shaped, EIP-6963-discoverable protocol surface that lets third-party dApps request scoped grants — including the Sign-In-with-Passport (DecentralisedAuth) authentication half of the same surface. | P7 · P8 |

## Principles → components map

Every principle has at least one component serving it.

| Principle | Components |
|---|---|
| **P1** Seedless | C1 · C9 · C14 · C16 · C24 |
| **P2** Named | C2 · (C3 tentative) |
| **P3** Peer-device | C1 · C4 · C9 · C13 · C16 · C17 · C24 · C25 |
| **P4** Revoke-and-continue | C1 · C4 · C11 · C12 · C13 |
| **P5** Recover-from-zero | C1 · C4 · C14 · C15 · C24 · C25 |
| **P6** Key-bound | C4 · C5 · C6 · C7 · C8 · C9 · C14 · C16 |
| **P7** Scoped grants | C10 · C11 · C12 · C23 · C25 |
| **P8** Chain-only | C1 · C2 · C6 · C15 · C17 · C23 · C24 · C25 |
| **P9** Selective disclosure | C8 · C18 · C19 · C20 · C21 |
| **P10** Chain abstraction | C2 · C5 · C7 · C10 · C22 · C23 · C24 · C25 |

## Workstreams

Five components carry live decisions whose alternatives have not yet been
selected. Each workstream canvas frames the decision space — the question
the canvas answers is "what are the alternatives and what would force a
choice", not "what is the answer".

- [**C3 — DID surface.**](C3-did-surface.md) Whether `alice.midnight` is
  the DID, whether DID is a separate identifier layer, and what DID method
  (if any) Passport defines.
- [**C4 — Asset custody model.**](C4-asset-custody-model.md) Whether
  assets live in the account-custody contract (C1), at chain-native
  addresses, or hybrid. Constrained by the QSCI publicity trade-off for
  shielded contract custody.
- [**C22 — Intent surface.**](C22-intent-surface.md) Reframed against the
  ledger `Intent` struct and the upstream PRD trade-intent layering. The
  question is no longer "do we have intents" but "what abstraction does
  Passport present over the ledger Intent and trade-intent layers".
- [**C24 — Fee model.**](C24-fee-model.md) How fees are paid given DUST's
  non-transferability and the absence of a contract-paymaster. Wallet-level
  fee splitting via `tokenKindsToBalance` looks viable at the SDK level;
  end-to-end devnet confirmation pending. The protocol primitive is the
  Intent struct's `dust_actions` field.
- [**C25 — Cross-chain integration interface.**](C25-cross-chain-integration-interface.md)
  Placeholder for the integration boundary with the upstream cross-chain
  architecture. Owned upstream; Passport-side integration sequenced
  post-v1.0 initial release.

For workstream components that admit a "make-it-run" mechanism distinct
from the principled v1.0 target, the canvas records both — the **Track 1
candidate** (the demo path) and the **Track 2 target** (the
feature-complete v1.0 path). See the plans
[README](../README.md#delivery-shape-one-body-of-code-two-tracks) for the
two-track delivery framing.
