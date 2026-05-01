# Midnight Passport — v1.0 Principles

The invariants that feature-complete Midnight Passport (v1.0) must satisfy.
Stated as **user-facing promises** — what a user, dApp developer, or
ecosystem partner can rely on when v1.0 ships — and refined into testable
**invariants** that a future component (UI surface, API, service) could
plausibly violate and that we could detect.

These principles describe v1.0 (the feature-complete destination), not any
particular release. Initial-release sequencing — what ships first, what
follows, what depends on upstream work elsewhere in the ecosystem — is a
delivery question, recorded separately. Every principle on this page applies
to v1.0 in full.

## At a glance

| ID | Name | One-line statement |
|----|------|--------------------|
| **P1** | Seedless | The user is never required to see, hold, or transcribe seed material. |
| **P2** | Named | Every account has a stable, human-readable name. |
| **P3** | Peer-device | Every authorised device is a first-class peer. |
| **P4** | Revoke-and-continue | Losing a device does not lose the account. |
| **P5** | Recover-from-zero | Losing all devices does not lose the account. |
| **P6** | Key-bound | Cryptographic keys never leave the party that legitimately holds them. |
| **P7** | Scoped grants | Access is grantable along three axes (operation × object × bounds), with one primitive for all grant relationships. |
| **P8** | Chain-only | Only the Midnight blockchain is required to operate the account. |
| **P9** | Selective disclosure | The user can prove a property without revealing more. |
| **P10** | Chain abstraction | A single Passport account can transact across every chain Passport supports; chain identity is not a precondition for authorising. |

---

## The ten promises

### P1 · Seedless lifecycle

The user is never *required* to see, hold, or transcribe seed material — at
any point in the account lifecycle (onboarding, operation, recovery).
Optional power-user export may exist; it is never on the critical path.

**Invariants.**

- **I-1.1** No UI surface displays raw seed material as part of any required
  user flow (onboarding, signing, recovery).
- **I-1.2** No public API returns reconstructed seed material to user-side
  application code.
- **I-1.3** No error path, debug output, or shipped log statement emits seed
  material in any environment a user runs.
- **I-1.4** Recovered seed material is never exposed to the user. Total-loss
  recovery presents the user with the completed, operational account, not
  the seed.
- **I-1.5** Any optional seed export is behind explicit, distinct user
  action — never on the critical path of any required flow.

### P2 · Naming

Every account has a stable, human-readable name. If the user does not choose
one, the system generates one. The name is the durable public handle for the
account.

**Invariants.**

- **I-2.1** Every account in operational state has a non-null, human-readable
  name.
- **I-2.2** The name → account mapping is authoritative on-chain — name
  resolution requires no off-chain database.
- **I-2.3** Name uniqueness holds at any point in time (no two accounts share
  the same name simultaneously).
- **I-2.4** If the user does not choose a name during onboarding, the system
  generates one and assigns it before the account becomes operational.

### P3 · Multi-device (peer-device)

The account is usable from multiple authorised devices as first-class peers
(not main device + backup). Any authorised device can perform any account
operation.

**Invariants.**

- **I-3.1** Any authorised device can independently initiate any account
  operation — no "primary device" or operation-class gating.
- **I-3.2** Authorisation status is determined from on-chain state — not from
  device order, registration timestamp, or off-chain records.
- **I-3.3** Adding an authorised device does not modify the permissions held
  by existing authorised devices.
- **I-3.4** Adding the second (and *N*th) authorised device can be performed
  using only the user's existing devices and chain access — no external
  operator required.

### P4 · Lost-device recovery (revoke-and-continue)

When one device is lost or compromised but others remain, the user can revoke
the lost device and continue operating from any remaining authorised device —
without needing external help.

**Invariants.**

- **I-4.1** Any authorised device can revoke any other authorised device
  (subject to user authorisation on the revoking device).
- **I-4.2** A revoked device cannot perform any account operation after
  revocation, even if it retains its prior key material.
- **I-4.3** Revocation is verifiable from chain state alone — a third party
  can determine "key K is revoked" without consulting any off-chain service.
- **I-4.4** Revocation requires no external operator — only chain access from
  a remaining authorised device.

### P5 · Total-loss recovery (recover-from-zero)

When all authorised devices are lost, the user can recover the account
through a recovery mechanism that does not require a specific operator.

