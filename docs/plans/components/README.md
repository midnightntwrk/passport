# Midnight Passport — Components

The functional surfaces feature-complete v1.0 needs to provide. A
*component* is named at the level where alternative mechanisms exist for
the same surface — not abstract enough to be a promise (those live in
[`../PROMISES.md`](../PROMISES.md)), not specific enough to be an
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
chain signers for foreign curves) is delivered upstream in the Midnight
ecosystem; Passport integrates against that architecture via C25.

## Inventory

### Identity, naming, account

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C1**](C1-account-custody-contract.md) | Account-custody contract | The on-chain object representing an account — holds device set, name binding, grants, and (per C4's resolved choice) the user's Midnight-native assets. Specified by two upstream standards (MIP-0012 contract custody, MIP-0013 multi-key authorisation) and realised by the reference implementation at `contract/`. | P1 · P3 · P4 · P5 · P8 |
| [**C2**](C2-name-service.md) | Name service | Name ↔ account binding plus resolution — decided: adopt the deployed upstream name service (MIP-0007, now carrying the delegated-owner authorisation arms Passport needs); account names are free, first-come-first-served sub-domains of the Foundation-held `passport.night`. | P2 · P8 · P10 |
| [**C3**](C3-did-surface.md) | DID surface | Interop with W3C DID standards — whether `alice.midnight` is itself the DID, or DID is a separate layer over Passport identity. **Workstream.** | P2 (tentative) |

### Asset custody and cryptographic operations

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C4**](C4-asset-custody-model.md) | Asset custody model | How user assets are held and authorised — resolved: stateless contract custody, normative in the custody MIP (upstream MIP-0012), and exclusive (assets at rest live only in the account contract; Dust is the ledger-forced fee-path exception). Upstream of all key / derivation decisions. **Workstream — resolved.** | P3 · P4 · P5 · P6 |
| [**C5**](C5-signing-primitive.md) | Signing primitive | Schnorr-on-Jubjub per device, verified in-circuit — set in stone by the account-authorisation MIP (upstream MIP-0013). Per-device keys, no derivation tree. | P6 |
| [**C6**](C6-proof-generation.md) | Proof generation | Client-side ZK proving — decided: browser WASM is the promoted path, validated end-to-end in the account-custody prototype (proof server stopped, every proof in-tab). The Foundation's third-party provider is the bounded-trust hosted fallback. | P6 · P8 |
| [**C7**](C7-witness-handling.md) | Witness handling | Passing key material into proof generation safely — the boundary where C5 / C6 interact with key non-exfiltration. | P6 |
| [**C8**](C8-domain-separation-registry.md) | Domain-separation registry | Cross-cutting hash-prefix discipline — every `persistentHash` use site gets a domain prefix. Prerequisite to credentials, signing, and naming. | P6 · P9 |

### Authentication

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C9**](C9-device-bound-authentication.md) | Device-bound authentication | How a device proves it is the user's device — decided: WebAuthn passkeys in both custody models. PRF evaluation derives the on-device JubJub device key (decentralised path); the same passkey authenticates to the MPC service holding the JubJub threshold-DSA capability (managed path). | P1 · P3 · P6 |

### Authorisation and access control

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C10**](C10-scoped-grant-primitive.md) | Scoped grant primitive | The authorisation primitive — operation type × object × quantitative bounds. Used for both intra-user and dApp grants. | P7 · P10 |
| [**C11**](C11-grant-lifecycle.md) | Grant lifecycle | Issue, modify, revoke, expire of grants. | P4 · P7 |
| [**C12**](C12-chain-side-enforcement.md) | Chain-side enforcement | Verifier contracts that reject out-of-scope operations. The protocol — not the application — enforces grant scope. | P4 · P7 |

### Recovery

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C13**](C13-lost-device-flow.md) | Lost-device flow | Decided: any surviving device revokes via the account-authorisation MIP's `remove_device` (1-of-n, last-device guard), with the epoch bump as the stronger fallback. Implemented in the prototype. | P3 · P4 |
| [**C14**](C14-total-loss-recovery-flow.md) | Total-loss recovery flow | Decided: BUSS / ANARKey stateless guardians plus paper keys (EPRINT 2025/551), implemented in the prototype behind the recovery seam. The recovery-paths MIP specifies it next. | P1 · P5 · P6 |
| [**C15**](C15-helper-protocol.md) | Helper protocol | The protocol recovery helpers run. The working candidate is the prototype's stateless-guardian BUSS wire format (shared across CLI and app); formalisation belongs to the recovery-paths MIP. Substitutable per P8. | P5 · P8 |

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
| [**C22**](C22-intent-surface.md) | Intent surface | How the user / dApp expresses operations relative to Midnight's native intent model. Whether intents are user-visible or internal-only is open. **Workstream.** | P7 · P8 · P10 |
| [**C24**](C24-fee-model.md) | Fee model | How transaction fees are paid given DUST's non-transferability and NIGHT-derived regeneration. Covers zero-DUST user bootstrap, sponsor patterns, DUST generation semantics, and the substitutability of any sponsor service. **Workstream.** | P1 · P3 · P5 · P8 |
| [**C25**](C25-cross-chain-integration-interface.md) | Cross-chain integration interface | The boundary between Passport and the upstream cross-chain architecture (solver network, threshold-Schnorr vaults, intent escrow contract). Defines what Passport hands off and what Passport consumes. **Placeholder — owned upstream; Passport-side integration sequenced post-v1.0 initial release.** | P3 · P5 · P7 · P8 · P10 |

