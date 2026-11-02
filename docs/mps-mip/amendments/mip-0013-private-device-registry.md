# Proposed amendment: private device registry and complete credential revocation

**Status: working amendment draft; not submitted, accepted, or implemented by
the reference account.** This document proposes a replacement device-registry
profile for MIP-0013. It does not change the status or requirements of a
published MIP. The associated [adversarial prototype](https://github.com/midnightntwrk/passport/blob/ff1c3b2a20ab86bdea02ddc9f3e8db77f9d37543/experiments/private-device-registry/README.md)
is a separate compiled Compact experiment, not a conforming account or a
production implementation. Its validation scope is recorded below.

The review baseline is upstream revision
[`06948fb14691a4a9109852b8e9ccb343c8b29e43`](https://github.com/midnightntwrk/midnight-improvement-proposals/tree/06948fb14691a4a9109852b8e9ccb343c8b29e43):

- [MIP-0013: Multi-key Account Authorisation](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/06948fb14691a4a9109852b8e9ccb343c8b29e43/mips/mip-0013-account-authorisation.md).
- [MIP-0022: Recovery Paths for Custody Accounts](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/06948fb14691a4a9109852b8e9ccb343c8b29e43/mips/mip-0022-account-recovery.md).
- [MIP-0030: ECDSA Authorisation for Custody Accounts](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/06948fb14691a4a9109852b8e9ccb343c8b29e43/mips/mip-0030-ecdsa-account-authorisation.md).

The scoped-grants integration below refers to the
[submitted Draft at revision `4d4eace4`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/4d4eace4f56549eb750dcf6d9333221fb2f5f1dd/mips/docs/mip-xxxx-scoped-grants.md).
That Draft has not been assigned a number in this baseline.

## Problem and proposed boundary

The current registry contains rolling entries rather than unique credentials.
An authorised device can install another entry for its own key; removal of one
entry leaves the other usable. The
[reference account's erratum 8](https://github.com/midnightntwrk/passport/blob/fc19e471536febb2133f20e817847251622dcdf5/contract/README.md#spec-errata-found-while-implementing)
records the defect. A client rule forbidding duplicate enrolment does not
constrain a malicious authorised device.

Publishing a stable hash of a public key would permit duplicate checks but
would also expose a persistent pseudonym and permit matching against known
candidate keys. Account-specific domain separation prevents equal hashes
across accounts; it does not prevent an observer from evaluating candidates
for each account. Giving each registration an unconstrained random identifier
or salt instead permits the same key to acquire several identities.

This amendment separates the two requirements: a **canonical credential
identity remains private**, while the chain holds a **hiding, binding commitment
to the complete current registry**. The circuit proves membership, uniqueness
and exact registry updates without disclosing a credential identifier. Every
device-authorised operation continues to verify a signature and advance the
account's `auth_nonce`.

The following text is proposed normative language. `Commit` and registry
witnesses denote a construction whose concrete encoding, hash/domain tags,
blinding and proof representation remain to be selected. This is not yet an
interoperable byte-level specification. A bounded blinded roster and a private
tree are candidate implementations; the prototype's capacity of eight is an
experimental parameter, not a proposed universal limit.

## MIP-0013 section 1: terminology replacement

Retain Account, Device, Device key, Authorisation counter and Challenge. Replace
Device entry and Use counter, and revise Epoch, with:

- **Credential identity:** the account address, canonical curve identifier and
  canonical public key. Equivalent encodings of one key MUST NOT create
  distinct identities. An implementation MAY derive a private digest of this
  tuple using a specified collision-resistant construction. The digest is not
  a public ledger identifier.
- **Device record:** one credential identity together with its authorised
  verification policies. These include applicable signature envelopes,
  WebAuthn profiles, RP/origin bindings and other policy conditions. These
  conditions MUST be authenticated as part of the record.
- **Private registry:** the collection of active device records, with at most
  one record for each credential identity. Its commitment opening includes
  the private data required by the selected commitment construction.
- **Registry commitment:** the account-level, hiding and binding commitment
  to the current registry, account, profile version, epoch and active count.
  A tree implementation may call this value a root.
- **Registry witness:** private opening, membership, absence or update data
  that the circuit constrains against the current registry commitment.
- **Epoch:** the contract-maintained recovery generation. Recovery replaces
  the complete active registry at the next epoch; an epoch change alone does
  not establish retirement.

Curve identifiers MUST identify the underlying curve, not an interchangeable
wallet adapter. Envelope, profile, RP/origin policy, counter, registration slot,
blinding and authorisation-arm names MUST NOT be alternative uniqueness keys
for the same canonical public key. A permitted policy change updates the
existing record under fresh authorisation.

## MIP-0013 section 3: public ledger state replacement

Replace the public `devices` set and its entry construction with:

```text
device_registry_commitment : Commitment
device_epoch               : Uint<32>
device_count               : Uint<8>
auth_nonce                 : Uint<64>
```

`device_count` counts active credential records, not opaque handles. The
selected profile MUST define a maximum capacity within its representation and
the counter's range. Every mutation MUST establish that the public count equals
the active count authenticated by the new commitment; arithmetic MUST reject
overflow and underflow.

The commitment MUST bind the actual account address, registry profile/version,
current epoch, count, canonical records and all commitment-opening data. Its
construction MUST be binding and hide the records against observers who know
candidate public keys but not the private opening. A deterministic hash of a
small roster is insufficient for the latter requirement. Blinding MUST have
the entropy required by the selected construction, be generated with a
cryptographically secure source, and not be reused across accounts or
independent registrations. The profile MUST specify blinding on registry
changes and recovery, its secrecy boundary, and consequences of compromise.

Only the **current** commitment authorises membership. Historical roots MUST
NOT remain usable for device authorisation after revocation or recovery. No
public device record, identifier, key-derived nullifier, leaf index, membership
path or update path is required by this profile. Private witnesses MUST be
verified in the circuit; a client-only commitment check is insufficient.

### Bootstrap

The actual account address is not available to the constructor. Deployment
MUST therefore create a dormant account with no active registry and a fresh
hiding bootstrap commitment. That commitment MUST bind the complete initial
credential and policy, registry profile and private initialisation material
needed to determine the first registry. It MUST NOT depend on a placeholder
account address being the eventual address.

Activation MUST verify the bootstrap opening privately, validate the key and
policy, derive the credential identity using the now-known `kernel.self()`,
and install a registry containing exactly that credential at epoch zero and
count one. It MUST burn the bootstrap commitment and reject reactivation.
No device-authorised operation may execute while dormant. Replaying a valid
activation MUST NOT permit substitution of a different key, policy or registry.
The concrete bootstrap byte recipe and the treatment of any initialisation
data not fixed before deployment are mandatory profile work.

## MIP-0013 section 4: seam replacement

A device-authorised circuit takes the public key, applicable policy evidence,
signature and registry witness as private proof inputs. It MUST:

1. Authenticate the registry witness against the exact current commitment,
   account, profile, epoch and count read from ledger state.
2. Establish membership of the canonical identity of the supplied key and
   enforce the authenticated record's policy. Merely proving membership of
   an arbitrary opaque identifier is insufficient.
3. Recompute the per-operation challenge under section 5 and verify the
   applicable signature, including all required point/scalar checks.
4. Apply only the authorised operation. For a registry mutation, constrain
   the old-to-new registry relation described in section 6.
5. Increment `auth_nonce` exactly once and advance `round` as required by
   MIP-0012, with all changes atomic.

The current commitment and `auth_nonce` MUST both be checked against ledger
state. A prover cannot select an earlier root or replay an earlier nonce.
Ordinary operations that do not change device authority SHOULD leave the
registry commitment unchanged; single-use signatures are enforced by
`auth_nonce`, not by rolling a device handle. Deposits and other permissionless
operations retain AUTH-8's independence.

Proof generation MUST consume a signature, not the signing secret or a share
of it. A private membership identifier MUST NOT introduce a requirement that
the signing secret be supplied to the prover. In a full-roster implementation
a delegated prover can learn the roster, policies and opening material it
receives. On-chain privacy is not a claim of privacy from that prover.

## MIP-0013 section 5: challenge delta

Retain the applicable signature scheme, signing/proving separation and
challenge-grinding rules. Introduce a distinct profile/domain version; existing
rolling-entry signatures MUST NOT be reinterpreted under this profile.

Every challenge MUST bind, with unambiguous typed encoding:

- the account, registry profile/version, operation domain and acting key;
- the current registry commitment, epoch and pre-increment `auth_nonce`;
- all operation arguments and all existing non-registry witness values,
  including consumed coin descriptions;
- the authenticated verification policy or an unambiguous binding to the
  relevant record and selected route;
- for enrolment, removal or policy updates, the exact target credential and
  requested policy/operation, the successor registry commitment and its count;
- the signature announcement and grind nonce where the scheme requires them.

Registry witnesses need not be serialised into a hardware signer's message.
Instead, the signed current commitment MUST authenticate every registry field
the circuit uses. For a mutation the signed successor commitment MUST bind the
result, and the circuit MUST prove the authorised transition between the two.
A prover cannot change a record, blinding, count, policy, key, sibling node or
other authenticated registry data while keeping those bindings valid. Different
proof representations of the same authenticated data do not change authority.
All non-registry witness-value binding required by AUTH-10 is unchanged.

The selected construction MUST publish exact typed preimages and independent
vectors, including the treatment of the registry profile, record policies and
commitment randomness. Domain naming MUST be reconciled with MIP-0021; this
draft does not assign final tag bytes or permit silent reuse of existing tags.

## MIP-0013 section 6: lifecycle replacement

**Enrolment.** An active credential authorises a new canonical key and its
policy. The circuit MUST prove that the current registry contains no record
with that credential identity, validate its key and policy, and insert exactly
one new record. It MUST preserve every other record and increment the count
by one. Different counters, salts, encodings, envelopes, profiles or adapter
labels MUST NOT bypass the uniqueness check. A construction proving only that
a caller-selected empty slot is unused does not satisfy this requirement.

**Removal.** An active credential authorises removal of a target credential
identity. The circuit MUST prove that the target is present, delete exactly
that record, preserve every other record and decrement the count by one. The
acting credential MUST remain active with its authorisation policy intact.
Consequently removal of the acting credential itself MUST fail in this
1-of-n profile, even where the count is greater than one. No record for the
removed identity may authorise afterward without a fresh authorised enrolment.

**Policy change.** A separately specified, device-authorised transition MAY
update the policy of an existing credential. It MUST bind the exact old and
new policy and preserve credential identity, uniqueness and count. A fresh
policy does not constitute a second registration of the same key. A profile
without such a transition MUST reject attempts to use enrolment as one.

Registry mutation and the corresponding commitment/count/nonce updates MUST
be atomic. Unrelated record changes, hidden extra registrations and replacing
the entire roster during an ordinary lifecycle call MUST be rejected.

This guarantees revocation of the named credential, not of an adversary. A
compromised full-authority device may already have enrolled **different** keys.
Revoking its original key does not automatically revoke those credentials.
Restricting enrolment authority or requiring multiple devices is a separate
policy change. The registry history and private roster protocol MUST give
authorised clients the information needed to review the actual active set.

## MIP-0013 section 8: recovery replacement

Recovery finalisation MUST atomically replace the current registry with a
new registry containing exactly the authorised successor credential, at the
next contract-maintained epoch and count one. It MUST advance `auth_nonce`
and `round`. No earlier root, credential record or pending-period enrolment
may remain an authorisation source after finalisation.

The recovery path MUST NOT require an opening or membership proof for the
old private registry: total-loss recovery must remain possible when those
witnesses have been lost. The recovery gate MUST instead authenticate the
complete successor credential/policy and successor commitment under a
versioned recovery authorisation. Its circuit MUST verify the new registry's
singleton shape, account binding, key/policy validity, count and next epoch.

A pending recovery record MUST bind the validated singleton commitment and
all successor policy and recovery fields needed at finalisation. Those fields
MUST NOT be replaceable after approval. A normal registry change during the
pending window MUST NOT be able to add a survivor to the finalised registry.
Cancellation remains device-authorised against the then-current registry;
advancing its nonce invalidates cached device approvals as already specified.

Successful recovery does not retrospectively erase data a former device or
prover has learned. The successor MUST receive or reconstruct the opening and
availability material for its new registry without any former device's help.
This obligation is separate from recovery of historical inbox/coin data.

## MIP-0013 section 9: invariant replacements and additions

Preserve AUTH-2, AUTH-3, AUTH-4, AUTH-7 and AUTH-8, with the binding additions
above. Apply the following replacement text to this profile:

- **AUTH-1 (signature and membership gate).** Every device-authorised call
  verifies the appropriate signature under a valid key whose canonical
  credential and policy are proven active under the current registry
  commitment and epoch. Stale-root membership does not confer authority.
- **AUTH-5 (surviving authority).** A selective removal preserves the
  currently authorising credential and its policy. Public count alone is
  insufficient evidence that usable authority survives.
- **AUTH-6 (recovery retirement).** Immediately after recovery finalisation,
  the authorised successor is the only active credential. No old registry,
  opening, arbitrary counter or pending-period enrolment can authorise again
  without a fresh authorised enrolment.
- **AUTH-9 (private registry).** Device public keys, canonical credential
  identifiers, per-device lookup/nullifier values and membership/update paths
  MUST NOT appear in public ledger state or disclosed transaction operations.
  The public registry commitment authenticates the account's aggregate state,
  not a public per-device lookup handle. It MUST be hiding against candidate-key
  matching by an observer without the private opening. Account-level metadata
  and the limits in S4 remain observable; full transaction unlinkability is
  not claimed.
- **AUTH-10 (authenticated private-state binding).** The challenge directly
  binds every non-registry witness value as previously required. Registry
  witness data is bound by the signed current commitment and, for mutations,
  the signed successor commitment and exact operation. The circuit verifies
  all openings and the transition; substitution of unauthenticated registry
  data MUST fail. This is an explicit change to witness binding, not a
  client-side exemption from it.
- **AUTH-11 (credential uniqueness).** The active registry contains at most
  one record for each account/curve/canonical-key identity, independently of
  counters, policy variants, encodings, blinding, slots and adapter names.
  Every enrolment proves uniqueness on-chain.
- **AUTH-12 (complete selective revocation).** After successful removal,
  no authorisation under the removed credential is accepted until a fresh
  authorised enrolment. Other credentials retain their records and policy.

## MIP-0013 section 10: versioning and migration delta

The private-registry profile changes public state, authorisation arguments,
challenge domains, witness requirements, bootstrap and recovery. It requires
a distinct schema/profile version and new vectors and verifier keys. Final
version identifiers are not allocated by this draft.

An existing public-entry deployment MUST NOT be advertised as conforming
after a client-only update. Replacing the ledger schema requires a new
deployment under the current account model; verifier maintenance alone is not
a schema migration. Migration must specify asset transfer, name/identity
references, grants, inbox material, recovery configuration and user approval.
Maintenance-authority availability does not remove those obligations.

Published historical signatures, commitments and proof receipts retain their
original profile. Support for an old verification path MUST NOT provide a way
to bypass the new registry's uniqueness, policy or retirement rules. Editor
review must determine the upstream revision/lifecycle route; this document
does not silently amend an accepted specification.

## MIP-0013 rationale R8 and security S4/S11 replacements

**R8 — Private uniqueness and selective revocation.** Rolling public handles
hide raw keys but do not enforce unique credentials, and consumption plus
successor insertion enables transcript chaining. A public deterministic stable
identifier trades the duplicate-entry problem for persistent linkage and
known-key matching. A private canonical identity with an authenticated,
blinded registry allows the circuit to enforce uniqueness without exposing
that identity. The cost is additional constraints and private-state handling;
no cost or proving-latency improvement is asserted.

**S4 — Disclosure and linkability.** Public observers still see the account,
installed circuit identifiers/selected authorisation arm, operation timing,
root reads/updates, epoch, nonce, count and other custody disclosures. Device
count, the available credential set and external observations may identify an
actor by inference, especially for a one-device account. A stable aggregate
root can correlate an unchanged account roster; account operations already
share the account address. No anonymity-set size or complete unlinkability is
claimed. The selected construction must prevent candidate-key/roster tests
without its opening, but cannot hide keys or openings already known to a
device, delegate or colluding observer. Actual serialized transactions,
cross-contract arguments, logs and error paths require inspection; source
level omission of `disclose(pk)` alone is not a complete privacy audit.

**S11 — Private registry availability.** Clients MUST authenticate a received
registry snapshot or witness against the current on-chain commitment before
using it. A valid signing key without current witness data may be unable to
operate. The old counter-rescan technique cannot reconstruct a private
registry from its root. The profile therefore MUST define authenticated
encrypted roster/witness distribution to authorised devices, update discovery,
stale-state handling, integrity, backup and recovery, and post-revocation access
to future distribution keys. It MUST identify exactly which holder learns the
roster or Merkle path and which compromise exposes them.

An authorised malicious device can construct a valid new commitment while
withholding the corresponding opening or update data from peers. A signature
and commitment prove authority and consistency, not data availability. A
best-effort upload or a single server is insufficient to claim chain-only
operation or peer-device liveness. A chain-backed encrypted publication, a
validated encrypted update mechanism or another substitutable protocol must
be specified and evaluated; encryption alone does not prove that ciphertext
contains usable data for every intended peer. An assumed honest distribution
service MUST be stated as an unresolved trust/liveness dependency.

The availability protocol is a **protocol blocker**, not a user-interface
follow-up. Until it is specified and exercised against withholding, the
private-registry profile cannot claim complete peer-device or chain-only
conformance. Recovery without old registry witnesses bounds one loss case;
it does not guarantee uninterrupted operation or prevent a still-authorised
device from exercising the recovery cancellation policy.

## Companion specification changes

### MIP-0022

Revise sections 2, 6 and 8 and REC-8 to refer to an authenticated successor
credential/policy and singleton registry commitment rather than a precomputed
rolling entry. The recovery signing transcript must bind the registry profile,
post-recovery epoch and singleton commitment as well as its existing successor
and recovery fields. Section 6 currently makes successor device key `Q` a
public input; under this profile it MUST instead be a private proof input.
Its signature bindings and successor proof of possession remain required.
Neither `Q` nor its credential identifier may be disclosed in the pending
record, events or transaction operations; the validated singleton commitment
provides the public binding. This restriction concerns device credentials,
not the separate public recovery verification key. Submission must validate
the singleton without requiring the old registry opening. Finalisation must
install it atomically and advance
the epoch/nonce exactly as specified above. Cancellation verifies current
private-registry membership. Preserve successor proof of possession, veto
semantics, recovery-key validation and REC-11's signature-only proving boundary.
Version the changed transcript and add independent vectors; do not reinterpret
existing recovery signatures or pending records.

The encrypted availability protocol must ensure the successor obtains its
new registry material. Restoring that singleton is separate from restoration
of old viewing secrets, historical inbox access and guardian artefacts.

### MIP-0030

Revise sections 1 and 2's rolling-entry conformance and device recipes for the
new profile. Canonical curve/key identity is shared across adapters using the
same key. Envelope, RP/origin and profile parameters remain authenticated
policy, but cannot manufacture duplicate device identities. Section 3's
WebAuthn verification and policy obligations continue across every installed
verifier route. A profile change needs explicit authorised policy mutation;
one permissive route must not bypass a stricter recorded policy. Replace the
device-operation transcript with the section 5 bindings and publish new
vectors. ECDSA scalar/point checks and the distinction between device and
grant authority remain unchanged.

### Scoped grants

Revise the submitted Draft's section 12 combined-conformance profile and its
device-side lifecycle/challenge references, including sections 6, 7, 13 and 14.
Issuing, revoking and modifying a grant remains device-authorised, now through
current private-registry membership. Grant-only spending must not mutate the
device registry or advance the device `auth_nonce`; per-grant freshness and
scope remain independent. Recovery must still invalidate every earlier grant
through the incremented device epoch. Selective device removal does not
implicitly revoke independently issued grants or revoke distinct enrolled keys.

Any newly signed device-operation envelope or schema capability requires
versioned recipes and client capability negotiation. The private registry
does not implement the dApp connection ceremony, GrantViewSeal, or grant/read
conformance. Those remain separately specified work.

## Validation and open construction decisions

The [prototype](https://github.com/midnightntwrk/passport/blob/ff1c3b2a20ab86bdea02ddc9f3e8db77f9d37543/experiments/private-device-registry/README.md) implements
an eight-slot roster in [Compact source](https://github.com/midnightntwrk/passport/blob/ff1c3b2a20ab86bdea02ddc9f3e8db77f9d37543/experiments/private-device-registry/contracts/registry.compact),
with JubJub signatures and an authenticated opaque policy label. The recorded
[execution evidence](https://github.com/midnightntwrk/passport/blob/ff1c3b2a20ab86bdea02ddc9f3e8db77f9d37543/experiments/private-device-registry/evidence/offline.json)
contains 32 passing checks against the generated Compact simulator. Public-VM
transcripts for all five exported state-changing circuits were replayed; two different
authorising credentials produced identical ordinary-authorisation public
transcripts and final states from the same initial state. Private-value fixture
scans included positive controls. These are targeted disclosure regressions,
not a proof of zero-knowledge or a complete transaction privacy audit.

The separate [circuit-shape evidence](https://github.com/midnightntwrk/passport/blob/ff1c3b2a20ab86bdea02ddc9f3e8db77f9d37543/experiments/private-device-registry/evidence/measurements.json)
records successful native `zkir-v3 mock-compile` for all five circuits under
Compact 0.35.0. Both evidence files identify the Compact source by SHA-256
`46dd29c217057473c6664f8f9fd2b65dfad3e0cc5e1b0406a5a591f09b054022`.
Mock compilation measures circuit shape; it does not generate or verify proofs
or validate adversarial native witnesses. Simulator rejection is not evidence
of rejection at those later layers, including canonical point decoding and
full subgroup constraints. No node submission, production integration, proof
size or proof timing is established.

The diagnostic recovery circuit checks one public recovery-key signature and
replaces the registry without its old opening. It does not implement MIP-0022's
publication, reconstruction, successor co-signature, cancellation or veto
protocol. The policy label has no policy interpreter, and the prototype does
not implement ECDSA/WebAuthn verification, assets, grants or encrypted roster
distribution. Its results therefore do not establish the proposed profile's
complete conformance.

Before an interoperable profile can be proposed, specify and validate:

1. The commitment construction, canonical record encoding, padding, capacity,
   domain separation and private witness format. For a tree, nonmembership
   must use the canonical credential index, and every supplied path must be
   constrained to the correct leaf and root. For a bounded roster, active
   slots, canonical padding and full uniqueness must be constrained.
2. Valid key/policy handling and duplicates across counters, randomness,
   profiles, envelopes, adapter names and alternative key encodings.
3. Exact enrolment/removal/policy-change transitions; hidden extra insertions,
   collateral removal, invalid counts, self-removal, stale roots and root
   history must all fail. Fresh explicit re-enrolment is a separate positive
   control, not a revocation bypass.
4. Signature binding, replay, account/profile separation, current nonce,
   changed registry witnesses and all unchanged coin-witness bindings.
5. Bootstrap at the real account address; replay or substitution of boot
   openings; recovery with no old roster and with adversarial pending-period
   mutations; successor operation after each finalisation.
6. Authenticated encrypted availability and withheld/corrupt updates,
   interrupted synchronisation, lost local state, peer-device restore and
   recovery. State the remaining trust assumptions explicitly.
7. Actual compiled constraints, independent byte vectors, proof/server/node
   rejection layers, serialized disclosure, and measured proof/deployment
   costs for the selected capacity and all supported arms.

The existing account remains on the public rolling-entry scheme until a
separately reviewed implementation and migration are adopted. No production
contract or published MIP is modified by this proposal alone.
