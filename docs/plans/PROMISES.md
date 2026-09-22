# Midnight Passport — v1.0 Promises

The user-facing promises feature-complete Midnight Passport (v1.0) makes —
what a user, dApp developer, or ecosystem partner can rely on when v1.0
ships — refined into testable **invariants** that a future component (UI
surface, API, service) could plausibly violate and that we could detect.

These promises describe v1.0 (the feature-complete destination), not any
particular release. Initial-release sequencing — what ships first, what
follows, what depends on upstream work elsewhere in the ecosystem — is a
delivery question, recorded separately. Every promise on this page applies
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

Alongside these, [security properties](#security-properties) records the
adversarial and integrity properties the ten promises leave implicit —
numbered from P11.

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

## Security properties

The ten promises above state what the user is offered. This section
records the adversarial and integrity properties those promises leave
implicit — what the system must *not* permit, however it is
built. They are numbered from P11 and carry their own invariants in
the same form. One of them, P5′, is a strengthening of an existing
promise rather than a new one.

They come from the Agda formal specification, where each is stated as a
machine-level property over the architecture; the formal statements, and the
setting they are stated in, live in
[`arc-passport-formal-spec/docs/security-properties.md`](https://github.com/input-output-hk/arc-passport-formal-spec/blob/main/docs/security-properties.md).

| ID | Name | One-line statement |
|----|------|--------------------|
| **P5′** | Recovery-authorised | No key rotation happens that the user did not authorise. |
| **P11** | Transaction safety | Only a holder of the account's keys can move its funds. |
| **P12** | Value integrity | The balance changes only through incoming and outgoing transactions. |
| **P13** | Funds availability | With key access and funds above the fee threshold, the user can move all their funds. |
| **P14** | Private proving | The proof service learns only what proving requires, and total leakage is bounded by the prover view plus the chain. |
| **P15** | Guardian privacy | No one but a guardian itself can learn it is your guardian, and a guardian learns nothing beyond its own request. |
| **P16** | Upgrade safety | Upgrades are account-gated and preserve devices, balances, and identity observations. |

### P5′ · Recovery authorisation (recovery-authorised)

P5 promises that recovery *works* (liveness), this is its safety:
every rotation of the account's keys is authorised by the user through
the recovery mechanism.

**Invariants.**

- **I-5′.1** Every key rotation the chain adopts is accompanied by a
  recovery exchange authenticated under the account's out-of-band recovery
  secret.
- **I-5′.2** A rotation without such an authenticated exchange is rejected by
  chain-side verification.

### P11 · Transaction safety

Only a holder of the account's keys can move its funds.

**Invariants.**

- **I-11.1** Every spend from the account that the chain adopts carries a
  valid signature under a key registered to that account at the time of
  adoption.
- **I-11.2** The signature requirement is enforced chain-side, at
  verification.
- **I-11.3** A signature under a revoked key does not authorise a spend, even
  if the key material is intact.
- **I-11.4** No party other than the key holder can produce a signature that
  verifies.

### P12 · Value integrity

The account balance changes only through incoming and outgoing transactions.
The statement is more than a single equality, because the balance the user
sees is an *answer the system gives*, and a client can be offline or behind
the chain: what must hold is that the reported balance is never an
overstatement, and that it converges eventually.

**Invariants.**

- **I-12.1** A reported balance never exceeds the account's real balance.
- **I-12.2** After a period in which nothing enters or leaves the account,
  the reported balance equals the real balance.
- **I-12.3** No operation other than an incoming or outgoing transaction
  changes the real balance. Things like adding or revoking a device, recovering,
  renaming, etc. are all value-neutral.
- **I-12.4** Any divergence between reported and real balance is
  explained by staleness alone. It can never be a transaction that was
  lost, double-counted, or attributed to the wrong account.

### P13 · Funds availability

With access to the account's keys and a balance above the fee threshold, the
user can move all of their funds. This is the liveness dual of P11: safety
alone is satisfied by a wallet that never releases anything.

**Invariants.**

- **I-13.1** From any authorised device, the user can construct, authorise,
  and settle transactions that move the account's entire spendable balance,
  less fees.
- **I-13.2** No party can withhold this: no operator, helper, indexer, or
  proof service is on the critical path of a spend (the spending case of
  I-8.3).
- **I-13.3** The only precondition is that the balance covers transaction
  fees, and that threshold is discoverable by the client rather than
  implicit.
- **I-13.4** No account state renders funds permanently unspendable.

### P14 · Private proving

The proof service learns only what producing the proof requires, and the
total leakage of the architecture is bounded by two feeds: what the prover
sees and what the chain publishes.

**Invariants.**

- **I-14.1** Everything the proof service observes is derivable from the
  statement being proved — a compromised or curious prover gains nothing a
  party holding only the statement could not have worked out itself.
- **I-14.2** Nothing the proof service is handed links two proving requests
  to the same account or user: no persistent identifier, no reused
  commitment, no key or handle that survives a request.
- **I-14.3** The combined view of every component outside the user's own
  devices is accounted for by the prover view and the chain view together.
  No component carries user state out through a third channel.

*Not covered.* Availability of the proof service — a malicious prover may
simply refuse to prove, which P13 covers only where proving is not on the
spend path — and contact metadata (timing, network origin) beyond what the
statement itself pins.

### P15 · Guardian privacy

No one but a guardian itself can learn that it is your guardian, and a
guardian learns nothing beyond what answering its own request requires.

**Invariants.**

- **I-15.1** Chain state and network traffic do not reveal who an account's
  guardians are. Two accounts whose guardian sets have the same shape (size
  and threshold) are indistinguishable to a third party.
- **I-15.2** A guardian's view does not reveal the identity or the
  participation of any other guardian.
- **I-15.3** A guardian learns exactly the account address, the
  session nonce, its own share index, and its own reply and nothing
  else.

### P16 · Upgrade safety

Upgrades are gated by the account, and an upgrade preserves devices,
balances, and identity observations. MIP-0013 permits in-place circuit
replacement and records the device-orphaning risk that comes with it; these
invariants are what bounds that risk.

**Invariants.**

- **I-16.1** No upgrade takes effect without authorisation from the account
  itself. No operator, deployer, or circuit author can upgrade an account
  unilaterally.
- **I-16.2** An upgrade preserves the set of authorised devices.
- **I-16.3** An upgrade preserves balances.
- **I-16.4** An upgrade preserves identity observations: every attribute
  question answerable before the upgrade is answerable after, with the same
  answer.

---

## Out of scope for v1.0 promises

Recorded so the omission is not later mistaken for an oversight.

- **Open standards / ecosystem adoption.** A process commitment for the
  project, not a v1.0 invariant of the product. Captured separately in the
  delivery contract.
- **Operating the cross-chain machinery** (solver network, threshold-Schnorr
  vaults on external chains, intent escrow contract). Owned upstream in
  the Midnight ecosystem. Passport's promises cover what Passport
  *delivers*; the cross-chain capability is delivered through integration
  with the upstream architecture, not by Passport building it.

---

## Promises by invariant range

A summary view including the invariant ranges for each promise.

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

And the security properties:

| ID | Name | Invariants |
|----|------|------------|
| **P5′** | Recovery-authorised | I-5′.1 … I-5′.3 |
| **P11** | Transaction safety | I-11.1 … I-11.4 |
| **P12** | Value integrity | I-12.1 … I-12.4 |
| **P13** | Funds availability | I-13.1 … I-13.4 |
| **P14** | Private proving | I-14.1 … I-14.3 |
| **P15** | Guardian privacy | I-15.1 … I-15.3 |
| **P16** | Upgrade safety | I-16.1 … I-16.4 |

### Merge candidates considered and rejected

Three merge candidates were considered and rejected; their separation is
load-bearing for component design.

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

Pairs of promises that share invariants or imply each other. Component
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

The security properties attach to the same map. Each is the safety or
liveness counterpart of a promise that states only the other half:

- **P5′ ↔ P5.** P5 is recovery liveness (the user *can* recover); P5′ is
  recovery safety (nobody else can). A recovery mechanism satisfying P5
  alone is compatible with an unauthorised rotation.
- **P11 ↔ P4, P6.** I-4.2 (a revoked device cannot operate) and the I-6.x
  family (keys do not leave their holder) are only meaningful because P11
  requires a key for a spend in the first place.
- **P13 ↔ P11.** The liveness dual: P11 alone is satisfied by a wallet that
  never releases anything, P13 alone by one that releases to anybody.
- **P13 ↔ P8.** I-13.2 (nobody can withhold a spend) is the spending case of
  I-8.3 (no operator on the critical path).
- **P12 ↔ P16.** I-16.3 (upgrades preserve balances) is the upgrade case of
  I-12.3 (only transactions move value).
- **P14 ↔ P9.** P9 bounds what a *proof* reveals to its verifier; P14 bounds
  what producing the proof reveals to the prover, and what the architecture
  as a whole reveals to everything off the user's devices.
- **P15 ↔ P5, P6.** P5 admits recovery helpers and I-6.4 governs the share
  material they hold; P15 governs what their participation reveals — about
  the account, and about each other.
- **P16 ↔ P8.** I-16.1 (upgrades are account-gated) is the upgrade case of
  I-8.3: an operator-gated upgrade would put a named party back on the
  critical path.

---

## Open questions

- **I-9.3 (tentative).** Whether "verification does not require real-time
  issuer contact" is achievable as a v1.0 invariant — or whether it
  constrains us to a narrower class of credential schemes — needs
  cryptographer / DID expert review.

Three further guarantee-shaped obligations were surfaced alongside the
security properties. Each is statable in the same vocabulary; none is
committed to yet, and they are recorded here so the omission is deliberate
rather than an oversight.

- **Non-griefability.** Whether to promise that no outsider action degrades
  an authorised device's availability. The standards name the attack surface
  — deposit spam (`mip-0013:646`), inbox spam (`mip-0012:797`), contention
  on the global `round` counter — without promising resistance to it. A
  promise here would read: for any authorised device and operation, no
  action by a party outside the account can take that operation from
  available to unavailable.
- **Deployment authenticity.** Whether to promise that clients attach only
  to canonical, ratified bytecode — P2's namespace-forking failure mode one
  level down, applied to the account contract itself. The conformance check
  is decidable, so this is a question of committing to it, not of
  feasibility.
- **Reorg and finality.** How the promises should treat finality at all.
  Every invariant above that says "the chain adopts" or "chain state shows"
  currently reads as if adoption were final. There are several options and
  the choice is open; for now the promises are to be read under the
  assumption that adopted means final.

---

## Lineage

These ten promises are not new claims. They are clarifications of the
secure-onboarding design principles already documented at
[`docs/reference/machine-investigation/key-flows/secure-onboarding-design.md`](../reference/machine-investigation/key-flows/secure-onboarding-design.md)
and summarised in [`docs/PRINCIPLES.md`](../PRINCIPLES.md), refined to the
level of testable invariants and reframed around what the user can rely on
rather than how the system implements it.

The shifts from the inherited six-principle frame:

- *Mechanism stripped from the principle level.* TEE specificity, BIP39
  seed layout, and the "ZK witnesses" framing were demoted from
  principle-level claims (in the inherited frame) to design choices
  recorded in the components canvases. The promises state the *invariant*;
  the components state the *mechanism*.
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
