---
MIP: X
Title: Signature Schemes for Custody-Account Authorisation
Authors:
  - Nicolas Di Prima ({github})
Status: Draft
Category: Standards
Created: 2026-08-25
Requires: MIP-0012, MIP-0013
Replaces: N/A
---

<!--
Licensed under the Apache License, Version 2.0 (the "License"); you may
not use this file except in compliance with the License. You may obtain
a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
-->

<!-- WORKING DRAFT, 2026/08/25 fill from the evidence base. Remaining
     open items are tagged: [CRYPTO] = pending cryptographic review,
     [CIRCUIT] = pending circuit work, [DEP] = external platform
     dependency, [RULING] = pending an editorial confirmation. -->

## Abstract

MIP-0013 registers a single credential scheme for custody-account
authorisation (Schnorr over JubJub) and anticipates successors: its
versioning section defines the scheme identifier as the prefix of the
scheme's domain-separation tags and states that a successor scheme is
a new tag prefix under a new MIP. This proposal supplies the successor
machinery and the first successor. It defines the **scheme registry**:
how a credential scheme is identified, how its artefacts are kept
mutually unusable with every other scheme's by construction, and how
several schemes coexist on one account. It registers the **r1 scheme**:
ECDSA over secp256r1 as produced by WebAuthn platform authenticators
(passkeys). Under the r1 scheme the device credential never exists as
software key material; the authenticator signs inside its secure
element, and a dedicated circuit verifies the ECDSA signature together
with the WebAuthn signing envelope that produced it, binding the
account's challenge into the client data. Each scheme verifies in its
own specialised circuit; there is no in-circuit scheme conditional.
The **k1 scheme** (ECDSA over secp256k1), validated end to end on a
ledger 9 network while the secp256r1 language surface completes, is
registered with interim status and an explicit sunset. The registry,
the envelope binding, the challenge construction per scheme, and the
signature-form policy are specified so that independent wallet and
contract implementations interoperate at the signature boundary.

## Motivation

MIP-0013's scheme requires the signer to hold a JubJub secret in
software. That choice is deliberate and remains correct for the
software arm: JubJub is the proof system's embedded curve, the scheme
is FROST-compatible, and threshold signing over it is standardised.
It has one structural limit: keys that live in secure elements cannot
produce it. Platform authenticators sign ECDSA over secp256r1 and
nothing else; the strongest device-security posture available to
consumer hardware is therefore unusable for account authorisation
under MIP-0013 alone.

The limit matters because passkeys are the onboarding primitive of the
seedless account model: the credential that creates the account should
be able to authorise it directly, without a software key standing
between the secure element and the contract. MPS-0035 makes the same
argument at the Zswap layer (signature-based spend authorisation so
that keys can live in secure elements); this proposal is the
custody-account counterpart.

The platform now provides the verification capability. In-circuit
ECDSA over secp256k1 ships in the Compact toolchain under the ZKIR v3
backend, and the proof stack carries first-class secp256r1 arithmetic
with matching ZKIR v3 operations. One gap remains: the Compact
language surface for secp256r1 verification does not exist yet
([DEP], see Path to Active). The project's decision trail reflects
this: secp256r1 was agreed as the passkey-arm curve, with secp256k1 as
the validated interim.

Nothing upstream fills this slot. MPS-0009 and MPS-0010 request
signature-verification language primitives (the secp256k1 half of
which is essentially delivered); MIP-0003 specifies ledger-level
ECDSA; MPS-0035 argues the need at a different layer. No document
defines how credential schemes register, coexist, and isolate on a
custody account.

## Specification

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

### 1. Scheme registry

**1.1 Identifiers.** A credential scheme is identified by its
domain-separation tag family. MIP-0013 §10 defines the pattern: the
scheme registered there carries the identifier
`midnight:account:auth:v1`, the prefix of every one of its
`DST_CIRCUIT` tags, and "a successor scheme (a different curve, hash,
or policy structure) is a new tag prefix under a new or revising MIP".
Successor schemes insert an arm marker into every tag of the family.
This proposal registers:

