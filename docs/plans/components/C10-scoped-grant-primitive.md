# C10 · Scoped grant primitive

**Serves:** P7 · P10.

## Outcome

The authorisation primitive — operation type × object × quantitative
bounds. Used for both intra-user (device-to-device) and dApp grants. Per
P7.

## Dependencies

- **C1** — grants live in account-custody contract state.
- **C11** — issue / modify / revoke / expire operate on grants.
- **C12** — verifier circuits enforce grant scope.
- **C23** — dApp connection requests grants.
- **C25** — cross-chain grants flow through this boundary if P10's
  chain-agnostic grants are adopted.

## Open questions

**Grant scope schema.** Operation type (R / W / X) is fixed; object
scope (which assets, contracts, attestations) and quantitative bounds
(value cap, rate limit, expiry) need a concrete schema. Inherit NEAR
function-call key shape, or define Passport-specific?

**Compose with chain abstraction.** Per P10's I-10.3, trade intents
don't pin specific settlement chains. Are grants chain-agnostic by
default, or chain-scoped with an "all chains" option?

**Composition with selective disclosure.** When a dApp grant requires a
credential proof (P9), is the proof attached to the grant or supplied
per-request?

## Failure modes

**Schema unsuitable for ecosystem.** Third-party dApps can't express
their needs. *Detection:* dApp integration partners request schema
extensions.

**Implicit scope widening.** A grant modification operation silently
broadens scope without re-authorisation. *Detection:* code review or
scope-narrowing assertion test.

**Scope under-enforcement.** Verifier accepts an operation outside the
granted scope. *Detection:* differential test on out-of-scope
operations.

## Alternatives

**A — NEAR function-call key model** (battle-tested, well-understood).

**B — Capability-token model** (each grant is a signed capability).

**C — ZK-attested grants** (grant existence proven without revealing
details; tightest privacy).
