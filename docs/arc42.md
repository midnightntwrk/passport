# Midnight Passport — Architecture (arc42)

> **Status: Draft.** This document is the project's architectural spine
> in the [arc42](https://arc42.org) format. It is an **index**, not a
> monolith — sections link out to the canvases, ADRs, and experiments
> where bulk lives.

**Drafted:** 2026/05/06 · **Source of truth for the inventory:**
[`site/data.js`](../site/data.js)

---

## 1. Introduction and Goals

Midnight Passport is the user-facing identity and wallet layer for the
Midnight network — `alice.midnight` names, passkey onboarding,
multi-device support, and privacy-preserving credentials. It is the
identity surface third-party wallets and dApps integrate against.

### v1.0 promises

The system makes ten promises. Each is decomposed into testable
invariants in [`docs/plans/PROMISES.md`](plans/PROMISES.md).

| ID | Name | One-line statement |
|----|------|--------------------|
| **P1** | Seedless | The user is never required to see, hold, or transcribe seed material. |
| **P2** | Named | Every account has a stable, human-readable name. |
| **P3** | Peer-device | Every authorised device is a first-class peer. |
| **P4** | Revoke-and-continue | Losing a device does not lose the account. |
| **P5** | Recover-from-zero | Losing all devices does not lose the account. |
| **P6** | Key-bound | Cryptographic keys never leave the party that legitimately holds them. |
| **P7** | Scoped grants | Access is grantable along three axes (operation × object × bounds). |
| **P8** | Chain-only | Only the Midnight blockchain is required to operate the account. |
| **P9** | Selective disclosure | The user can prove a property without revealing more. |
| **P10** | Chain abstraction | A single Passport account can transact across every chain Passport supports. |

### Quality goals (top-ranked)

1. **Privacy.** P9 (selective disclosure) and P6 (key non-exfiltration) together.
2. **Censorship resistance / operational autonomy.** P8 — no third-party operator on the critical path.
3. **Continuity of identity.** P4 + P5 — account survives device loss, including total loss.
4. **Ecosystem adoption.** Standards adoptable by the Midnight Foundation and partner wallets — unilateral design is shelfware.

### Stakeholders

| Stakeholder | Interest |
|---|---|
| End-users | Seedless onboarding; durable, recoverable, private account |
| dApp / wallet developers | Stable integration surface (C23); scoped grants (P7) |
| Midnight Foundation | Standards adoption; demo readiness for October 2026 |
| Cryptographers / DID experts | Soundness of P9, domain separation (C8) |
| MIPs / CIPs community | Openly adoptable standards |

---

## 2. Constraints

Distilled from [`.claude/CLAUDE.md`](../.claude/CLAUDE.md) and project history.

### Schedule
- **Public demo:** October 2026.
- **MVP deadline:** none fixed. The plan maps the work; it does not enforce a critical path.
- **Cadence:** weekly demonstrable progress preferred. If a week's deliverable slips, ship the next thing that works.

### Ecosystem and adoption
- Standards must be adoptable by the Midnight Foundation and partner wallets.
- Every drafted standard targets a MIP, and where relevant a CIP.

### Repository topology
- This repository is the **planning workspace** — architecture, protocol drafts, research, decision records.
- The working **prototype lives in a separate repository** and tracks the standards drafted here.
- Internal-only context (`.planning/`, `.serena/`, `.arcsop/`) is gitignored and never committed.

### Technical
- **Midnight network** is the settlement substrate; **Compact** is the ZK DSL.
- **Schnorr-on-Jubjub** validated end-to-end across TypeScript and Rust in [`experiments/redjubjub-wallet/`](../experiments/redjubjub-wallet/) and [`experiments/redjubjub-wallet-rs/`](../experiments/redjubjub-wallet-rs/).
- **Research vs specification balance.** Every standard is backed by evidence — an experiment, an upstream extraction, or a cryptographer review.

---

## 3. Context and Scope

### System context

Midnight Passport sits between users (and the wallets / dApps they operate) and the Midnight blockchain. The parallelisation map at [`site/parallelisation.html`](../site/parallelisation.html) shows how the work decomposes across teams.

### External systems

| External | Relationship |
|---|---|
| **Midnight blockchain** | Settlement substrate. Required (P8). |
| **Midnight Foundation** | Co-builds demos (e.g. [NightFi](https://github.com/Midnight-Passport-Demo/NightFi)) and stewards the MIP process. |
| **Partner wallets** | Adopters of the dApp connection protocol (C23) and the underlying account standard. |
| **Upstream cross-chain architecture** | Solver network, threshold-Schnorr vaults, intent escrow contract. Owned upstream; Passport integrates via C25. |
| **`midnight-did` effort** | Midnight DID spec + Compact reference implementation, led by the IOG Midnight team. C3's path forward runs through engagement with this effort. |
| **W3C / DIF / IAMX** | DID method registry holders; coordination pending for `did:midnight`. |
| **Standards bodies** | MIPs and (where applicable) CIPs. |

### Interfaces

| Interface | Description | Component |
|---|---|---|
| dApp connection | CAIP-25-shaped, EIP-6963-discoverable; covers Sign-In-with-Passport. | [C23](plans/components/C23-dapp-connection-protocol.md) |
| Cross-chain | Trade-intent + identity hand-off to upstream cross-chain machinery. | [C25](plans/components/C25-cross-chain-integration-interface.md) |
| Name resolution | `alice.midnight` → addresses + account anchor. | [C2](plans/components/C2-name-service.md) |
| Device authentication | WebAuthn / passkey, bound to the device's secure boundary. | [C9](plans/components/C9-device-bound-authentication.md) |

### Out of scope

- Cross-chain machinery itself (solver network, MPC vaults). Owned upstream.
- The working prototype implementation. Lives in a separate repository.
- Open-standards adoption as a process commitment (vs. a v1.0 invariant).

---

## 4. Solution Strategy

*Filled as the major architectural strategies land.* The high-level shape is set: `alice.midnight` names + passkey-bound devices + chain-only operation + scoped grants + selective disclosure. Specific mechanism choices land per component as workstreams resolve.

See [`docs/plans/components/README.md`](plans/components/README.md) for the CAKE-vocabulary anchor (Applications · Permission · Solver · Settlement) the component inventory maps onto.

---

## 5. Building Block View

The component inventory **is** the building block view.

- **Inventory + Promises → Components map:** [`docs/plans/components/README.md`](plans/components/README.md)
- **26 component canvases (C1 – C26):** [`docs/plans/components/`](plans/components/)
- **Visual:** [`site/parallelisation.html`](../site/parallelisation.html)

Each canvas carries five fields — Outcome, Dependencies, Open questions, Failure modes, Alternatives — plus a Readings section that records the v1.0 path. Components in workstreams (C3, C4, C22, C24, C25) carry live decisions whose alternatives have not yet been selected.

---

## 6. Runtime View

*Filled as key scenarios are captured. Candidates for the first pass:*

- *Onboarding (seedless, single-device).*
- *Multi-device peer addition.*
- *Lost-device revocation.*
- *Total-loss recovery.*
- *Selective-disclosure proof flow.*
- *dApp scoped-grant request and proof verification.*

---

## 7. Deployment View

*Filled when the wallet / chain / off-chain split firms up. The high-level split:*

- *Wallet-side: signing (C5), proof generation (C6), local storage (C16), view-key sync consumer (C17), dApp protocol surface (C23).*
- *Chain-side: account-custody contract (C1), name service (C2), grant enforcement (C12), attestation tree (C18), nullifiers (C21).*
- *Off-chain (substitutable): indexers (C17 producer side), recovery helpers (C15).*

---

## 8. Crosscutting Concepts

- **Domain separation discipline.** Every `persistentHash` use site carries a domain prefix. See [C8](plans/components/C8-domain-separation-registry.md).
- **Witness handling.** Key material flows into proof generation without leaving the trusted boundary. See [C7](plans/components/C7-witness-handling.md).
- **Private-state ↔ public-state linkage is not automatic.** Kachina / Compact does not verify that a contract's public state corresponds to any party holding the matching private state. Loss of the private side orphans the public side — see [C16](plans/components/C16-wallet-local-storage.md) failure modes. Recovery flows ([C14](plans/components/C14-total-loss-recovery-flow.md)) must address this explicitly; pure chain-state inspection is insufficient.
- **Substitutable services.** Per P8, all ancillary services (indexers, helpers) must have at least two providers, or documented self-host.
- **MVP-vs-v1.0 migration.** Several workstreams record both an MVP pick (October demo) and a v1.0 deliverable target. See canvases for C3, C4, C5, C22, C24.

*This section grows as concepts surface across more than one canvas.*

---

## 9. Architecture Decisions

ADRs live under [`docs/adrs/`](adrs/). Template: [`docs/adrs/0000-template.md`](adrs/0000-template.md).

*Populated by `/arcsop-component-finalize`. Accepted ADRs:*

- [0001](adrs/0001-domain-separation-registry.md) — Domain separation: central registry (A) adopted, enforcement (C) deferred; standardised via an MPS.

---

## 10. Quality Requirements

Quality scenarios derive from the invariants in [`docs/plans/PROMISES.md`](plans/PROMISES.md).

- **Privacy:** I-9.1, I-9.2 (selective disclosure); I-6.1 – I-6.5 (key non-exfiltration).
- **Continuity:** I-3.1 – I-3.4 (peer devices); I-4.1 – I-4.4 (revocation); I-5.1 – I-5.4 (recovery).
- **Operational autonomy:** I-8.1 – I-8.4 (chain-only).
- **Authorisation soundness:** I-7.5 (no silent widening); I-7.7 (chain-side enforcement).

*Specific quality scenarios filled when §6 (Runtime View) lands.*

---

## 11. Risks and Technical Debt

Component-level risks live in each canvas's Failure Modes section. Project-level risks:

- **Workstream gating (5 of 26).** C3, C4, C22, C24, C25 carry live decisions. Downstream finalisation cannot precede the gating workstream's resolution.
- **`ownPublicKey()` ecosystem hazard.** Direct use of Compact's `ownPublicKey()` for access control is bypassable — an external audit reproduced impersonation against `example-bboard` and OpenZeppelin's `Ownable.compact` on devnet. Per upstream clarification ([LFDT-Minokawa/compact#283](https://github.com/LFDT-Minokawa/compact/issues/283)), the primitive was never intended for authentication; its intended use is providing a withdrawal address for shielded tokens. The upstream response is improved documentation, not removal — the misuse pattern will persist in third-party Compact code regardless, so Passport contracts use [C5](plans/components/C5-signing-primitive.md)'s in-circuit signature-verification pattern; see C5 failure modes.
- **Private-state loss orphans public state ("zombie state").** Kachina / Compact does not link private and public state automatically. If [C16](plans/components/C16-wallet-local-storage.md) private state is destroyed or inaccessible, the user's on-chain state in C1 (and other per-account contracts) remains visible but becomes inoperable — no party can produce the witnesses needed to interact with it. Recovery flows ([C14](plans/components/C14-total-loss-recovery-flow.md)) must address this explicitly; pure chain-state inspection is insufficient. Bears on C14, C16, C19.
- **Upstream coupling.** C25 is owned upstream; Passport-side integration is sequenced post-v1.0 initial release.
- **Compact proof cost.** Current `midnight-did` examples reach k=19, slow on the proof server. Bears on C6, C20, and any component using selective-disclosure-shaped circuits.
- **`did:midnight` registration.** Registered to IAMX; current spec is in our hands. Negotiation pending.
- **Demo dependency.** October 2026 demo is the project's first public cut. Mechanism shortcuts (e.g. partner-MPC for C5) carry a migration plan to the principled v1.0 spec.
- **Domain separation unenforced (C8).** The registry (ADR-0001, alternative A) documents domain prefixes but does not enforce them: missing-prefix and cross-protocol collision modes persist until compile-time enforcement (C) lands, and the existing `midnight:` / `mdn:` / `ni` scheme divergence is unreconciled. See [C8 failure modes](plans/components/C8-domain-separation-registry.md).

*Populated by `/arcsop-component-finalize` and `/arcsop-component-review` as components complete.*

---

## 12. Glossary

| Term | Definition |
|---|---|
| **CAKE** | Chain Abstraction Key Encapsulation. The four-layer reference model (Applications · Permission · Solver · Settlement) the component inventory maps onto. |
| **MIP** | Midnight Improvement Proposal. Standards-track output for protocols Passport drafts. |
| **CIP** | Cardano Improvement Proposal. Where Passport-relevant standards have Cardano-side counterparts. |
| **Passkey** | WebAuthn credential bound to a device's secure boundary. |
| **Compact** | Midnight's ZK DSL for contracts. |
| **`alice.midnight`** | Example of the Passport account name shape (P2). |
| **QSCI** | Qualified Shielded Coin Info. On-ledger structure used by the OZ contract-vault pattern for shielded contract custody (C4). |
| **Workstream** | A component carrying a live decision whose alternatives have not yet been selected. |
| **Invariant** | A property the system must keep true to keep a promise. Numbered `I-N.M`. |
| **Promise** | A user-observable property the system commits to. Numbered `P1 … P10`. |
| **Domain separation** | Mixing a distinct constant tag into a hash preimage per use site, so hashes from different contexts cannot collide. Catalogued by C8 / ADR-0001. |

---

## How this document is maintained

This arc42 doc is built and maintained on the fly via the SOP commands at [`.claude/commands/arcsop-*.md`](../.claude/commands/):

- `/arcsop-init` — stand up §1, §2, §3 (this run).
- `/arcsop-component-finalize <Cn>` — append to §9, update §11 and §12 as needed.
- `/arcsop-component-review <Cn>` — flags items that may need §11 attention.
