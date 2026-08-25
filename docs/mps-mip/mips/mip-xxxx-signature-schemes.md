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

<!-- WORKING DRAFT SKELETON, 2026/08/25. TODO tags: [CIRCUIT] = pending
     circuit design against the reference implementation, [CRYPTO] =
     pending cryptographic review, [RULING] = pending an editorial
     decision, [DEP] = external platform dependency. -->

## Abstract

MIP-0013 registers a single credential scheme for custody-account
authorisation (Schnorr over JubJub, scheme v1) and explicitly
anticipates successors: scheme identifiers, domain separation keeping
artefacts of distinct schemes apart, and an optional per-device scheme
tag. This proposal supplies the successor machinery and the first
successor. It defines the scheme registry semantics that let several
credential schemes coexist on one account, and registers **scheme v2:
ECDSA over secp256r1 as produced by WebAuthn platform authenticators**
(passkeys). Under scheme v2 the device credential never exists as
software key material: the authenticator signs inside its secure
element, and a dedicated circuit verifies the ECDSA signature together
with the WebAuthn signing envelope that produced it. Verification uses
one specialised circuit per scheme rather than an in-circuit scheme
conditional, keeping each circuit small and each scheme independently
auditable. The interim use of ECDSA over secp256k1, validated on a
devnet-matching network while the secp256r1 surface completes, is
documented with its migration path. The registry, the envelope
binding, and the signature normalisation policy are specified so that
independent wallet and contract implementations interoperate at the
signature boundary.

## Motivation

TODO expand. The load-bearing points:

- MIP-0013's scheme v1 requires the signer to hold a JubJub secret in
  software. Keys that live in secure elements cannot produce it; the
  strongest device security posture available to consumer hardware is
  therefore unusable for account authorisation. MPS-0035 makes the
  same argument at the Zswap layer (signature-based spend
  authorisation so keys can live in secure elements); this proposal is
  the custody-account counterpart.
- Passkeys are the onboarding primitive of the seedless account
  model: the credential that creates the account should be able to
  authorise it directly.
- The platform now provides the verification capability: in-circuit
  secp256k1 ECDSA and first-class secp256r1 operations under ZKIR v3.
  [DEP: the Compact language surface for secp256r1 verification does
  not exist yet; see Path to Active.]
- Decision trail: the project agreed to adopt secp256r1 as the
  passkey-arm curve; secp256k1 serves as the validated interim.

## Specification

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

### 1. Scheme registry

- Each credential scheme carries a scheme identifier. Scheme v1 is
  MIP-0013's Schnorr over JubJub. This proposal registers scheme v2
  (section 3). TODO: identifier syntax and registry table.
- Every artefact of a scheme (device entries, challenges, signatures)
  is domain-separated by scheme identifier, extending MIP-0013
  section 5.1. TODO: DST values, registered alongside the C8 registry
  work.
- An account whose device map contains entries of more than one scheme
  MUST record the scheme tag alongside the epoch in each device entry.
  (MIP-0013 makes the tag optional "under this MIP alone"; coexistence
  is exactly the condition under which it becomes mandatory.)
- Scheme interactions with the device lifecycle (enrolment, removal,
  epoch bump, recovery gate): TODO. The recovery proposal consumes the
  same per-scheme circuit pattern for its recover gate.

### 2. Per-scheme circuits

Each scheme verifies in its own dedicated circuit; there is no
in-circuit scheme conditional. An asset-releasing operation exists in
one variant per scheme the account uses, all instantiating the same
MIP-0012 seam semantics. Rationale: a conditional over curve
arithmetic pays for every branch in every proof; specialised circuits
keep k small per scheme and keep schemes independently auditable.
TODO: naming convention for circuit variants; shared challenge
construction across variants. [CIRCUIT]

### 3. Scheme v2: WebAuthn ECDSA over secp256r1

- **Key.** The device credential is a WebAuthn credential; the device
  entry commits to its COSE public key (P-256). The private key is
  non-extractable authenticator state.
- **Message binding.** A WebAuthn assertion signs
  `authenticatorData || SHA-256(clientDataJSON)`. The circuit MUST
  verify the ECDSA signature over that structure and MUST bind the
  MIP-0013 challenge tuple (contract address, operation, arguments,
  witness hash, epoch, counter) into `clientDataJSON.challenge`.
  TODO: exact envelope schema, the minimal parsing done in-circuit,
  and which authenticatorData flags (UP, UV) are asserted. [CIRCUIT]
  [CRYPTO]
- **Normalisation.** Consumer authenticators emit high-s signatures
  (observed empirically from platform authenticators). The scheme
  fixes a canonical form: TODO ruling between low-s normalisation
  before proving versus accepting both forms in-circuit; the
  malleability considerations differ. [RULING] [CRYPTO]
- **Evidence.** ECDSA-P256 verification in a Compact-adjacent circuit
  at k=15, proving in approximately half a second, verified against a
  real platform-authenticator assertion including the high-s case; a
  recursion-wrapped variant at k=17 to 18. See Implementation.