| Scheme | Tag family | Credential | Status | Defined by |
|---|---|---|---|---|
| v1 | `midnight:account:{auth,device,boot}:v1` | Schnorr over JubJub (software key, FROST-capable) | Active | MIP-0013 |
| k1 | `midnight:account:{auth,device,boot}:k1:v1` | ECDSA over secp256k1 (software key) | **Interim** (sunset: section 4) | This MIP, section 4 |
| r1 | `midnight:account:{auth,device,boot}:r1:v1` | ECDSA over secp256r1 via WebAuthn (secure-element key) | Active upon [DEP] | This MIP, section 3 |

The trailing `:v1` segment versions the scheme itself; a revision of a
scheme's construction is a new trailing version under a revising MIP.
All tags are registered under the registry recommended by MPS-0027,
as MIP-0013 already requires for its own.

[RULING pending confirmation: the k1 row is registered with Interim
status rather than documented informatively. Rationale in the
Rationale section; the registry gains a Status column either way.]

**1.2 Scheme binding.** The scheme of every artefact (device entry,
boot commitment, challenge) is bound by using that scheme's tags in
the artefact's hash preimage. There is no readable per-entry scheme
field: MIP-0013's device store is `devices: Set<Bytes<32>>`, opaque
32-byte hashes with no value slot, and this proposal does not change
that shape. Consequences:

- A device entry is claimable only through circuits of the scheme
  whose tags constructed it (invariant SIG-1). Cross-scheme use fails
  at entry lookup, before any signature check.
- Clients MUST track each enrolled credential's scheme client-side,
  exactly as they already track the entry's use counter (which is also
  not readable state).
- An implementation MAY additionally maintain a readable scheme tag
  (for example, a map from entry to tag); this is an extension, not
  required for conformance, and carries an enumeration cost it must
  assess.

**1.3 Coexistence.** An account MAY hold device entries of several
schemes simultaneously. The shared ledger cells (`device_epoch`,
`device_count`, `auth_nonce`) are scheme-agnostic and count across all
schemes. Enrolment and removal ceremonies are unchanged: any device of
any scheme that can pass its own gate can enrol a device of any other
scheme, subject to the account's policy. Removing the last device of
one scheme leaves the account operable under its remaining schemes
(invariant SIG-5).

### 2. Per-scheme circuits and the challenge core

**2.1 One circuit per scheme.** Each gated operation exists in one
variant per scheme, each with its own `DST_CIRCUIT` tag and verifying
key, all instantiating the MIP-0012 seam semantics and MIP-0013's
four-step gate order (recompute entry, consume, verify, advance).
There is no in-circuit scheme conditional: a conditional over foreign
curve arithmetic pays for every branch in every proof, and specialised
circuits keep each scheme's cost minimal and each scheme independently
auditable.

**2.2 Challenge core.** Every scheme's challenge binds the same
operation tuple, per MIP-0013 §5.1:

```
[ DST_CIRCUIT(scheme, circuit), kernel.self(),
  <key encoding>, ...args, ...witness_values, auth_nonce, <tail> ]
```

hashed with `persistentHash`. The element rules of MIP-0013 §5.1
(full argument list in declaration order, every witness invocation's
values, the pre-increment counter, witness pinning per AUTH-10, the
network-identifier recommendation) apply to every scheme unchanged.
Two elements are scheme-dependent:

| Element | v1 (MIP-0013) | ECDSA schemes (k1, r1) |
|---|---|---|
| Key encoding | `pk: JubjubPoint` (field-aligned), preceded by `sig_r: JubjubPoint` | the two little-endian 32-byte affine coordinates, as `Bytes<32>` elements |
| Tail | `grind_nonce`, with rejection sampling of `h` below `r_J` (§5.2) | none |