**Invariants.**

- **I-5.1** A recovery path exists that requires zero previously authorised
  devices.
- **I-5.2** The recovery path requires no specific named operator; helpers,
  if used, are role-substitutable.
- **I-5.3** Successful recovery reattaches the user to their *same* account —
  same name, same balances, same attestations — not a new account.
- **I-5.4** After recovery, the user can revoke any prior authorised devices
  in a single step.

### P6 · Key non-exfiltration (key-bound)

Cryptographic keys never leave the device or party that legitimately holds
them. Silent on mechanism — per-device, MPC, or hybrid all permitted,
provided no exfiltration.

**Invariants.**

- **I-6.1** No public or internal API path returns per-device key material as
  plaintext to the calling code.
- **I-6.2** Plaintext key material does not traverse any network boundary.
- **I-6.3** Key material is not written to general-purpose storage
  (filesystem, sync services, cloud backup) by any Passport-controlled code
  path.
- **I-6.4** Where shares of a secret are held by helpers (e.g. for recovery),
  all of the following hold:
  - each share is encrypted in transit such that only its intended holder
    can decrypt it;
  - any sub-quorum collection of shares is information-theoretically
    insufficient to reconstruct the secret;
  - reassembly into the original secret occurs only on a device under direct
    user control.
- **I-6.5** Logs, error messages, and crash dumps shipped to users do not
  contain key material or derivatives that permit reconstruction.

### P7 · Scoped access (scoped grants)

The user can grant access along three orthogonal axes:

- **operation type** — read, write, execute. Execute subsumes
  proof-producing operations — selective-disclosure proofs are executions of
  specific circuits, scoped per circuit.
- **object** — specific assets, contracts, attestations.
- **quantitative bounds** — value caps, rate limits, expiry.

The same primitive serves intra-user grants (one device authorising another)
and dApp grants (third-party application requesting scoped access).

**Invariants.**

- **I-7.1** The authorisation primitive supports operation type as a scope
  axis: read, write, execute — separable per grant. Execute scope applies
  per-circuit, so selective-disclosure proofs (executions of a specific
  circuit) are governed by the same axis.
- **I-7.2** The authorisation primitive supports object-level scope: which
  assets, contracts, attestations the grant covers.
- **I-7.3** The authorisation primitive supports quantitative bounds: value
  caps, rate limits, and expiry.
- **I-7.4** The same authorisation primitive is used for intra-user
  (device-to-device) and inter-party (user-to-dApp) grants — no parallel
  mechanism for either side.
- **I-7.5** A grant cannot be silently widened — every modification requires
  fresh user authorisation.
- **I-7.6** Grants are revocable, and revocation is verifiable from chain
  state.
- **I-7.7** The protocol (chain-side verification) enforces grant scope, not
  the dApp or wallet UI — out-of-scope operations are rejected at proof
  verification, not at application discretion.

### P8 · No required operator (chain-only)

Only the Midnight blockchain itself is required to operate the account.
Indexers, relays, helpers, and similar services are substitutable.
OAuth-shaped façades over scoped grants (P7) are permitted as compatibility
layers for Web2 interop, provided they are not on the critical path of any
account operation. All standards Passport relies on are public and ratified
as MIPs.

*Rationale: censorship resistance and operational autonomy. The account must
always be able to operate while the chain is operating. No external party can
withhold or prevent account operation.*

**Invariants.**

- **I-8.1** Every piece of state required to operate the account is derivable
  from chain state alone.
- **I-8.2** For each ancillary service the Passport client uses (indexers,
  relays, recovery helpers), at least two independent providers exist *or*
  self-hosting is documented and supported.
- **I-8.3** No single named operator is on the critical path for any of:
  onboarding, signing, recovery, name resolution, attribute proving.
- **I-8.4** Every standard Passport depends on is public and ratified (or in
  active draft) as a MIP.

### P9 · Attribute privacy (selective disclosure)

