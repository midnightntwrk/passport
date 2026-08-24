# C20 · Selective-disclosure proof

**Serves:** P9.

## Outcome

The proof primitive — prove a property (membership in an attribute set)
without revealing the attribute or other identifying information. P9's
core deliverable.

## Dependencies

- **C18** — proofs prove membership in this tree.
- **C8** — domain separators.
- **C21** — paired with nullifier for replay prevention.
- **C6 · C7** — proof generation and witness handling.

## Open questions

**Proof size and verification cost.** What is the proof size on-chain,
and the verification cost per proof? Affects scalability.

**Composition with trade intents.** Per C22 open question: does a
selective-disclosure proof bind cryptographically to the trade intent
the user signs?

**Predicate expressiveness.** What predicates does the proof system
support — set membership only, range proofs, equality proofs, custom
Compact circuits? Range / equality / custom are more flexible.

## Failure modes

**Proof reveals more than intended.** Implementation flaw leaks
attribute or identifying info. *Detection:* differential test — does
the proof's public output uniquely identify the prover or attribute?

**Proof reuse breaks unlinkability.** I-9.2 violated — same proof
reused across uses. *Detection:* nullifier check (cross-reference C21).

**Predicate not expressible.** A use case requires a predicate the
system does not support. *Detection:* dApp integration request that
cannot be satisfied.

## Alternatives

**A — Compact-circuit-based proofs of Merkle membership** (design doc
default).

**B — BBS+ signatures** (W3C VC alternative; simpler interop with VC
ecosystem).

**C — Both — Compact circuits for Midnight-native, BBS+ for VC
interop.**

## Readings

- **External prior art.** Commitment-based holder-side selective
  disclosure in Compact is exercised end-to-end by the agent-DID registry
  ([midnight-agent-did-manager](https://github.com/mzf11125/midnight-agent-did-manager),
  `contracts/did_registry.compact`); see
  [research/agent-did-registry.md](../../../research/agent-did-registry.md).