The ECDSA deltas are structural, not stylistic. First, an ECDSA
message MUST NOT include the signature's own material, so the v1
tuple's `sig_r` element is removed rather than substituted (invariant
SIG-3). Second, ECDSA verification interprets the 32-byte challenge
as a big-endian integer and reduces it modulo the curve order
internally, so no grinding is needed and the `grind_nonce` element is
removed. Third, binding the key as coordinate bytes rather than a
compiler point type makes the whole preimage a tuple of byte atoms:
the encoding reduces to each element zero-padded to its declared
length and concatenated, so independent signer stacks reproduce the
challenge with a plain SHA-256, with no dependency on the compiler's
field-aligned layout. The k1 reference implementation demonstrates
all three, with cross-implementation vectors pinning bit-identical
challenges between the compiled contract and an independent Rust
signer.

### 3. The r1 scheme: WebAuthn ECDSA over secp256r1

**3.1 Credential and key.** The device credential is a WebAuthn
credential whose COSE public key is ECDSA over secp256r1 (P-256). The
private key is non-extractable authenticator state. The device entry
and boot commitment use the r1 tag family and bind the public key as
its two little-endian 32-byte coordinates, exactly as section 2.2.

**3.2 Assertion flow.** The wallet computes the 32-byte challenge `c`
per section 2.2 and requests a WebAuthn assertion with `challenge = c`.
The authenticator signs, per WebAuthn:

```
message = authenticatorData (37 bytes) || SHA-256(clientDataJSON)
z = int_be(SHA-256(message)) mod n
```

where `authenticatorData = rpIdHash (32) || flags (1) || signCount (4,
big-endian)`.

**3.3 Circuit obligations.** The r1 gate circuit takes the public key,
the expected `rpIdHash`, and `c` as public instance, and the full
`clientDataJSON` bytes, `authenticatorData`, and `(r, s)` as witness.
It MUST check, in-circuit:

1. `clientDataJSON` begins with the exact 36-byte prefix
   `{"type":"webauthn.get","challenge":"`, pinning the ceremony type
   and the challenge position. No general JSON parsing is performed
   in-circuit; the prefix pin plus fixed challenge position is the
   entire structural claim ([CRYPTO]: confirm this suffices against
   crafted client data).
2. The 43 bytes at the pinned position equal the unpadded base64url
   encoding of `c`, followed by a closing quote. The base64url
   expansion is a deterministic public function of `c`, computed
   natively by prover and verifier.
3. `authenticatorData[0..32]` equals the expected `rpIdHash`.
4. The flags byte has the user-present bit set. For asset-releasing
   operations the user-verified bit MUST additionally be set; for
   other gated operations user verification is a SHOULD.
5. Both SHA-256 layers of section 3.2, then ECDSA verification of
   `(r, s)` against the key, with `r != 0`, `s != 0`, the recomputed
   point non-identity, and `R.x mod n == r`.

`signCount` is committed through the hash but carries no constraint:
synced platform credentials report zero or non-monotonic counters, and
replay protection is already provided by the consumed device entry and
the advancing `auth_nonce` (MIP-0013 AUTH-9). Implementations MUST NOT
rely on `signCount`.

**3.4 Signature form.** The r1 scheme accepts both `s` forms; no low-s
normalisation is required of wallets and no canonical-form constraint
is imposed in-circuit. Rationale: the signature is a private witness
inside the proof and never appears on-chain, and any malleated twin
authorises the same single execution, whose device entry is consumed
and whose counter advances; malleability is inert in this construction
(invariant SIG-4). Real platform authenticators emit high-s signatures,
so a low-s-only policy would impose client-side normalisation for no
security benefit. [CRYPTO]: confirm the inertness argument.

**3.5 Client data length.** Browsers vary the `clientDataJSON` length
freely. The normative construction is length-agnostic hashing of the
client data; a conforming implementation MUST accept assertions
regardless of client data length. [CIRCUIT]: the evidenced circuit
fixes the length per verifying key (one key per observed length); the
variable-length hash gadget is the recorded follow-up and an
acceptance criterion.