The user can prove properties about themselves (e.g. "I am over 18", "I hold
credential X") without revealing the underlying attribute or any identifying
information beyond the property being proven. Proofs cannot be linked back
across uses.

**Invariants.**

- **I-9.1** A proof reveals only the property being proven — no additional
  attribute, no identifier of the prover, no metadata about the credential.
- **I-9.2** Two proofs of the same property by the same user are not linkable
  across uses (no shared persistent identifier emitted by the proof).
- **I-9.3** *[Tentative — pending cryptographer / decentralised-identity
  expert review.]* Proof verification does not require the verifier to
  contact the credential issuer in real time. *Rationale for the candidate:
  real-time issuer contact would leak usage timing to the issuer, weakening
  unlinkability. Whether this is achievable as a v1.0 invariant or whether it
  constrains us to a narrower class of credential schemes is a question for
  expert review.*
- **I-9.4** Replay prevention (nullifiers) does not leak the credential
  identity or the attribute being proven.
- **I-9.5** Domain separation between credential commitment and nullifier
  construction is enforced — a nullifier cannot be linked back to its
  credential.

### P10 · Chain abstraction

A single Passport account can transact across every chain Passport supports.
The user expresses *what* they want; the system handles routing, settlement,
and chain-specific signature formats — chain identity is not a precondition
for authorising an operation, when chain identity is implicit in the named
asset.

*Note on scope.* This is a feature-complete v1.0 promise. Initial-release
sequencing may ship single-chain; cross-chain comes online when the upstream
solver and threshold-signature work it integrates against lands. Passport's
role is wallet-side trade-intent construction, user-key custody, identity,
and selective disclosure — not the cross-chain machinery itself.

**Invariants.**

- **I-10.1** A single account identifier (the Passport account name) is the
  entry point for the user's operations on every supported chain.
- **I-10.2** The user's authorising step does not require the user to
  identify which chain an operation lands on, when chain identity is implicit
  in the named asset.
- **I-10.3** A trade intent constructed on the wallet side does not pin a
  specific settlement chain unless the user explicitly requests one.
- **I-10.4** Cross-chain operations preserve the same Passport identity for
  the user across all chains. There is no separate per-chain identity shadow.
- **I-10.5** Passport's authorising surface (the trade-intent + signature) is
  independent of upstream solver / signature-scheme implementation details. A
  different solver implementation conforming to the same interface produces
  the same authorisation result.

---

## Out of scope for v1.0 principles

Recorded so the omission is not later mistaken for an oversight.

- **Open standards / ecosystem adoption.** A process commitment for the
  project, not a v1.0 invariant of the product. Captured separately in the
  delivery contract.
- **Operating the cross-chain machinery** (solver network, threshold-Schnorr
  vaults on external chains, intent escrow contract). Owned upstream by
  Shielded Technologies. Passport's principles cover what Passport
  *delivers*; the cross-chain capability is delivered through integration
  with the upstream architecture, not by Passport building it.

---

## Compressed principles checklist

The ten promises become ten named principles. Three merge candidates were
considered and rejected; their separation is load-bearing for component
design.

| ID | Name | Invariants |
|----|------|------------|
| **P1** | Seedless | I-1.1 … I-1.5 |
| **P2** | Named | I-2.1 … I-2.4 |
| **P3** | Peer-device | I-3.1 … I-3.4 |
| **P4** | Revoke-and-continue | I-4.1 … I-4.4 |
| **P5** | Recover-from-zero | I-5.1 … I-5.4 |
| **P6** | Key-bound | I-6.1 … I-6.5 |
| **P7** | Scoped grants | I-7.1 … I-7.7 |
| **P8** | Chain-only | I-8.1 … I-8.4 |
| **P9** | Selective disclosure | I-9.1 … I-9.5 (I-9.3 tentative) |
| **P10** | Chain abstraction | I-10.1 … I-10.5 |

### Merge candidates considered and rejected

- **P4 + P5 → "user can recover".** Rejected: P4 (one device lost) and P5
  (all devices lost) fail under different threat models and demand different
  mechanisms (revocation vs. quorum-based reconstruction). The explicit split
  is what bites during component design.
- **P1 + P6 → "secrets never leak".** Rejected: P1 is a UX-surface invariant
  (user never holds a seed); P6 is a system-internals invariant (keys never
  exfiltrate). They can fail independently — malware steals a key without
  exposing it in UI (P1 ✓ P6 ✗); manual seed entry leaks to user without
  network exfiltration (P1 ✗ P6 ✓). The distinction is load-bearing.
- **P3 + P4 → "device lifecycle".** Rejected: P3 is a steady-state invariant
  (multiple devices, daily peer use); P4 is a failure-mode invariant (revoke
  a lost one). A system can satisfy P4 without P3 — e.g., a
  backup-device-only model. The two are independent.

---

## Cross-reference map

Pairs of principles that share invariants or imply each other. Component
design must respect these edges; component-level dependency analysis lives in
[`components/`](components/).

- **P4 ↔ P3.** Revocation under P4 is meaningful only because P3 ensures
  remaining devices are first-class peers. P3 is a precondition for P4.
- **P4 ↔ P8.** I-4.4 (revocation needs no operator) is a special case of
  I-8.3 (no operator on critical path). P8 implies I-4.4 whenever P4 is
  satisfied.
- **P5 ↔ P8.** I-5.2 (recovery needs no specific operator) is again a
  special case of I-8.3.
- **P5 ↔ P1.** I-1.4 (recovery never exposes seed to user) ties recovery
  flow back into the seedless invariant. P1 constrains how P5 can be
  delivered.
- **P5 ↔ P6.** I-6.4 (encrypted share material may traverse for recovery,
  under three sub-conditions) is the explicit interface where P6 *permits*
  the network movement P5 needs.
- **P2 ↔ P8.** I-2.2 (name resolution is on-chain) is the naming-specific
  consequence of P8 (chain-only).
- **P9 ↔ P7.** Selective-disclosure proofs are *executions* of specific
  circuits, scoped under P7's execute axis. P9 is a property of those
  executions; P7 is the authorisation envelope around them.
- **P10 ↔ P2.** P10's "single account identifier as entry point on every
  chain" rests on P2's stable human-readable name. The name is the
  Passport-side handle that resolves to chain-specific addresses through the
  upstream cross-chain machinery.
- **P10 ↔ P7.** Scoped grants under P7 must compose with cross-chain
  operations under P10 — a grant may need to express which chains it covers,
  or grants may be chain-agnostic with the constraint expressed at the
  trade-intent layer.
- **P10 ↔ P8.** P8 (only Midnight required) survives P10 because Passport
  account *operations* require only Midnight; cross-chain settlement happens
  through upstream architecture, which Passport integrates against without
  depending on for account operation.
- **P10 ↔ P6.** Cross-chain settlement uses a threshold-signature scheme at
  the upstream layer, distinct from Passport's per-device keys at the user
  layer. P6 governs both layers — neither leaks key material.

---

## Open questions

- **I-9.3 (tentative).** Whether "verification does not require real-time
  issuer contact" is achievable as a v1.0 invariant — or whether it
  constrains us to a narrower class of credential schemes — needs
  cryptographer / DID expert review.

---

## Lineage

These ten promises are not new claims. They are clarifications of the
secure-onboarding design principles already documented at
[`docs/reference/machine-investigation/key-flows/secure-onboarding-design.md`](../reference/machine-investigation/key-flows/secure-onboarding-design.md)
and summarised in [`docs/PRINCIPLES.md`](../PRINCIPLES.md), refined to the
level of testable invariants and reframed around what the user can rely on
rather than how the system implements it.

The shifts from the inherited six-principle frame:

- *Mechanism stripped from principle level.* TEE specificity, BIP39 seed
  layout, and the "ZK witnesses" framing were demoted from principle-level
  claims to design choices recorded in the components canvases. The
  principles state the *invariant*; the components state the *mechanism*.
- *Failure-mode and steady-state separated.* The inherited "one key per
  device" carried both a daily-use claim and a failure-mode claim. Split
  into P3 (peer-device, steady state) and P4 (revoke-and-continue, failure
  mode), because they fail under different threat models.
- *Function-call keys promoted.* A sub-feature of "one key per device" in
  the inherited frame, scoped grants are now P7 in their own right —
  three-axis grants, one primitive for intra-user and dApp grants alike.
- *Chain-only made explicit.* The strongest constraint in the v1.0 set is
  that no operator other than the Midnight chain is required for any
  account operation. Implicit in the inherited framing; now stated as P8.
- *Cross-chain promoted to a v1.0 promise.* Earlier framings parked
  cross-chain as a Milestone 2 concern. P10 now states it as a v1.0
  promise, delivered through integration with the upstream cross-chain
  machinery (not by Passport building it).
