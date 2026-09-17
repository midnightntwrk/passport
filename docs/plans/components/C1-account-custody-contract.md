# C1 · Account-custody contract

**Serves:** P1 · P3 · P4 · P5 · P8.

## Outcome

The on-chain Compact contract representing a Passport account. Holds the
device set, name binding, active scoped grants, and — per C4's resolved
custody choice — the user's Midnight-native assets. Every
Passport-touching operation interacts with this contract.

**Status 2026/08:** specified by two standards published upstream, the
building blocks of the multi-key account keystone recommended by
MPS-0018, and realised end to end by the reference implementation at
`contract/` (both MIPs in one deployment, conformance suites passing,
an independent bit-exact Rust signer):

- **MIP-0012 — Contract Custody of Midnight-Native Assets**: how the
  contract holds and releases unshielded and shielded value —
  stateless shielded custody, encrypted-inbox discovery, the
  surviving-coin change rule, an explicit per-color unshielded mirror,
  two payment modes (one-hop counterparty-private routing and
  linking-accepted direct transfer) — with authorisation abstracted to
  a single seam (`require_authorised()`) whose observable semantics
  are fixed.
- **MIP-0013 — Multi-key Account Authorisation for Custody
  Contracts**: rolling single-use device entries (each gated call
  consumes an entry and inserts its successor, AUTH-9), revocation
  epochs (one bump invalidates every stale credential), device
  lifecycle ceremonies with a last-device guard, a dedicated
  `auth_nonce` freshness counter, per-circuit challenge binding with
  witness-value pinning (AUTH-10), a post-deploy bootstrap (the
  constructor stores a salted commitment; `activate_initial_device`
  installs the real entry, since no deploy-time code can know the
  contract's own address), and the seam instantiated with in-circuit
  JubJub Schnorr (see C5). A recovery seam is fixed but its mechanism
  is deferred to the recovery-paths MIP (C14).

Implementing the standards surfaced three errata (the direct-transfer
return signature, the DST derivation, and the bootstrap), all folded
back into the upstream texts. Scoped grants (C10/C11) remain a
permitted extension behind the same seam — deliberately not baked into
either building block.

**Status 2026/09:** the reference contract has moved on three fronts,
and two gaps in the published standard are measured.

- **Co-resident authorisation arms.** Every gated operation is
  exported once per scheme (`<operation>_with_jubjub`,
  `<operation>_with_k256`) over shared custody chips and one device
  set; cross-arm enrolment works in both directions on node. The k256
  arm carries a per-device signing envelope (none, or the
  dApp-connector prefix) bound at enrolment, which admits connector,
  MPC, and HSM ECDSA signers with no upstream change. The full deploy
  exceeds ledger-9 per-block limits, so the client deploys in waves.
  The signature-schemes MIP (C5) standardises this shape.
- **Callee composition.** The account participates as a cross-contract
  callee: a counterparty contract drove a seam-gated circuit and the
  seam verified inside the callee; value crosses the boundary as send
  plus same-transaction claim. Consequence: the account's circuit
  signatures and verifier keys are a public ABI that third-party
  contracts compile against.
- **Scoped grants at `spec_version = 2`.** The grant records, their
  per-arm spend twins, and the lifecycle circuits are on the contract
  and exercised on node (C10 to C12).
- **Gap: weak keys.** The curve identity passes as a device key on
  both arms and authorises with no secret. The contract rejects it at
  the seam and the bootstrap; MIP-0013 §4 does not yet require it.
- **Gap: removal retires an entry, not a device (erratum 8).** A device
  that enrols a second entry for its own key survives `remove_device`;
  deriving the entry in-circuit does not prevent it. Only the epoch
  bump is a complete revocation. The remedy is a contract-maintained
  device identity in §3, a schema change proposed to ride the
  `spec_version = 2` redeploy; ruling pending upstream.

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

**Fleet migration.** Circuits are evolvable in place via the contract
maintenance authority (empirically verified: remove, rewrite, and add
circuits at the same address, ledger state preserved), and the next
ledger line extends maintenance to the circuit IR itself — but the
ledger state schema is fixed at deploy, and upstream's own
major-version transition ships no state migration at all (new ledger
lines bootstrap fresh chains). The MIPs version via a `spec_version`
cell and a `Replaces` chain; tooling for migrating a deployed fleet
across schema or ledger generations remains implementation work.

**Device identity (erratum 8).** Complete revocation needs a
contract-maintained device identity in MIP-0013 §3. That is a
state-schema change and so a redeploy; the question is whether it
rides the scoped-grants `spec_version = 2` redeploy, as that draft
proposes, or a separate one. Decision pending upstream.

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
by both MIPs; *detection:* the conformance suite's
rejection-matrix tests.

**Weak-key acceptance.** A curve-identity "key" authorises with no
secret on either arm. Rejected by the reference implementation at the
seam and the bootstrap; not yet required by MIP-0013 §4. *Detection:*
the identity-key rejection rows in the conformance suite.

**Incomplete revocation.** A device that enrolled a second entry for
its own key survives `remove_device` (erratum 8, measured on both
arms). Mitigated today by the epoch bump; fixed only by a
contract-maintained device identity. *Detection:*
`npm run probe:revocation` in the reference implementation.

## Alternatives

**A — One Compact contract per account.** **Chosen — normative in
MIP-0012.** Per-user schema evolution, isolated failure; the
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

**C — P-256 ECDSA (passkey assertion).** Viable, evidenced, and now
**registered as the r1 arm** of the signature-schemes MIP draft (C5).
In-circuit ECDSA-P256 verification is measured at practical cost
(k=15, sub-second proving) against a real platform passkey assertion,
and upstream carries P-256 as a first-class proof-system chip with
secp256r1 operations in ZKIR v3 — the "prohibitively expensive"
rationale no longer holds. The JubJub Schnorr choice (B) stands as the
trunk on its own grounds: FROST-compatibility, native-curve
verification cost, and approval / proving separation. C is the arm for
flows where the signing operation must occur inside the
authenticator's secure element, and the natural shape for a PRF-free
fallback (C9). Gated on the secp256r1 Compact language surface.

**D — ECDSA-secp256k1 (interim k1 arm).** Co-resident with B in the
reference contract, registered with Interim status and a named sunset
in the schemes draft. Its per-device signing envelope is what admits
dApp-connector ECDSA signers today.

**E — BIP-340 Schnorr over secp256k1 (Midnight wallet key).** Named
candidate: every wallet signing surface already produces it, and
verification is measured in-circuit at k=15 to k=16 on real wallet
vectors. Blocked in Compact only on secp256k1 point operations.