**3.6 Relying-party scoping.** The expected `rpIdHash` is deployment
configuration. Credential evaluation is scoped to the relying party
that created the credential, so cross-wallet portability of an r1
device additionally depends on shared relying-party infrastructure;
this is a stated dependency of the ecosystem architecture, not
delivered by this proposal.

**3.7 Evidence.** The construction of 3.2 and 3.3 is implemented and
measured against the proof stack: direct verification of the full
envelope at k=16 (36,466 rows), proving in 1.1 to 1.2 seconds on
laptop-class hardware with 2 ms verification and 4,064-byte proofs;
the ECDSA-only relation at k=15 in approximately 0.5 seconds. A real
platform-authenticator assertion (134-byte client data, user-present
and user-verified flags set, high-s signature) was verified end to end
through the envelope circuit with user-verification required. See
Implementation.

### 4. The k1 scheme: interim ECDSA over secp256k1

**4.1 Status and sunset.** The k1 scheme is registered with Interim
status: it exists because in-circuit secp256k1 verification is the
only ECDSA surface in a released toolchain today, and its purpose ends
when the secp256r1 surface ships. Once [DEP] is met, new k1 enrolments
SHOULD cease; migration is a device ceremony (enrol an r1 credential
through a k1-gated `add_device`, then retire the k1 entry), not a data
migration. [RULING pending confirmation of Interim registration.]

**4.2 Construction.** The k1 scheme is the section 2.2 ECDSA challenge
core verified with the toolchain's `secp256k1EcdsaVerify` (which
accepts a pre-hashed 32-byte digest and both `s` forms). Gated-circuit
ABI: `(...args, pk: Secp256k1Point, use_counter: Uint<64>,
sig: Secp256k1EcdsaSignature)`. Signature-form policy and rationale
are those of section 3.4. The scheme requires the ZKIR v3 backend and
a ledger 9 network.

**4.3 Evidence.** The reference implementation carries the full
circuit roster on the k1 tag family, with offline suites (an
independent-stack verify oracle guarding the vacuous-verifier hazard,
and cross-implementation challenge vectors bit-identical between the
compiled contract and the Rust signer) and on-node suites green on a
devnet-matching ledger 9 localnet for the seam (deploy, bootstrap,
gated enrolment, tamper rejection, entry rolling under a second key)
and the custody surface. Suites pairing a contract call with an
unshielded offer are currently blocked by a localnet fee-model tuning
issue independent of the signature scheme. Threshold signing is out of
scope for the ECDSA schemes (threshold ECDSA is interactive and
historically fragile; the v1 scheme remains the threshold arm).

### 5. Invariants

- **SIG-1 (scheme isolation).** No artefact of one scheme is usable
  under another. Enforced by construction: every artefact binds its
  scheme's tag family in its hash preimage, and cross-scheme use fails
  at entry lookup.
- **SIG-2 (challenge binding).** A signature or assertion authorises
  exactly one operation tuple on one account, per the section 2.2
  challenge core and MIP-0013 AUTH-3.
- **SIG-3 (signature non-dependence).** An ECDSA scheme's challenge
  preimage MUST NOT include material of the signature that will
  authorise it.
- **SIG-4 (malleability inertness).** All signatures equivalent under
  a scheme's malleability set authorise the same single execution;
  the consumed entry and advancing counter make a malleated twin
  non-replayable.
- **SIG-5 (mixed-account degradation).** Removing the last device of
  one scheme leaves the account operable under its remaining schemes.

SIG-1 through SIG-4 refine MIP-0013's AUTH family per scheme; SIG-5 is
new with coexistence.

### 6. Versioning

This specification is versioned by its MIP number and revision
history. A new scheme registers by adding an arm-marked tag family and
a registry row under a new or revising MIP; a change to an existing
scheme's construction is a new trailing version segment of its tag
family. The registry's Status column takes the values Active, Interim
(registered with a named sunset condition), and Deprecated. A
post-quantum successor scheme registers by the same mechanism; nothing
in the registry shape assumes elliptic curves. One concrete candidate
arm is already identified and described in the Rationale.