### 4. Interim scheme: ECDSA over secp256k1

TODO ruling: registered as a scheme in its own right versus documented
as an informative interim with a migration note. [RULING] The interim
is validated end to end on a devnet-matching network (offline suites
and on-node suites); its migration path to scheme v2 is a device
ceremony (enrol v2 credential, retire k1 entry), not a data
migration.

### 5. Invariants

TODO, SIG family. Candidates: SIG-1 scheme isolation (no artefact of
one scheme verifies under another; enforced by DSTs); SIG-2 challenge
binding (a signature authorises exactly one operation tuple, per
MIP-0013); SIG-3 no cross-scheme replay across epochs; SIG-4 mixed
accounts degrade safely (removing the last device of a scheme leaves
the account operable under the remaining schemes).

### Versioning

TODO: registry versioning; how a scheme v3 (for example a
post-quantum successor) registers; interaction with MIP-0013's v1
identifier.

## Rationale

TODO prose. The decision record:

- **Extend, do not reword, MIP-0013.** The seam is scheme-agnostic by
  design and MIP-0013's Versioning section anticipates successor
  schemes explicitly; it is Proposed, and re-scoping a Proposed
  document restarts its review for no structural gain.
- **Per-scheme circuits over an in-circuit conditional.** Cost and
  auditability; see section 2.
- **P-256 over extending JubJub to authenticators.** Authenticators
  do not and will not sign on JubJub; the choice is between software
  keys (scheme v1, FROST-capable, MPC-friendly) and secure-element
  keys (scheme v2, single-credential). The two arms serve different
  postures and coexist; neither replaces the other. TODO: comparison
  table.
- **Envelope verification in-circuit versus a recursion wrapper.**
  Both were exercised experimentally; TODO: the trade-off table
  (circuit size, proving time, trust surface) and the ruling.
  [RULING]
- **Interim k1.** The only ECDSA verification shipped in a released
  toolchain today; evidence exists; treating it as a first-class
  scheme risks entrenching a curve chosen for availability rather
  than fit. [RULING as section 4.]

## Path to Active

### Acceptance Criteria

- [ ] [DEP] Compact language surface for secp256r1 verification
      available on a ledger 9 toolchain (ZKIR v3 operations exist;
      the stdlib circuit does not yet).
- [ ] Scheme v2 circuit implemented in the custody reference
      implementation; conformance vectors published, including
      high-s, wrong-rpIdHash, and malformed-envelope negatives.
- [ ] Real-authenticator evidence refreshed against the final
      envelope schema (platform authenticator assertion verified
      end to end).
- [ ] Cryptographic review of the envelope binding and normalisation
      policy.
- [ ] Registry and scheme-tag semantics exercised by a mixed-scheme
      account in the reference suites.
- [ ] Community review period completed.

### Implementation Plan

TODO: stacking on the MIP-0012/MIP-0013 reference implementation;
coordination with the recovery proposal's per-scheme recover gate;
wallet-provider engagement for the WebAuthn client side.

## Backwards Compatibility Assessment

Additive. Scheme v1 accounts are unaffected; MIP-0013's optional
scheme tag becomes mandatory only for accounts that adopt a second
scheme. No ledger change and no hard fork; applicability is "ledger 9
toolchains" for scheme v2. TODO: interim-k1 account migration note.

## Security Considerations

TODO. The register:

- ECDSA malleability and the normalisation policy (section 3).
- In-circuit parsing of attacker-influenced `clientDataJSON`;
  canonicalisation and length bounds. [CRYPTO]
- Authenticator flags policy (UP/UV) and what a missing UV means for
  the authorisation claim.
- Synced credentials: the private key is replicated through the
  provider's end-to-end-encrypted sync fabric; the secure-element
  claim is per-authenticator, not per-credential. State honestly.
- Credential loss is not addressed here: total-loss recovery is the
  recovery proposal's job; scheme v2 changes nothing about it.
- Cross-scheme isolation rests on the DST discipline (SIG-1).

## Implementation

TODO: reference implementation location; evidence artefacts (the
P-256 in-circuit experiment including the recursion leg, the k1
interim arm's offline and on-node suites).

## Testing

TODO: conformance vectors per scheme; negative suite (high-s,
wrong rpIdHash, malformed envelope, cross-scheme replay, stale
epoch); cross-implementation signer vectors.

## References

TODO: MIP-0003, MIP-0012, MIP-0013; MPS-0009, MPS-0010, MPS-0018,
MPS-0035; W3C WebAuthn Level 3; SEC 2 (secp256r1/secp256k1);
FIPS 186-5; RFC 2119.

## Acknowledgements

TODO.

## Copyright Waiver

This document is licensed under the Apache License, Version 2.0, and
its authors have signed the Midnight Foundation Contributor License
Agreement. Portions of this document were drafted with the assistance
of a large language model; the named authors reviewed and are
accountable for its entire content.
