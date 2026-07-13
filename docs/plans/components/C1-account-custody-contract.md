# C1 · Account-custody contract

**Serves:** P1 · P3 · P4 · P5 · P8.

## Outcome

The on-chain Compact contract representing a Passport account. Holds the
device set, name binding, active scoped grants, and — per C4's resolved
custody choice — the user's Midnight-native assets. Every
Passport-touching operation interacts with this contract.

**Status 2026/07:** specified as two drafted standards, the building
blocks of the multi-key account keystone recommended by MPS-0018:

- **Custody MIP** (`docs/mps-mip/mips/mip-xxxx-native-asset-custody.md`,
  merged in this workspace, upstream submission prepared): how the
  contract holds and releases unshielded and shielded value —
  stateless shielded custody, encrypted-inbox discovery, the
  surviving-coin change rule, an explicit per-color unshielded mirror
  — with authorisation abstracted to a single seam
  (`require_authorised()`) whose observable semantics are fixed.
- **Account-authorisation MIP**
  (`docs/mps-mip/mips/mip-xxxx-account-authorisation.md`, drafted): the
  device set (`Map<commitment, epoch>`), revocation epochs
  (one bump invalidates every stale credential), device lifecycle
  ceremonies with a last-device guard, a dedicated `auth_nonce`
  freshness counter, and the seam instantiated with in-circuit JubJub
  Schnorr (see C5). A recovery seam is fixed but its mechanism is
  deferred to the recovery-paths MIP (C14).

Scoped grants (C10/C11) remain a permitted extension behind the same
seam — deliberately not baked into either building block.

## Dependencies

- **C4** — resolved: contract custody, stateless shielded pattern; the
  custody MIP is the specification.
- **C2** — name service binds names to C1 (MIP-0007 territory;
  discovery deliberately out of the custody MIP's scope).
- **C9** — devices register as authorised keys in C1; the passkey
  layer gates access to the device's JubJub key.
- **C10 · C11 · C12** — grants live in, operate on, and are enforced by
  C1; specified as extensions against the seam.

## Open questions

**Deploy cost at user-base scale.** Per-account instances are chosen;
onboarding-cost projections at scale still to gather.

**Who deploys.** Self-deployed at onboarding, or a deployment service?
The standards are silent on the deployer; the onboarding flow owns
this.

**Fleet migration.** Instances are immutable per the ledger's deploy
semantics; the MIPs version via a `spec_version` cell and a `Replaces`
chain, but tooling for migrating a deployed fleet remains
implementation work.

## Failure modes

**Deploy cost prohibitive.** Per-account deploys exceed tolerable
onboarding cost. *Detection:* onboarding-cost projections at user-base
scale.

**Upgrade fragmentation.** Version-skew between deployed contracts
breaks operations. *Detection:* a Compact spec change makes some
accounts incompatible with new tooling.

**Seam misuse.** An implementation authorises from wallet-supplied,
circuit-unconstrained data (`ownPublicKey()` is the canonical
counter-example) instead of the specified seam. Prohibited normatively
by both MIP drafts; *detection:* the conformance suite's
rejection-matrix tests.

## Alternatives

**A — One Compact contract per account.** **Chosen — ratified in the
custody MIP draft.** Per-user schema evolution, isolated failure; the
deploy-cost question moves to onboarding projections.

**B — Single registry contract with accounts as entries.** Rejected:
ecosystem-wide schema freeze, concentrated upgrade risk, and a single
censorship / correlation point at the application layer. A
witness-private shared-custody profile is left to a successor proposal
for the anonymity-set benefit.

**C — Hybrid.** Superseded: discovery belongs to the name service
(MIP-0007); custody to per-account instances.

## Authentication alternatives

**A — Hash-preimage witness.** Device holds a secret derived from
passkey PRF; C1 stores a commitment; circuit verifies preimage
knowledge. Cheapest verification — but the witness *is* the long-term
credential: whoever proves holds it, which structurally excludes
threshold / MPC custody and makes delegated proving equivalent to
handing over the account. **Retired to prototype-placeholder status**
(the account-custody prototype used it, expressly shaped for
replacement).

**B — Jubjub Schnorr.** **Chosen — specified by the
account-authorisation MIP.** Device holds a JubJub keypair; C1 stores
a domain-separated commitment to the public key with its registration
epoch; the circuit verifies a Schnorr signature over a challenge
binding account, circuit, arguments, and `auth_nonce`. Composes with
FROST (a threshold committee registers as one device); separates
approval from proving. See C5 for the full shape.

**C — P-256 ECDSA (passkey assertion).** Blocked today — Compact has
no in-circuit P-256 verifier, and non-native curve arithmetic is
prohibitively expensive in the BLS12-381 circuit. Would be required
for flows where the signing operation must occur inside the
authenticator's secure element; revisit if upstream ships a P-256
gadget.
