---
MIP: X
Title: Recovery Paths for Custody Accounts
Authors:
  - Nicolas Di Prima ({github})
Status: Draft
Category: Standards
Created: 2026-08-24
Requires: MIP-0012, MIP-0013
Replaces: N/A
---

<!--
Licensed under the Apache License, Version 2.0 (the "License"); you may
not use this file except in compliance with the License. You may obtain
a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
-->

<!-- WORKING DRAFT. Sections marked with a tag are pending evidence:
     [CRYPTO-MEMO] = the commissioned multi-session review, [EXP] = the
     reference implementation, [RULING] = an open editorial ruling. Every
     other section is settled. -->

## Table of contents

- [Abstract](#abstract)
- [Motivation](#motivation)
- [Specification](#specification)
  - [1. Roles and objects](#1-roles-and-objects)
  - [2. Keys, secrets, and domain separation](#2-keys-secrets-and-domain-separation)
  - [3. Guardian identity and key derivation](#3-guardian-identity-and-key-derivation)
  - [4. Share derivation](#4-share-derivation)
  - [5. The session operation](#5-the-session-operation)
  - [6. The recovery operation](#6-the-recovery-operation)
  - [7. Guardian transport](#7-guardian-transport)
  - [8. On-chain structures](#8-on-chain-structures)
  - [9. Invariants](#9-invariants)
  - [10. Versioning](#10-versioning)
- [Rationale](#rationale)
- [Path to Active](#path-to-active)
- [Backwards Compatibility Assessment](#backwards-compatibility-assessment)
- [Security Considerations](#security-considerations)
- [Implementation](#implementation)
- [Testing](#testing)
- [References](#references)
- [Acknowledgements](#acknowledgements)
- [Copyright Waiver](#copyright-waiver)

## Abstract

Custody accounts under MIP-0012 and MIP-0013 are controlled by rolling
per-device keys derived from platform authenticators. There is no seed
phrase: loss of every enrolled device is, without further provision,
loss of the account, and loss of the account's viewing secret orphans
its shielded holdings even when control is regained. This proposal
specifies recovery paths for such accounts. The core mechanism is a
community-based backup of an ephemeral recovery secret using bottom-up
secret sharing, in which guardians persist no per-account state: each
guardian's share is recomputed on demand from a secret bound to their
own authenticator credential. The account contract stores a public
recovery artefact, a commitment gating a recovery operation, and an
authenticated encryption of the account viewing key under a key derived
from the recovery secret. Recovering the secret therefore restores both
control (a new device key is enrolled through the recovery gate) and
visibility (the viewing key decrypts). The specification defines the
guardian model, share derivation, the session operation that publishes
and refreshes the artefact set, the recovery operation with its veto
window, the off-ledger guardian transport, and the invariant family a
conforming implementation must satisfy. Profiles instantiate the
guardian secret for WebAuthn PRF credentials and for cold signers.

## Motivation

MPS-0018 names recovery as an unresolved obligation of the custody
model: an account whose authorisation set can be lost needs a specified
path back that does not reintroduce a seed phrase or a custodian.

### The failure mode is total and silent

An account under MIP-0013 is controlled by a set of device entries,
each a commitment to a key that the device's platform authenticator
holds and that never leaves it. This is deliberate. The seed phrase is
the single most common cause of both loss and theft in self-custody,
and an account that never mints one cannot leak one. The cost of that
choice is concentrated in one place: when the last enrolled device is
gone, nothing in the protocol can distinguish the legitimate owner from
anybody else, and the account becomes permanently unreachable.

Under contract custody the assets are not destroyed. They remain held
by the contract exactly as they were, correctly accounted, and visible
in the ledger. They are simply beyond reach forever. This is the
zombie-state failure in its sharpest form: public custody state that
survives in perfect health while the private state that governs it has
ceased to exist.

### Restoring control is not sufficient

An account's shielded holdings are governed by a viewing secret as well
as by an authorisation set. An owner who regains control but not
visibility holds an account whose shielded balance cannot be
enumerated, whose incoming coins cannot be detected, and whose value
therefore cannot be spent. Any recovery path that restores only the
authority to sign leaves the account half-recovered. The specification
consequently treats visibility as part of the object to be recovered,
and states the retroactive-trust cost that this choice carries in
Security Considerations.

### Why existing Midnight capabilities are inadequate

No upstream document covers this. The register runs to MPS-0037 and
MIP-0015 and contains no proposal addressing recovery, guardians, or
account backup. The two adjacent tracks explicitly defer to this one:
the soulbound credential work scopes itself to credential re-binding
and refers asset recovery to the MPS-0018 orbit, and the credential
primitive defers holder recovery to a companion recovery document that
has not been drafted.

MIP-0015 (Wallet-derived deterministic secrets) takes the opposite
branch of the same fork and is worth stating precisely, because its
rationale contains the objection this proposal answers. MIP-0015
derives application secrets deterministically from a BIP-32 seed, and
rejects the WebAuthn PRF extension as an alternative on the ground that
a PRF secret is credential-bound: lose the authenticator, lose the
secret. For a wallet that already has a seed, that reasoning is sound
and MIP-0015 is the right construction. It is unavailable to an account
whose design premise is that no seed exists anywhere. The two documents
are therefore complementary rather than competing: MIP-0015 obtains
durability from a mnemonic, and this proposal obtains it from a
community, so that credential-bound secrets can stay credential-bound
without the account becoming unrecoverable.

MPS-0035 (shielded spend authorisation requires exposing the spend key)
argues for signature-based spend authorisation so that keys can live in
a secure element rather than be witnessed in the clear. That is the
same seam this proposal gates, and a recovery path must not assume the
authorising key is extractable. The specification is written so that
the recovery gate binds a successor authority without ever requiring
the old authority to be exported.

### What a solution must not do

Three shapes are ruled out by the setting rather than by preference. A
seed phrase reintroduces the failure mode the account design exists to
remove. A custodian who can restore the account is a party who can also
take it, which contradicts the custody model. A recovery mechanism that
requires guardians to hold durable per-account state makes every
guardian a small custodian with a backup problem of their own, and the
empirical record of such designs is that the state is what rots.

## Specification

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

### 1. Roles and objects

- **Account**: a custody contract per MIP-0012 with authorisation per
  MIP-0013.
- **Owner**: the party controlling the account's enrolled devices.
- **Guardian**: a party assisting recovery. A guardian identity is a
  single authenticator credential (see section 3), not a person; one
  person MAY hold several guardian identities.
- **Recovery secret `s`**: an ephemeral field element. It exists during
  session setup and during recovery only. Implementations MUST NOT
  persist `s` (see REC-6 and Security Considerations).
- **Viewing key `vk`**: the account's stable shielded viewing secret,
  created at account birth, independent of the recovery subsystem.
- **Artefact set**: the on-chain triple published per session:
  public shares `phi`, recovery commitment, and viewing-key wrap.
- **Session**: one execution of the operation in section 5, identified
  by a session identifier and characterised by a freshly sampled `s`.
- **Roster**: the guardian set of a given session, of size `n`, with
  reconstruction threshold `t+1`.

### 2. Keys, secrets, and domain separation

`s` is a field element of the scalar field exposed by the Compact
`Field` type. It MUST be sampled uniformly at random from that field by
a cryptographically secure generator, independently for every session.
An implementation MUST NOT derive `s` from any prior `s`, from the
session identifier, or from any account-durable value: independence
across sessions is the property the whole construction rests on.

Two distinct keys are derived from `s`, and they MUST be
domain-separated from each other:

- the **gate key**, committed on-chain and proved in the recover
  circuit (section 6);
- the **wrap key**, used to encrypt `vk` (section 8).

Domain separation follows the tag-family convention MIP-0013 section 10
establishes for this account family. This proposal registers:

| Tag | Purpose |
|---|---|
| `midnight:account:recovery:guardian:v1` | guardian secret derivation (section 3) |
| `midnight:account:recovery:share:v1` | share derivation (section 4) |
| `midnight:account:recovery:commit:v1` | gate key and its commitment (section 6) |
| `midnight:account:recovery:wrap:v1` | wrap key for `vk` (section 8) |

A conforming implementation MUST use these tags and MUST NOT reuse a
tag from another family for these purposes.

The exact key-derivation construction (an extract-then-expand
function), the uniform sampling procedure for `s`, and the mapping of a
32-byte authenticator PRF output to a field element without modulo bias
are the subject of [CRYPTO-MEMO Q4] and [CRYPTO-MEMO Q5], and are
stated here as MUSTs once that memo lands. Until then, implementations
SHOULD use a wide-reduction or rejection-sampling construction rather
than plain modular reduction of 256 bits against a modulus of
approximately 255 bits.

### 3. Guardian identity and key derivation

Core contract (normative): a guardian secret MUST be deterministically
recomputable on demand from the guardian's durable authenticator, MUST
require no stored per-account state, and MUST be domain-separated from
every other secret derived from the same authenticator.

- **Profile A (WebAuthn PRF)**: the guardian secret is the PRF output
  of the guardian's credential under the registered salt
  `midnight:account:recovery:guardian:v1`, mapped to a field element as
  specified in section 2. Evaluation requires user verification; the
  secret exists transiently per ceremony. A credential synced by its
  provider serves from any of the guardian's devices; a device-bound
  credential serves from that authenticator only. Wallets SHOULD
  surface which kind a guardian enrolled, because the two carry
  materially different availability and loss profiles.
- **Profile B (cold signer)**: the guardian secret is derived from a
  deterministic signature (RFC 6979 or BIP-340) over the session
  binding. WebAuthn signatures are not deterministic and MUST NOT be
  used with this profile.

A guardian identity is the credential, not the person. Aggregation of
several credentials held by one person is a wallet presentation
concern; parameter guidance for collusion resistance counts people, not
credentials (see Security Considerations).

Cross-wallet portability of a guardian additionally depends on shared
relying-party infrastructure for credential evaluation; this is a
stated dependency, not delivered by this proposal. Authenticator
credential-exchange formats now shipping in platform authenticators
change what losing a credential means over the life of an account, and
a guardian whose credential is transferred to a new device remains the
same guardian under this specification, because the guardian secret
follows the credential.

### 4. Share derivation

A guardian's share for a session is derived, not stored:

```
sigma_ij = H(DST_share, sid_i, pk_i, sk_j)
```

where `DST_share` is `midnight:account:recovery:share:v1`, `sid_i` is
the session identifier, `pk_i` identifies the owner account, and `sk_j`
is the guardian secret from section 3.

Inputs MUST be encoded unambiguously, with fixed-width or
length-prefixed encoding for every field, so that no two distinct input
tuples produce the same preimage. `H` MUST be the hash registered for
the account's profile.

The security statement under which this construction is claimed across
many sessions, and the precise conditions under which correlated
sessions would degrade the threshold, are the subject of
[CRYPTO-MEMO Q1] and [CRYPTO-MEMO Q2]. The published scheme's formal
model is single-session; the multi-session rules in section 5 are this
specification's own normative addition and the memo either establishes
or refutes them.

### 5. The session operation

There is exactly one artefact-publishing operation: **new recovery
session**. A session MUST use a session identifier distinct from every
identifier previously published for the account (REC-4), MUST sample a
fresh `s`, MUST collect fresh shares from every guardian in the new
roster, and MUST publish the artefact set atomically in one
transaction. There is no standalone rewrap or partial-update operation;
public-share update without a full re-share MUST NOT be used unless
[CRYPTO-MEMO Q3] affirms its safety. [RULING pending that memo.]

Variants:

- **Routine** (roster change, credential replacement): `vk` unchanged;
  the wrap re-encrypts the same `vk` under the new wrap key.
- **For cause** (a guardian is no longer trusted): the session SHOULD
  be accompanied by rotation of `vk` and re-encryption of the account's
  shielded state under the new key (churn), because artefact history is
  permanent and a hostile past quorum otherwise retains a decryption
  capability for the current `vk`.

Ordering: a session MUST complete before any churn that depends on it.

The contract MUST reject a session whose identifier equals the
currently stored one, and MUST reject a recovery commitment equal to
the currently stored one (defence in depth against accidental reuse).
Equality with the stored value is the only reuse a contract can
observe: genuine freshness, meaning independent randomness in the
client, remains a client obligation and cannot be enforced on-chain.
This asymmetry is deliberate and is restated in Security
Considerations, because reading the on-chain check as the actual
defence is the most likely misreading of this section.

### 6. The recovery operation

1. The recovering owner obtains `t+1` shares from guardians over the
   off-ledger transport (section 7).
2. Reconstruction of `s` from the shares and the on-chain `phi`.
3. The recover circuit verifies knowledge of `s` against the stored
   commitment: it takes the successor device commitment and the
   successor recovery commitment as public arguments, witnesses `s`,
   recomputes the gate commitment under
   `midnight:account:recovery:commit:v1`, and asserts equality with the
   stored value. The proof MUST bind the successor device key, the
   successor recovery commitment, and the account epoch, so that a
   proof cannot be replayed to enrol a different successor. Following
   the pattern established for the authorisation seam, the gate is a
   dedicated circuit per key profile rather than an in-circuit
   conditional over profiles, which keeps a seam open for future
   authenticator-native arms without an in-circuit branch.
4. **Veto window**: finalisation MUST NOT occur until a block-time
   bound has elapsed, during which an enrolled device MAY cancel the
   pending recovery. The window uses the standard-library block-time
   comparators over the kernel block-time predicates. Two properties of
   those comparators are load-bearing and MUST be accounted for by an
   implementation:
   - they compare wall-clock seconds, and there is no block-height
     primitive to use instead, so the window is a wall-clock window;
   - they do not incorporate the block-timestamp error bound, so a
     specification or deployment MUST state the timestamp tolerance it
     assumes, and MUST choose a window materially longer than that
     tolerance.

   Duration is a deployment parameter. It MUST be long enough that an
   owner in possession of an enrolled device can reasonably observe the
   pending recovery and act, and wallets SHOULD default to a window
   measured in days rather than hours. A cancel MUST invalidate the
   pending recovery immediately and MUST NOT itself be subject to the
   window. A cancel SHOULD be available to any enrolled device, not
   only to the device that most recently authorised.
5. Finalisation enrols the successor device key and bumps the account
   epoch, which invalidates every previously enrolled device and every
   outstanding grant in a single step.
6. The wrap decrypts under the wrap key derived from `s`, restoring
   `vk`.
7. The wallet SHOULD run a fresh session promptly after recovery. Until
   it does, the account has no recovery backup: the recovered secret
   has been rotated and the published `phi` cleared.

### 7. Guardian transport

Share requests, share responses, and liveness attestations MUST NOT be
written to the ledger. Guardian identities and the guardian graph
therefore never appear on-chain.

The transport MUST provide confidentiality and authentication of both
endpoints. A share response MUST NOT be sent to a party that has not
been authenticated as the owner of the named account, and the
specification of that authentication is a wallet responsibility rather
than a protocol one, for the same reason it is out of protocol in
comparable designs: it is a human-recognition problem, not a
cryptographic one.

Message shapes (fields, not encodings; encodings are a profile
concern):

| Message | Fields | Direction |
|---|---|---|
| `ShareRequest` | session identifier, account identifier, requester authentication material | owner to guardian |
| `ShareResponse` | session identifier, `sigma_ij` | guardian to owner |
| `LivenessAttestation` | session identifier, proof of ability to recompute `sigma_ij` without revealing it | guardian to owner |

Wallets MUST implement a periodic liveness attestation; its cadence is
a SHOULD. The attestation exists because the guardian-side failure in a
zero-storage design is silent: a guardian whose credential is gone
looks exactly like a guardian who has not been asked recently, and
without attestation an owner discovers an under-strength roster only at
the moment of recovery, which is the one moment at which it cannot be
repaired.

### 8. On-chain structures

The artefact set is three objects plus a session identifier:

| Object | Type | Notes |
|---|---|---|
| recovery commitment | field element | the gate commitment of section 6 |
| `phi` | bounded vector of field elements | public shares; length fixed by roster size and threshold |
| viewing-key wrap | authenticated ciphertext | `vk` under the wrap key of section 2 |
| session identifier | 32 bytes | distinct per session (REC-4) |

`phi` is a bounded vector because contract state must be statically
bounded; the bound is a profile parameter and caps the roster size that
a given deployment supports. Unused slots MUST be zero and MUST be
gated by an explicit length field, so that a shorter roster cannot be
read as a longer one with zero-valued shares.

The wrap MUST be an authenticated encryption. Requirements on the AEAD
(key commitment, nonce policy) and on the separation of the wrap key
from the gate key are the subject of [CRYPTO-MEMO Q5].

[EXP] Concrete sizes, proof costs, and the achievable roster bound come
from the reference implementation; see Implementation.

### 9. Invariants

- **REC-1 (Safety)**: only a party reconstructing the current `s` can
  pass the recover gate.
- **REC-2 (Liveness)**: with `t+1` honest reachable guardians and the
  on-chain artefact set, the owner can reconstruct `s` and complete
  recovery.
- **REC-3 (No guardian storage)**: guardians persist no per-account
  state; shares are recomputable on demand.
- **REC-4 (Session freshness)**: every published artefact set uses a
  previously unused session identifier and a freshly sampled secret.
- **REC-5 (Removal effectiveness)**: after a session excluding a
  guardian, the excluded guardian contributes nothing to recovery of
  the current secret.
- **REC-6 (Ephemeral secret)**: `s` is never at rest; it exists during
  session setup and recovery only.
- **REC-7 (Viewing restoration)**: successful recovery yields the
  current `vk`.
- **REC-8 (Recovered account, recovered assets)**: after finalisation
  the new device controls the account with all custodied assets and
  their visibility intact.
- **REC-9 (Veto)**: a recovery cannot finalise while an enrolled device
  remains able to cancel within the window.

REC-1 and REC-2 refine the user-level safety and liveness properties
tracked by the formal specification of the architecture. TODO:
cross-reference once published.

### 10. Versioning

The artefact set carries a version tag. A conforming reader MUST reject
an artefact set whose version it does not implement rather than attempt
a best-effort parse, because a misparsed `phi` yields a reconstruction
failure that is indistinguishable from an under-strength roster.

Guardian key profiles (section 3) are a registry: a profile fixes the
guardian secret derivation, the hash for section 4, and the field
mapping. Adding a profile is a registry addition and does not require a
new version of the artefact set. An account's roster MAY mix profiles,
because a share is a field element regardless of how the guardian
secret was obtained.

A future traceable arm, in which a leaked share can be attributed to
the guardian that leaked it, is anticipated as a v2 artefact set. It
changes the artefact layout rather than the roles, the transport, or
the invariants, so v1 and v2 accounts can coexist and an account can
migrate by running one session under the new version. Parameter
guidance that would keep v2 reachable without re-parameterising v1 is
[CRYPTO-MEMO Q6].

## Rationale

### Choice of scheme

The mechanism is bottom-up secret sharing, in which guardian shares are
derived from guardian-held secrets and the dealer publishes a public
correction vector, rather than a design in which the dealer distributes
shares that guardians must keep.

| Design | Guardian storage | Guardian graph | On-chain artefact | External validation | Why not selected |
|---|---|---|---|---|---|
| **Bottom-up secret sharing (selected)** | none | off-chain | compact public vector | peer-reviewed 2026; no audit-grade implementation | selected |
| Helper-stored shares (DeRec) | per-owner state, with challenge-response upkeep | fully off-chain | none | alliance specification, alpha implementation | every helper acquires a durable backup problem; see below |
| Smart-account guardian modules | none | fully public on-chain | guardian set | most mature by far: multiple audits, formal verification, large deployed user base | publishes the guardian graph, which is the privacy property this account family exists to protect |
| Proof-of-email guardians | none | partially public | proof artefacts | audited, deployed on mainnet wallets | inherits the guardian graph exposure and an external trust root |
| Threshold-key resharing | key share, durable | off-chain, deniable | none | standardised signing, non-standard distributed key generation and resharing | heaviest guardian burden, and refresh is the empirically fragile step |
| Provider-held encrypted backup | none | none | none | very large deployed scale | reintroduces a party that can restore, and therefore take, the account |

The selection follows from the setting rather than from maturity: it is
the only design in the table that combines zero guardian storage,
off-chain guardian identities, and a compact public artefact. That
combination is what allows a guardian to be an ordinary person with an
ordinary phone who is never asked to keep anything, and whose
participation is not published.

Maturity is the honest cost of that choice, and this proposal does not
minimise it. The selected scheme is peer-reviewed but thinly cited and
has no audit-grade implementation, whereas the guardian-module design
it displaces has audits, formal verification, and users. The mitigations
are the commissioned review that Path to Active makes a gate, the
conformance suite, and a specification written to be implementable
without the reference library.

### Relationship to helper-stored designs

Helper-stored recovery is the ecosystem's default mental model, and an
account holder who has met recovery before has probably met it in that
form. The difference is narrow and worth stating plainly rather than
leaving implicit: both designs distribute trust across a threshold of
helpers, and both keep the helper graph off-chain. They differ in what
a helper is asked to do between ceremonies. A helper that stores state
must keep it, prove periodically that it still has it, and re-receive
it whenever membership changes. A guardian that stores nothing is asked
only to be reachable and to re-derive on demand. This proposal takes
the second position because durable state held by many
loosely-motivated parties is, on the available evidence, the component
that decays.

The two are not exclusive at the ecosystem level: an account can have
guardians under this proposal and an independent encrypted backup
elsewhere, and nothing here forbids that.

### Wrap, not derive

`vk` is independent of `s` because their lifecycles differ. The viewing
key exists from the account's first shielded coin; guardians are
optional and typically arrive later. Deriving `vk` from `s` would make
every roster change a re-keying of the account's entire shielded view,
with a re-encryption of shielded state behind it. Wrapping instead
leaves `vk` stable and makes a roster change a cheap operation, at the
cost of the historical-artefact residual documented in Security
Considerations.

### Ephemeral `s`

`s` passes the recover gate and is therefore a takeover credential
equivalent to the account itself. Holding it at rest would convert any
device compromise into a permanent, undetectable account takeover, and
would do so in exactly the population least able to notice. No
operation requires an old `s`: every artefact write mints a fresh
secret in a fresh session, so the value never needs to survive its
ceremony.

### Guardian is a credential

The protocol binds shares to the credential that computed them, so the
credential is the natural unit of identity. Presenting several
credentials held by one person as one guardian is a wallet concern.
Security parameters are the place where the distinction bites, and the
guidance there counts people, because a threshold of credentials held
by one person is a threshold of one person.

### Padding considered and rejected

The artefact length reveals only the public-share count, from which an
observer learns the minimum cost of a guardian-corruption attack but
neither the targets nor the channels, which remain off-ledger. Padding
to fixed capacities would add trial reconstruction at recovery time and
protocol complexity disproportionate to what it conceals.
Implementations MAY pad; nothing in this specification depends on it.

### Why the freshness rule is client-side

A contract can compare a submitted value with the value it stores, and
nothing more. It cannot observe that a client sampled independently,
which is the property that actually matters, and it cannot see the
history of values it no longer holds. Specifying the on-chain check as
a tripwire rather than as the defence is therefore not a weakening: it
is an accurate description of what the enforcement point can do, and
stating it accurately is what allows an implementer to see that the
client obligation is load-bearing.

## Path to Active

### Acceptance Criteria

- [ ] Cryptographic review memo covering the multi-session security
      statement, the public-share-update verdict, and the sampling,
      mapping, and AEAD constructions, with its conclusions folded into
      sections 2, 4, 5, 8, and 10.
- [ ] Reference implementation of the session and recovery operations
      in the custody reference contract, with conformance suites
      passing on a devnet-matching network. [EXP: partially met, see
      Implementation]
- [ ] Veto window and cancel path implemented and exercised end to end
      on a local network. [EXP: not met]
- [ ] Viewing-key wrap published, recovered, and round-tripped through
      the artefact set. [EXP: not met]
- [ ] Liveness attestation and transport messages implemented by at
      least one wallet provider.
- [ ] MPS-0018 lists this MIP under Recommended MIPs.
- [ ] Community review period completed.

### Implementation Plan

The specification stacks on the MIP-0012 and MIP-0013 reference
implementation, which already carries a session operation and a
recovery gate (see Implementation). Remaining work divides into three
independent tranches that can proceed in parallel:

1. **Contract**: veto window and cancel path; the viewing-key wrap as
   contract state; the version tag of section 10.
2. **Cryptographic**: the commissioned memo, and the normative
   constructions it fixes in sections 2 and 4.
3. **Wallet**: transport messages, liveness attestation, and the
   guardian-facing ceremony, with at least one wallet provider.

The formal specification of the architecture refines REC-1 and REC-2;
that work is tracked separately and is not a gate on this document.

## Backwards Compatibility Assessment

Additive. The proposal introduces new circuits on the custody contract
and requires no ledger change and no hard fork. Existing accounts adopt
recovery by running a first session; accounts that never run one are
unaffected and behave exactly as they do today. Recovery at birth is
preserved by accepting an initial artefact set at deployment.

The veto window relies on block-time comparators that are present in
current toolchains, including the line the reference implementation
pins, so the window introduces no new platform dependency. Normative
text cites primitives with an applicability note for ledger 9
toolchains rather than pinning a toolchain version, because the
release line has moved and a version pin would date the document.

Contract state survives the ledger 9 hard fork, which migrates a
running chain rather than requiring a fresh one, so an account that
publishes an artefact set today does not need a redeploy story to keep
it. Implementations SHOULD NOT, however, assume that auxiliary ledger
subsystem state survives a fork on the same terms: the same upgrade
rebuilds dust-generation state, which is precedent that not every
subsystem is carried across untouched. Nothing in the artefact set
depends on such state, and this note exists so that a future profile
does not introduce such a dependency inadvertently.

Dormant accounts: an account whose artefact set was published under an
earlier profile or version remains recoverable under that profile for
as long as the profile is registered. Retiring a profile therefore
requires a deprecation path and MUST NOT be done by removal alone,
because the population that most needs recovery is exactly the
population that has not been running sessions.

## Security Considerations

- **Session-identifier reuse**: reuse with an unchanged roster
  collapses the independence of the two ceremonies; the difference of
  the two secrets becomes computable from public data alone, and one
  quorum then opens both. The freshness requirement (REC-4) is the
  actual defence; the on-chain inequality check is a tripwire only, for
  the reason given in Rationale. [CRYPTO-MEMO Q1] supplies the worked
  analysis this clause cites.
- **Historical artefacts**: chain history is permanent. A past `t+1`
  quorum retains the ability to decrypt the wrap of its era; with a
  stable `vk` that capability reaches the present, which is why
  for-cause removal SHOULD churn. Retroactive viewing of pre-rotation
  history is unavoidable in any design in which recovery restores
  viewing; this residual is accepted and stated rather than mitigated.
- **Leakage inventory** (accepted, documented): existence of a
  recovery configuration; the public-share count; session timing and
  frequency; distinguishability of routine sessions from for-cause
  sessions with churn. Guardian identities, channels, and the guardian
  graph never appear on-chain (section 7 transport MUST).
- **Coercion**: the on-chain data yields attack cost, not targets. An
  adversary learns how many guardians would have to be corrupted, but
  not who they are or how to reach them.
- **Offline verification oracles**: the commitment and the wrap allow
  candidate verification of guesses at `s`; a single missing share
  carries full field entropy, which is what makes offline search
  infeasible. [CRYPTO-MEMO Q5] confirms this argument and fixes the
  AEAD requirements that it depends on.
- **Threshold counted in people**: a roster of `n` credentials held by
  fewer than `n` people has a lower effective threshold than its
  parameters suggest. Wallets SHOULD encourage rosters spanning
  distinct people and SHOULD warn when several guardian credentials
  share an obvious provider or device.
- **Guardian authenticity and Sybil resistance**: establishing that a
  guardian is the person the owner believes them to be is out of scope
  of the mechanism, as it is in comparable designs. It is a wallet and
  social concern, and the mechanism's guarantees are conditional on the
  owner having chosen guardians correctly. This proposal does not claim
  otherwise, and a wallet SHOULD make the trust assumption explicit at
  enrolment rather than presenting guardianship as a purely technical
  step.
- **Cold start**: an account with no community at hand has no roster to
  publish, and is the population most likely to be lost. The available
  position is paper keys as virtual guardians: a guardian secret
  generated and printed rather than held in an authenticator,
  participating in the protocol identically. This preserves the
  mechanism at the cost of reintroducing a physical artefact, and it is
  offered as a profile rather than as the default. [RULING: the
  paper-key profile is described but not yet specified; whether it
  belongs in this document or a successor is open.]
- **Emergency viewing-key rotation** while guardians are unreachable
  leaves recovery restoring a stale `vk` until a session completes;
  wallets MUST warn.
- **Denial of service against the window**: a recovery submitted
  repeatedly forces an owner to cancel repeatedly. Cancellation is
  cheap relative to submission and the epoch is not bumped by a
  cancelled attempt, so the attack costs the adversary more than the
  owner, but a wallet SHOULD surface repeated attempts rather than
  silently cancelling them, because a pattern of attempts is itself
  evidence the owner needs.
- **Comparable-design failure precedent**: a published vulnerability in
  a widely used threshold-signature library arose specifically in share
  refresh, where a refresh performed with different parameters degraded
  security, and remediation required migrating to a fresh key. Refresh
  is the fragile operation in this class of protocol, which is why this
  proposal admits exactly one artefact-publishing operation with a
  mandatory fresh secret rather than a family of partial updates.

## Implementation

A reference implementation exists in the custody prototype that
accompanies MIP-0012 and MIP-0013, and its current state is stated here
precisely, because the gap between it and this specification is what
Path to Active tracks.

**Implemented and exercised**: the session operation, as a
device-authorised circuit that publishes the recovery commitment, the
public-share vector as typed field elements, and the session
identifier, with the on-chain freshness backstop of section 5
(rejecting reuse of the stored session identifier and of the stored
commitment) and an explicit length field gating unused slots; the
recovery gate, which witnesses the recovery secret, recomputes the
commitment through a pure derivation circuit, asserts equality, bumps
the device epoch, enrols the successor device, rotates the recovery
commitment, and clears the published vector.

**Not yet implemented**: the veto window and the cancel path, so
recovery in the reference implementation finalises immediately; the
viewing-key wrap, which is specified in section 8 but has no
corresponding contract state, so REC-7 is unexercised; the transport
messages and liveness attestation of section 7; the version tag of
section 10.

**Bound**: the reference implementation's public-share vector is capped
at four slots, which bounds the roster sizes it supports. The bound is
an implementation parameter rather than a property of the scheme, and
section 8 specifies it as a profile parameter for that reason.

[RULING G] A proof-of-concept library implementing the underlying
scheme exists and was used to validate the approach. It is unaudited,
declares itself unsuitable for production, and has been dormant since
mid-2026. This specification is consequently written to be
implementable from its own text and does not normatively depend on that
library; it is cited as evidence that the construction works, not as a
component. Capabilities present in that library but unused here (a
traceable variant, a signature-derived guardian secret, and public-share
update without re-share) informed section 3 and section 10, and the
last of them is precisely what [CRYPTO-MEMO Q3] must rule on before it
could be admitted.

## Testing

A conforming implementation SHOULD provide:

- **Session freshness**: rejection of a repeated session identifier and
  of a repeated recovery commitment; acceptance of a fresh pair;
  rejection of an all-zero identifier from a broken generator.
- **Recovery lifecycle**: publish, reconstruct from exactly `t+1`
  shares, pass the gate, finalise, and confirm the epoch bump
  invalidates prior devices and outstanding grants.
- **Threshold behaviour**: reconstruction fails with `t` shares and
  succeeds with `t+1`; an excluded guardian's share from a prior
  session does not contribute (REC-5).
- **Veto and cancel**: finalisation blocked before the window elapses;
  cancel invalidates a pending recovery; cancel is itself not subject
  to the window; a cancelled attempt leaves the epoch unchanged.
- **Wrap round-trip**: `vk` published under a session, recovered
  through that session's secret, and shown to decrypt current shielded
  state (REC-7).
- **Malformed artefacts**: non-zero unused slots rejected; length field
  inconsistent with the vector rejected; unknown version rejected
  rather than best-effort parsed.
- **Liveness attestation**: a guardian able to recompute attests
  successfully; a guardian whose credential is gone fails, and the
  failure is visible to the owner before recovery is needed.
- **Cross-implementation vectors**: share-derivation test vectors, so
  that two independent wallets derive identical shares for the same
  session, account, and guardian secret.

## References

- MPS-0018, Multi-key Account Custody for Midnight-Native Assets.
- MIP-0012, Contract Custody of Midnight-Native Assets.
- MIP-0013, Multi-key Account Authorisation for Custody Contracts.
- MIP-0015, Wallet-derived Deterministic Secrets.
- MPS-0035, Shielded Spend Authorization Requires Exposing the Spend Key.
- ANARKey: bottom-up secret sharing. IACR ePrint 2025/551; IEEE
  EuroS&P 2026, DOI 10.1109/eurosp68448.2026.00037.
- Traceable bottom-up secret sharing. IACR ePrint 2025/2089;
  INDOCRYPT 2025, DOI 10.1007/978-3-032-13301-4_18.
- Leakage resilience of linear-reconstruction secret sharing. IACR
  ePrint 2026/833.
- CVE-2025-58359, share-refresh parameter flaw in a threshold-signature
  library.
- W3C Web Authentication, PRF extension.
- RFC 2119, Key words for use in RFCs.
- RFC 6979, Deterministic usage of DSA and ECDSA.
- BIP-340, Schnorr signatures for secp256k1.
- DeRec Alliance protocol specification.

## Acknowledgements

TODO. [RULING F: co-authorship and the reviewer acknowledgement are
pending the engagement plan; no name is recorded here without that
person's agreement.]

## Copyright Waiver

This document is licensed under the Apache License, Version 2.0, and
its authors have signed the Midnight Foundation Contributor License
Agreement. Portions of this document were drafted with the assistance
of a large language model; the named authors reviewed and are
accountable for its entire content.