## Rationale

**Extend MIP-0013, do not reword it.** MIP-0012's seam is
scheme-agnostic by design, and MIP-0013 §10 explicitly anticipates
successor schemes as new tag prefixes under a new MIP, including the
optional per-device scheme tag. MIP-0013 is Proposed; re-scoping a
Proposed document restarts its review for no structural gain. This
proposal is the successor document that section left room for.

**Scheme binding in the preimage, not in readable state.** MIP-0013's
device store has no value slot, so "record a scheme tag alongside the
epoch" cannot land as readable state without changing the store's
shape. Binding the scheme through the tag family instead gives
isolation by construction (SIG-1), costs nothing on-chain, changes no
MIP-0013 structure, and is already exercised by the k1 reference
implementation. The cost is that clients track per-entry scheme
client-side; they already track the use counter the same way.

**Per-scheme circuits over an in-circuit conditional.** A conditional
over foreign-curve arithmetic pays for every branch in every proof.
Specialised circuits keep the r1 gate at k=16 and the v1 gate at its
existing size, and let each scheme be audited and revised
independently. The cost is one verifying key per scheme per gated
operation; verifying keys are cheap and CMA-rotatable.

**Direct envelope verification over a recursion wrapper.** Both were
built and measured on the same stack. Direct: full envelope at k=16,
1.1 to 1.2 s proving. Recursion (native P-256 proof re-verified inside
an outer circuit that defers the final pairing check to an
accumulator): outer k=18, 4.9 s, a measured 9.9 times premium, a
larger proof, and a heavier trust surface (the outer circuit exposes
which inner circuit was used, and the wrapper is sensitive to gadget
rotation compatibility: an Ed25519 inner circuit is structurally
unwrappable at the measured revision). Direct verification wins on
every axis for this use; recursion remains the right tool when the
inner statement must be hidden or produced elsewhere, and is
non-normative here.

**Accept both signature forms.** A low-s-only policy is the right call
where signature bytes are on-chain artefacts (transaction identifiers,
deduplication keys). Here the signature is a private witness bound to
a consumed, counter-advancing entry: the malleated twin proves the
same statement about the same single execution. Real authenticators
emit high-s; requiring normalisation would add a client obligation
with no security return. The deployed k1 arm documents and tests the
same position, including an explicit high-s acceptance test.

**k1 registered as Interim rather than documented informatively.**
SIG-1 forces the decision: any scheme whose artefacts exist on-chain
needs a domain-separation family, which is an identifier, which is a
registry row. The interim is deployed on real networks; an
unregistered-but-deployed scheme would make the registry dishonest on
day one. The Status column contains the entrenchment risk: Interim
names its sunset condition in normative text. The alternative
(informative appendix) was rejected because it leaves deployed
artefacts formally unregistered. [RULING pending confirmation.]

**Software arm and secure-element arm coexist; neither replaces the
other.** The v1 scheme is FROST-capable and MPC-friendly: it serves
threshold custody, agent policies, and any context where the key is
managed rather than device-bound. The r1 scheme serves the opposite
posture: the key never exists outside the authenticator, at the cost
of single-credential signatures (threshold ECDSA is deliberately out
of scope). An account mixes them per its policy (section 1.3).

**A BIP-340 arm is the identified next candidate.** Wallet
infrastructure built on the Open Wallet Standard emits BIP-340 Schnorr
over secp256k1 under its native Midnight signing path; its ECDSA
output is reachable only by invoking the signer under a foreign chain
identifier, a transitional workaround that carries obligations of its
own (a dedicated derivation path never used on the borrowed chain, and
an explicit scheme parameter in any structured-intent signing
surface). A registered BIP-340 arm would let such a signer enrol on an
account and authorise operations under its native path with no
workaround. Its shape is already determined by this document: an
arm-marked tag family registered under a revising MIP per section 6, a
per-scheme circuit per section 2.1, and a challenge core that carries
the key as a single 32-byte x-only element with neither a `sig_r`
element nor a `grind_nonce` tail, because BIP-340 binds the nonce
point and the key inside its own tagged challenge hash and reduces it
modulo the curve order internally. It is not specified here for two
reasons: no released toolchain exposes a BIP-340 verification surface
(a dependency of the same kind as the r1 scheme's [DEP], since the
existing secp256k1 primitive verifies ECDSA only), and no consumer has
yet committed an enrolment path. The section 6 mechanism is the door
it enters through.

