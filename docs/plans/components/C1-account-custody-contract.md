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

**C — P-256 ECDSA (passkey assertion).** Viable, evidenced, not
chosen. In-circuit ECDSA-P256 verification has since been measured at
practical cost (k=15, sub-second proving) against a real platform
passkey assertion, and upstream now carries P-256 as a first-class
proof-system chip with secp256r1 operations entering the next ZKIR
revision — the "prohibitively expensive" rationale no longer holds.
The JubJub Schnorr choice (B) stands on its own grounds:
FROST-compatibility, native-curve verification cost, and approval /
proving separation. C remains the candidate for flows where the
signing operation must occur inside the authenticator's secure
element, and is the natural shape for a PRF-free fallback (C9).
