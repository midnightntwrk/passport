# C12 · Chain-side enforcement

**Serves:** P4 · P7.

## Outcome

Verifier circuits in (or paired with) C1 reject out-of-scope operations.
Enforces I-7.7 — the protocol, not the application, enforces grant
scope. Out-of-scope operations rejected at proof verification, not at
application discretion.

## Dependencies

- **C1** — verifier lives in or alongside the account-custody contract.
- **C10** — verifies against grant scope.
- **C8** — domain-separated proof inputs.
- **C6 · C7** — proof generation produces what the verifier checks.
- **C25** — cross-chain enforcement boundary if P10 grants span chains.

## Open questions

**Verifier inside or outside C1? (half-answered.)** Authorisation
verification is in-contract in the published standard: MIP-0013's
Schnorr verifier runs inside the account contract's circuits. What
remains open is where grant-scope evaluation lives once the grant
extension (C10) arrives — inline against the same seam, or in a
separate verifier contract.

**Scope-evaluation language.** Is grant scope evaluated by a generic
parameterised verifier or per-grant-shape circuits? Affects gas and
flexibility.

**Cross-chain enforcement (P10).** When an operation crosses chains,
does enforcement happen in C12 (Midnight-side) or in the upstream MCS
layer? Interface question with C25.

## Failure modes

**Out-of-scope op accepted.** Verifier mis-implements the scope check.
*Detection:* differential test.

**Verifier gas cost prohibitive.** Per-op proof verification cost
exceeds usable threshold. *Detection:* user-flow gas measurement.

**Scope-language mismatch with grant primitive.** C10's grant schema and
C12's scope language drift apart. *Detection:* a grant cannot be
expressed in the scope language, or vice versa.

## Alternatives

**A — Inline verifier inside C1** (NEAR-style, tight coupling).

**B — Separate verifier contract** (modular, higher gas).

**C — Generic parameterised verifier** (one circuit covers all grant
shapes; complex to verify cleanly).

**D — Per-shape circuits** (specialised; gas-efficient; less flexible).