**Verification, not recovery, and pre-hashed messages.** Two API
lessons from the evidence, both relevant upstream: a verify primitive
must accept a caller-built pre-hashed message, because a
hash-internally API cannot express the WebAuthn two-layer hash
(MPS-0010's sketched API hashes internally and would break this
composition); and signature verification, not public-key recovery, is
the right primitive for enclave keys.

## Path to Active

### Acceptance Criteria

- [ ] [DEP] Compact language surface for secp256r1 verification on a
      ledger 9 toolchain, accepting a caller-built pre-hashed message
      (ZKIR v3 operations exist; the language surface does not).
- [ ] [CIRCUIT] Length-agnostic client-data hashing (variable-length
      SHA-256) in the r1 gate, removing the one-verifying-key-per-
      length limitation of the evidenced circuit.
- [ ] r1 gate implemented in the custody reference implementation on
      the r1 tag family; conformance vectors published, including
      high-s acceptance, wrong-rpIdHash, wrong-prefix, and
      malformed-envelope negatives.
- [ ] Real-platform-authenticator evidence refreshed against the
      final envelope schema, user verification required.
- [ ] [CRYPTO] Cryptographic review of the envelope binding (prefix
      pin plus fixed challenge position) and the malleability-
      inertness argument (sections 3.3, 3.4).
- [ ] Mixed-scheme account exercised by the reference suites
      (v1 and ECDSA entries coexisting; SIG-5).
- [ ] Tag families registered under the MPS-0027 registry.
- [ ] Community review period completed.

### Implementation Plan

The reference implementation stacks on the MIP-0012/MIP-0013 custody
contract: the k1 arm exists as a branch of it, and the r1 arm replaces
the k1 verify call and challenge-delivery step behind the same seam
once [DEP] lands. The recovery proposal consumes the same per-scheme
circuit pattern for its recover gate and coordinates on the registry.
Wallet-provider engagement covers the WebAuthn client side (assertion
requests carrying scheme challenges, relying-party scoping).

## Backwards Compatibility Assessment

Additive. v1 accounts and MIP-0013's normative text are untouched; the
optional scheme tag remains optional (and unnecessary, per section
1.2). No ledger change and no hard fork; the ECDSA schemes apply on
ledger 9 toolchains with the ZKIR v3 backend. k1 accounts migrate to
r1 by device ceremony (section 4.1); their on-chain artefacts remain
valid history under the k1 tag family indefinitely.

## Security Considerations

- **Crafted client data.** The circuit does not parse JSON; it pins a
  fixed prefix and a fixed challenge position. A crafted
  `clientDataJSON` that satisfies the prefix and challenge equality is
  by definition an assertion of the pinned ceremony type over the
  pinned challenge; remaining fields (origin, extensions) are
  deliberately unconstrained in-circuit and MUST be policed by the
  wallet at assertion time. [CRYPTO] reviews this boundary.
- **Malleability.** Inert by SIG-4; see section 3.4. The argument
  depends on the entry-consumption and counter mechanics of MIP-0013
  and fails in any design that treats signature bytes as identifiers;
  it is stated here for this construction only.
- **User verification.** UV set means the authenticator verified the
  user (biometric or PIN); UP alone means presence. The asset-releasing
  MUST of section 3.3 makes the stronger claim the default where value
  moves. A deployment whose authenticators cannot do UV downgrades
  deliberately and visibly, not silently.
