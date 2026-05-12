# C1 · Account-custody contract

**Serves:** P1 · P3 · P4 · P5 · P8.

## Outcome

The on-chain Compact contract representing a Passport account. Holds the
device set, name binding, active scoped grants, and — depending on C4's
chosen alternative — the user's Midnight-native asset balances. Every
Passport-touching operation interacts with this contract.

## Dependencies

- **C4** — asset-custody model determines what C1 holds vs. what lives at
  addresses.
- **C2** — name service binds names to C1.
- **C9** — devices register as authorised keys in C1; the chosen
  authentication scheme determines what is stored per device.
- **C10 · C11 · C12** — grants live in, operate on, and are enforced by
  C1.

## Open questions

**One contract per account, or single registry?** Per-account instances
(NEAR-style) give clean isolation but cost more to deploy and harder for
indexers; a single registry concentrates state and metadata.

**Who deploys.** Self-deployed at onboarding, or pre-deployed registry
the user joins?

**Upgrade path.** Compact contracts have no built-in upgradability per
the spec. How do we migrate the user base if the contract evolves?

**Authentication scheme.** How does C1 verify device authorisation —
preimage knowledge, Schnorr signature, or WebAuthn assertion? Trade-off
is circuit cost, MPC composability, and hardware-bound key claims. See
Authentication alternatives below.

## Failure modes

**Deploy cost prohibitive.** Per-account deploys exceed tolerable
onboarding cost. *Detection:* onboarding-cost projections at user-base
scale.

**Privacy concentration.** A single registry surface enables metadata
correlation across accounts. *Detection:* on-chain analysis enumerates
accounts with high precision.

**Upgrade fragmentation.** Version-skew between deployed contracts
breaks operations. *Detection:* a Compact spec change makes some
accounts incompatible with new tooling.

**Auth scheme forecloses MPC custody.** Choosing a sk-as-witness scheme
as C1's only mode means institutional / threshold-custodied flows
cannot authorise against C1 directly — they must route through
spending-conditions instead. *Detection:* attempt to compose a
FROST-custodied account against C1's circuit fails because no party
holds the full witness.

## Alternatives

**A — One Compact contract per account** (NEAR-style isolation).

**B — Single registry contract with accounts as entries** (cheaper,
privacy concentration).

**C — Hybrid** (registry for discovery + per-account contract for state).

## Authentication alternatives

**A — Hash-preimage witness.** Device holds a secret derived from
passkey PRF; C1 stores `persistentHash(s)`; circuit verifies preimage
knowledge. Cheapest verification, no curve arithmetic, works today.
sk-as-witness — does not compose with MPC / threshold custody.

**B — Jubjub Schnorr.** Device holds a Jubjub keypair (PRF-derived or
generated); C1 stores the public key; circuit verifies a Schnorr
signature. More expensive than (A) due to in-circuit curve arithmetic;
sig is exportable; composes with threshold protocols (FROST) for MPC
custody.

**C — P-256 ECDSA (passkey assertion).** Authenticator produces a
WebAuthn assertion natively; circuit verifies the P-256 ECDSA sig
against the structured WebAuthn payload. Blocked today — Compact has
no in-circuit P-256 verifier. Required for high-assurance flows where
the signing operation must occur inside the secure element.