### dApp and ecosystem integration

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C23**](C23-dapp-connection-protocol.md) | dApp connection protocol | The CAIP-25-shaped, EIP-6963-discoverable protocol surface that lets third-party dApps request scoped grants — including the Sign-In-with-Passport (DecentralisedAuth) authentication half of the same surface. | P7 · P8 · P10 |

### Agent tooling

| ID | Component | Description | Serves |
|----|-----------|-------------|--------|
| [**C26**](C26-ai-agent-skills.md) | AI agent skills | Agent rules and skills targeted at end-users, developers, and project managers. Meta-deliverable, built and maintained on the fly from day 1 to accumulate project context as the work moves. | (meta) |

## Promises → components map

Every promise has at least one component serving it.

| Promise | Components |
|---|---|
| **P1** Seedless | C1 · C9 · C14 · C16 · C24 |
| **P2** Named | C2 · (C3 tentative) |
| **P3** Peer-device | C1 · C4 · C9 · C13 · C16 · C17 · C24 · C25 |
| **P4** Revoke-and-continue | C1 · C4 · C11 · C12 · C13 |
| **P5** Recover-from-zero | C1 · C4 · C14 · C15 · C24 · C25 |
| **P6** Key-bound | C4 · C5 · C6 · C7 · C8 · C9 · C14 · C16 |
| **P7** Scoped grants | C10 · C11 · C12 · C22 · C23 · C25 |
| **P8** Chain-only | C1 · C2 · C6 · C15 · C17 · C22 · C23 · C24 · C25 |
| **P9** Selective disclosure | C8 · C18 · C19 · C20 · C21 |
| **P10** Chain abstraction | C2 · C10 · C22 · C23 · C25 |

## Workstreams

Three components carry live decisions whose alternatives have not yet
been selected; two more (C4 fully, C24's mechanism) are resolved and
retained here for the record. Each open workstream canvas frames the
decision space — the question the canvas answers is "what are the
alternatives and what would force a choice", not "what is the answer".

- [**C3 — DID surface.**](C3-did-surface.md) Whether `alice.midnight` is
  the DID, whether DID is a separate identifier layer, and what DID method
  (if any) Passport defines.
- [**C4 — Asset custody model.**](C4-asset-custody-model.md)
  **Resolved 2026/07.** Stateless contract custody: assets live in the
  account contract with no coin material in public ledger state,
  validated end-to-end and now normative in the custody MIP (upstream MIP-0012). The
  QSCI publicity trade-off dissolved — the leak was a property of the
  storage pattern, not the ledger.
- [**C22 — Intent surface.**](C22-intent-surface.md) Reframed against the
  ledger `Intent` struct and the upstream PRD trade-intent layering. The
  question is no longer "do we have intents" but "what abstraction does
  Passport present over the ledger Intent and trade-intent layers".
- [**C24 — Fee model.**](C24-fee-model.md) How fees are paid given DUST's
  non-transferability and the absence of a contract-paymaster.
  **Mechanism resolved:** wallet-level fee splitting via
  `tokenKindsToBalance` is confirmed end to end (F1 – F6 on node 1.0.0,
  including a sponsored contract deployment by a zero-token user). The
  protocol primitive is the Intent struct's `dust_actions` field; what
  remains open is the sponsor service contract and operator model.
- [**C25 — Cross-chain integration interface.**](C25-cross-chain-integration-interface.md)
  Placeholder for the integration boundary with the upstream cross-chain
  architecture. Owned upstream; Passport-side integration sequenced
  post-v1.0 initial release.

For workstream components that admit a "make-it-run" mechanism distinct
from the principled v1.0 target, the canvas records both — the **MVP
pick** (October demo) and the **v1.0 deliverable target**. See the plans
[README](../README.md#delivery-shape-v10-deliverables-and-the-october-mvp)
for the framing.