- **signCount.** Ignored by design (section 3.3); relying on it would
  create false confidence exactly for the synced credentials that
  dominate real deployments.
- **Synced credentials.** A synced passkey's private key is replicated
  through the provider's end-to-end-encrypted sync fabric; the
  secure-element claim is per-authenticator, not per-credential.
  Wallets SHOULD surface whether an enrolled credential is synced or
  device-bound.
- **Vacuous-verifier hazard.** A gate whose verify call is wrong
  accepts everything; the offline independent-stack oracle suite is
  the guard and is a conformance requirement, not a courtesy.
- **Cross-scheme isolation.** Rests entirely on the DST discipline
  (SIG-1); tag-family registration under MPS-0027 is therefore a
  security control, not bookkeeping.
- **Credential loss.** Out of scope: total-loss recovery is the
  recovery proposal's job, and nothing in the r1 scheme changes it.
- **Threshold ECDSA.** Deliberately out of scope; interactive
  threshold ECDSA nonce generation is historically fragile. The v1
  scheme remains the threshold arm.

## Implementation

Reference implementation: the custody reference contract and its
suites (`contract/` in the passport repository), with the k1 arm on
its dedicated branch (same circuit roster on the k1 tag family;
offline unit and cross-implementation suites; on-node seam and custody
suites green on a ledger 9 localnet; toolchain pin set recorded in the
branch). Proof-layer evidence for the r1 scheme: the P-256 in-circuit
experiment (four relations from raw pre-hashed ECDSA to the full
WebAuthn envelope; a real platform-authenticator assertion verified
end to end including the high-s case; the recursion-wrapper
comparison), pinned to a recorded proof-stack revision with evidence
JSONs committed alongside. No implementation code accompanies this
document; the repositories above are the reference.

## Testing

Per scheme: positive conformance vectors (including, for r1, a real
authenticator assertion), negative vectors (tampered `s`, wrong
`rpIdHash`, wrong ceremony-type prefix, challenge mismatch, stale
entry, cross-scheme replay of a v1 artefact against an ECDSA gate and
vice versa), an explicit high-s acceptance test documenting SIG-4, and
cross-implementation challenge vectors (compiled contract versus an
independent signer stack, bit-identical). Mixed-account suite: enrol
v1 and ECDSA devices on one account, authorise under each, remove the
last device of one scheme, and verify continued operation (SIG-5).
The k1 branch's suite matrix is the template; its blocked
unshielded-offer suites re-run when the localnet fee-model tuning
lands upstream.

## References

- MIP-0012: Contract Custody of Midnight-Native Assets.
- MIP-0013: Multi-key Account Authorisation for Custody Contracts
  (scheme v1; §5.1 challenge rules; §10 versioning).
- MIP-0003: ECDSA support (ledger-level scheme and derivation).
- MPS-0009, MPS-0010: signature-verification language primitives.
- MPS-0018: Multi-key Account Custody for Midnight-Native Assets.
- MPS-0027: Domain Separation for Midnight Hash Constructions.
- MPS-0035: Shielded Spend Authorization Requires Exposing the Spend
  Key.
- W3C Web Authentication, Level 3 (assertion signing, client data,
  authenticator data).
- SEC 1 and SEC 2 (ECDSA verification; secp256k1, secp256r1).
- BIP-340 (Schnorr signatures for secp256k1; candidate arm, see
  Rationale).
- Open Wallet Standard (wallet-infrastructure signing core; motivating
  consumer for the BIP-340 candidate arm).
- FIPS 186-5 (ECDSA).
- RFC 2119 (key words).
- RFC 9591 (FROST; context for the v1 threshold arm).

## Acknowledgements

TODO: contributors to the curve decision, the per-scheme circuit
pattern, and the evidence base.

## Copyright Waiver

This document is licensed under the Apache License, Version 2.0, and
its authors have signed the Midnight Foundation Contributor License
Agreement. Portions of this document were drafted with the assistance
of a large language model; the named authors reviewed and are
accountable for its entire content.
