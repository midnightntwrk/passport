# C12 · Chain-side enforcement

**Serves:** P4 · P7.

## Outcome

Verifier circuits in (or paired with) C1 reject out-of-scope operations.
Enforces I-7.7 — the protocol, not the application, enforces grant
scope. Out-of-scope operations rejected at proof verification, not at
application discretion.

**Status 2026/09 — specified** by the scoped-grants MIP (see C10).
Enforcement is in-circuit, inside the account contract, through
per-arm grant twins of the spend circuits (`withdraw_unshielded`,
`withdraw_shielded`, and the third spend operation) over the unchanged
custody chips: the grantee seam authenticates, checks scope against
the consumed values, and settles with a per-grant nonce that never
touches `auth_nonce`. Connector-envelope keys are refused on the spend
seam in-circuit, so such grants are read-only by construction. The
text says plainly that the ledger enforces spend scope and not read
scope. On node, twelve rejection rows abort at build time with the
message the specification names, no transaction, and a byte-identical
ledger snapshot either side; nine grantee-key rows are refused on both
arms (`contract/GRANTS-E2.md`).

**Update 2026/10/01:** unshielded follow-up #163 is merged. Open
[#176](https://github.com/midnightntwrk/passport/pull/176) adds optional
immediate-contract pins using `kernel.caller()`. Forwarded calls were
accepted and a fabricated-caller proof refused at node admission. Schema
v3 needs reconciliation with P-256 #175 on integration; audit/formal work
(#67) remains. See [status](../STATUS.md).

## Dependencies

- **C1** — verifier lives in or alongside the account-custody contract.
- **C10** — verifies against grant scope.
- **C8** — domain-separated proof inputs.
- **C6 · C7** — proof generation produces what the verifier checks.
- **C25** — cross-chain enforcement boundary if P10 grants span chains.

## Open questions

**Verifier inside or outside C1?** Chosen: inside. Compact 0.35 now supplies
immediate caller identity. #176 keeps scope evaluation inside the account;
it does not implement a separate verifier or calling-circuit identity.

**Scope-evaluation language.** Resolved: per-shape circuits. Compact
compiles every exported circuit to its own proof, so one grant twin
per spend operation per grantee arm pays only its own scheme.

**Unshielded grant twins on node.** Both arms hold over a non-native
color; the user-funded NIGHT leg meets the node fee wall for
offer-plus-call transactions. Evidence merged in #163; retain its recorded
resource and funding-path qualifications.

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

**A — Inline verifier inside C1.** **Chosen 2026/09.** The grant seam
lives in the account contract behind the same `require_authorised()`
contract MIP-0013 fixes.

**B — Separate verifier contract.** Not selected. Immediate caller identity
is now available; a separate-verifier architecture needs its own evidence.

**C — Generic parameterised verifier.** Rejected: every exported
circuit is its own proof, so a generic circuit would pay every arm's
constraints on every call.

**D — Per-shape circuits.** **Chosen 2026/09.** One grant twin per
spend operation per grantee arm.
