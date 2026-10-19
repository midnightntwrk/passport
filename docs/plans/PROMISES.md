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

The ten promises above describe what you can do with Passport. These security
promises describe what must stay safe: who can move your funds, whether your
balance is accurate, and what recovery, proof services, and upgrades may reveal
or change. P5′ adds safety rules to recovery; P11–P16 cover the other protections.

| ID | Name | One-line statement |
|----|------|--------------------|
| **P5′** | Recovery-authorised | Recovery follows the rules you set. |
| **P11** | Transaction safety | Your funds move only with permission. |
| **P12** | Value integrity | Your balance is accurate, and catches up when you reconnect. |
| **P13** | Funds availability | Your funds remain available, even if you lose your devices. |
| **P14** | Private proving | Getting help to make a proof does not mean sharing everything. |
| **P15** | Guardian privacy | Your recovery contacts stay private. |
| **P16** | Upgrade safety | Upgrades do not take away access, funds, or identity. |

**Status.** These are v1.0 design requirements, not a claim that the current
prototype meets or formally proves them all. The
[source specification](https://github.com/input-output-hk/arc-passport-formal-spec/blob/main/docs/security-properties.md)
records their precise meaning, formal status, supporting evidence, known gaps,
and acceptance checks still to be completed.

### P5′ · Recovery authorisation (recovery-authorised)

**Recovery follows the rules you set.** Recovery replaces account authority
only through the configured recovery authority and waiting period; a live
device can cancel it. This does not certify the human owner's consent: a
colluding group of recovery contacts can reconstruct that authority (see Limits).
Ordinary live-device-authorised encryption-key rotation remains available
without a recovery exchange.

**Invariants.**

- **I-5′.1** Submission verifies the current recovery authority and successor
  key possession. Their authorisation binds the account, successor device key,
  successor recovery authority, current epoch/authorisation nonce, and signed
  time bound. Invalid signatures, stale state, or invalid time bounds are rejected
  chain-side.
- **I-5′.2** Finalisation enacts only an authorised pending record after the
  veto window, if uncancelled. A live device can cancel the pending record.
  Finalisation is permissionless: it does not require fresh recovery or successor
  signatures.

**Limits.** Recovery trusts the configured group of contacts: enough of them
acting together can recover the account without consent. If all devices are lost,
none remains to cancel recovery during the waiting period.

### P11 · Transaction safety

**Your funds move only with permission.** Permission can come from an enrolled
live device or a live grant within the limits you set under P7. A grantee need
not hold an account device key; the chain enforces those limits.

**Invariants.**

- **I-11.1** Every adopted spend carries valid device or grant authorisation
  bound to the account, operation, and applicable state.
- **I-11.2** Chain-side verification enforces signatures, authority liveness,
  grant scope, expiry, quantitative caps, state binding, and replay prevention.
- **I-11.3** Revoked devices or grants, expired grants, and stale epochs,
  generations, or nonces do not authorise new spends, even if keys are retained.
- **I-11.4** Under the signature scheme and cryptographic assumptions, producing
  authorisation for a **fresh unauthorised operation** is computationally
  infeasible. This does not require exclusive creation of every verifying
  signature byte string.

### P12 · Value integrity

**Your balance is accurate, and catches up when you reconnect.** A report tells
you which account, asset, and finalised ledger snapshot it describes, and
whether it is complete. An older balance may no longer be spendable; a
reconnecting client must catch up rather than keep presenting an old snapshot
as current.

**Invariants.**

- **I-12.1** A complete report equals the ledger balance at its identified
  snapshot. A partial report declared as a lower bound does not exceed the
  balance at **that same snapshot**. Incomplete views must account for relevant
  debits before claiming a lower bound. Stale reports may exceed the latest balance.
- **I-12.2** With accessible ledger/viewing data, continued synchronisation,
  sufficient computation, and fair progress, every relevant finalised movement
  is eventually included in the client's accounting. After movements cease,
  the client eventually reports a complete snapshot including all of them.
- **I-12.3** Holdings change only through ledger movements. Device changes,
  recovery, naming, and upgrades do not themselves create or destroy holdings.
- **I-12.4** Accounting loses, duplicates, or misattributes no movement.

### P13 · Funds availability

**Your funds remain available, even if you lose your devices.** Funds acquired
honestly and recoverable before a supported operation must remain recoverable
after spending, key changes, crashes, and total device loss. Moving them still
requires valid device/grant authority (or recovery authority to regain access),
computation/proving resources, fee resources, accessible chain data, and fair
transaction inclusion. A signing key alone does not supply these resources.

**Recoverable holdings** have valid coin descriptions and commitment openings,
viewing/decryption material, and ledger membership/witness data reconstructible
using the owner's valid private credential/recovery authority and chain data.

**Invariants.**

- **I-13.1** Given the stated prerequisites, any authorised device can construct,
  authorise, and settle transactions moving all such holdings.
- **I-13.2** No particular ancillary operator is indispensable.
- **I-13.3** The client can discover fee requirements and identify missing
  data/viewing/witness or proving prerequisites.
- **I-13.4** The remaining value of previously recoverable, honestly acquired
  holdings, including change, remains recoverable through supported spends and
  account transitions, including encryption-key changes, crashes, and total
  device loss.

### P14 · Private proving

**Getting help to make a proof does not mean sharing everything.** A proof
service receives only the information allowed for that proof's supported
profile. Ordinary delegated proving can expose private witness data, including
coin descriptions; it is not anonymous or statement-only proving.

**Invariants.**

- **I-14.1** Each supported circuit/proving profile has a fixed, normative,
  exhaustive leakage budget, anchored to its documented protocol: public inputs,
  necessary private witness fields disclosed to the prover, and minimum
  request/transport metadata. Observations must be simulatable from that budget.
- **I-14.2** Requests and logs introduce no unrelated persistent identifiers,
  telemetry, or linkage beyond the fixed profile budget and inherent public
  linkage, including the
  [custody contract address carried by deposits/spends](https://github.com/midnightntwrk/passport/blob/5d12798321d3daba37b1da90162ee1468daf38a6/docs/mps-mip/mips/mip-xxxx-native-asset-custody.md#L608-L618).
- **I-14.3** An architecture leakage claim inventories all relevant off-device
  component views and their combined observations: prover, chain, guardians,
  network endpoints/timing, transport, and logging as applicable. Required views
  cannot be silently omitted to obtain a prover-plus-chain bound; each must fit
  a fixed budget or have a justified, explicit assumption limiting the claim.

### P15 · Guardian privacy

**Your recovery contacts stay private.** The chain must not reveal who they
are, and each contact receives only the information allowed for its role.
This is not a promise of network anonymity: ordinary transport exposes
endpoints/timing, and privacy against contacts depends on prior knowledge and
collusion.

**Invariants.**

- **I-15.1** Passive chain observers learn no guardian identities or roster,
  requests, responses, or guardian graph. Permitted chain leakage is limited to
  recovery configuration existence, public-share count, session timing/frequency,
  and routine-versus-churn activity, with account/public context fixed for
  comparisons. Confidential authenticated transport protects message contents
  and authenticates parties, but does not hide endpoints or timing; stronger
  network anonymity requires its own mechanism and assumptions.
- **I-15.2** Each supported protocol/transport profile fixes an exhaustive,
  normative budget for individual and sub-quorum guardian views, anchored to
  documented messages and an explicit corruption model. It must not disclose
  other guardians' identities/roster. Prior knowledge, coordination, and traffic
  observations are explicit assumptions, not silently omitted views; removing
  another guardian is not unconditionally indistinguishable.
- **I-15.3** A profile may permit only purpose-required account/session
  identifiers, the guardian's evaluation index and own share/reply/liveness
  information, minimum authentication fields justified by their specified
  purpose, and unavoidable ordinary-transport endpoint/timing metadata.
  Unrelated persistent identifiers, telemetry, and unnecessary fields are
  prohibited. Missing exhaustive budgets remain unresolved obligations, and
  providers cannot widen them. A colluding **t+1** quorum can reconstruct
  recovery authority and viewing capability; historical quorums may retain
  viewing capability for historical artefacts/pre-rotation history, and
  potentially current holdings if viewing material remains stable.

### P16 · Upgrade safety

**Upgrades do not take away access, funds, or identity.** An upgrade needs
account authorisation and must leave authorised devices actually able to
operate, preserve holdings, and preserve identity answers in the same context.

**Invariants.**

- **I-16.1** No upgrade takes effect without authorisation from the account
  itself. No operator, deployer, or circuit author can upgrade an account
  unilaterally.
- **I-16.2** An upgrade preserves both the set of authorised devices and their
  actual authorisation capability.
- **I-16.3** An upgrade preserves holdings except actual ledger movements,
  with fees separately attributed to their payer and fee asset.
- **I-16.4** An upgrade preserves identity observations: every attribute
  question answerable before remains answerable with the same answer when
  compared in the same ledger/credential context.

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
| **P5′** | Recovery-authorised | I-5′.1 … I-5′.2 |
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
  recovery-authority safety (only an authorised pending record can replace
  authority). It does not rule out recovery by a colluding quorum or certify
  human consent. P5 alone is compatible with unauthorised replacement.
- **P11 ↔ P4, P6, P7.** Revocation and key protection matter because P11
  requires live device or live in-scope grant authorisation. P7 supplies the
  chain-enforced scope/bounds for grantee spends; no account device key is needed.
- **P13 ↔ P11.** The liveness dual: P11 alone is satisfied by a wallet that
  never releases anything, P13 alone by one that releases to anybody.
- **P13 ↔ P8.** I-13.2 (no particular ancillary operator is indispensable)
  is the spending case of I-8.3. P13's preservation duty complements I-8.1:
  client-only loss of change descriptions is an obligation to fix, not grounds
  to weaken chain-only operation.
- **P12 ↔ P16.** I-16.3 (upgrades preserve holdings except actual ledger
  movements) is the upgrade case of I-12.3; fees are attributed by payer/asset,
  and asset compensation needs separate spend authorisation.
- **P14 ↔ P9.** P9 bounds what a *proof* reveals to its verifier; P14 bounds
  what producing it reveals to the prover under fixed profile budgets.
  Architecture-wide claims must cover all relevant off-device observer views.
- **P15 ↔ P5, P6.** Recovery helpers hold shares under I-6.4; P15 separates
  chain, network, sub-quorum, and quorum views. A colluding quorum's recovery/
  viewing capability is a trust limit, not a denial of the intended share scheme.
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
