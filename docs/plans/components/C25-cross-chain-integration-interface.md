# C25 · Cross-chain integration interface

> **Workstream — placeholder.** The integration boundary with the upstream
> cross-chain architecture. Owned upstream; Passport-side integration
> sequenced post-v1.0 initial release.

**Serves:** P3 · P5 · P7 · P8 · P10.

## Outcome

The boundary between Passport and the upstream cross-chain architecture
(solver network, MCS threshold-Schnorr vaults on external chains, Intent
Escrow Contract). Defines what Passport hands off (user-signed trade
intents, account identity, selective-disclosure proofs for compliance)
and what Passport consumes (settlement confirmations).

This canvas is a **placeholder** — the cross-chain machinery is delivered
upstream by Shielded Technologies. Passport integrates against their
architecture; we do not co-design it. The canvas captures the
*Passport-side* questions that will be answered once the upstream PRD /
ARD stabilises.

## Dependencies

- **Upstream Midnight Intents PRD** — the declarative trade-intent
  format. Defines what Passport's C22 intent surface produces.
- **Upstream MCS (Multi-Chain Signature) scheme** — threshold-Schnorr
  forking NEAR-MPC. Holds the per-chain signing authority for
  foreign-chain settlement.
- **Upstream solver network** — fills trade intents into routed
  multi-leg transactions.
- **Upstream Intent Escrow Contract** (Compact, on Midnight) — holds
  user funds during cross-chain settlement.
- **C1** (Account-custody contract) — Passport identity that names the
  user across chains; the same identifier resolves to chain-specific
  addresses via the upstream resolution layer.
- **C2** (Name service) — `alice.midnight` is the user's cross-chain
  handle.
- **C5 · C6 · C7** — Passport produces Jubjub-signed authorisations and
  ZK proofs at the Midnight layer; the upstream MCS layer produces
  foreign-chain signatures.
- **C10** (Scoped grants) — grants must compose with cross-chain
  operations; either chain-agnostic by default with constraint expressed
  at the trade-intent layer, or chain-scoped with an "all chains" option.
- **C20** (Selective-disclosure proof) — Passport's compliance
  contribution to a cross-chain trade may need to bind to the trade
  intent before it enters the upstream solver layer.
- **C22** (Intent surface) — produces what Passport hands off.

## Open questions

**Hand-off shape.** What exactly does Passport pass to the upstream
solver — a signed trade intent, a partially-constructed ledger Intent
plus solver instructions, or something else? Constrained by the upstream
PRD.

**Compliance binding across chains.** A selective-disclosure proof
constructed on the Midnight side must remain bound to the trade intent
all the way through cross-chain settlement. What's the cryptographic
binding mechanism — shared `binding_commitment`, separate proof in the
Intent Escrow Contract, or per-chain re-attestation?

**Settlement notification.** How does Passport learn that a cross-chain
trade settled? Upstream callback, on-chain event on Midnight, polling the
Intent Escrow Contract?

**Failure semantics.** What does "the cross-chain leg failed" look like
to Passport — funds returned to user, funds held in escrow, partial
settlement? Wallet UX needs to surface this.

**Substitutability of solver.** P8 demands no required operator. Can the
user point Passport at a different solver implementation that conforms
to the same upstream interface? What does "different solver" mean
concretely?

**Substitutability of MCS.** Same question for the threshold-signature
layer. Is the MCS signing committee a single named entity at v1.0, and
how is its substitutability framed?

**Cross-chain identity continuity.** I-10.4 — Passport identity must be
preserved across chains. Concretely, does the upstream layer derive
foreign-chain addresses from the Passport account identifier
deterministically, or does the user pre-register per-chain receive
addresses?

**Intent Escrow trust assumptions.** The escrow contract holds user funds
during the cross-chain leg. What's the trust model — fully on-chain
custody, MPC-controlled, time-locked? Affects what users sign and what
they expose.

**Recovery interaction.** If the user loses all devices mid-trade, does
the upstream layer have a recovery affordance, or does P5 / C14 need to
extend across the boundary?

## Failure modes

**Upstream PRD never stabilises.** Passport-side construction code can't
be written against a moving target. *Detection:* PRD release notes
indicate ongoing breaking changes; Passport's C22 surface forced into
adapter patterns.

**Hand-off shape forces wallet UX compromise.** The upstream interface
demands Passport surface ledger-Intent-shaped objects to users when the
wallet UX target is declarative trade intents. *Detection:* C22's
"Track 2 target" alternative becomes infeasible because the upstream
boundary requires alternative B or D.

**Cross-chain identity leak.** The mechanism that preserves Passport
identity across chains exposes correlatable identifiers per chain.
*Detection:* on-chain analysis links a Passport account to its
foreign-chain receive addresses.

**Compliance proof unbinds across the boundary.** A
selective-disclosure proof bound to the Midnight-side trade intent loses
its binding when handed to the upstream solver. *Detection:* the same
proof can be replayed against unrelated cross-chain trades.

**Settlement notification unreliable.** Wallet UX shows stale state
because Passport doesn't reliably learn settlement outcomes. *Detection:*
user-visible settlement status disagrees with on-chain ground truth.

**MCS becomes a required operator.** Despite P8, the MCS signing
committee is effectively a single named operator at v1.0. *Detection:*
no alternative MCS implementation exists; user has no path to use a
different threshold-signature provider.

## Alternatives

**A — Integrate verbatim against upstream PRD / ARD.** Passport adopts
the upstream interface as-published; C22 produces what the upstream layer
expects; settlement notification uses whatever upstream provides.
*Default for v1.0 once upstream stabilises.*

**B — Adapter layer.** Passport defines its own Passport / cross-chain
boundary and an adapter translates to the upstream interface. Insulates
Passport against upstream churn at the cost of adapter maintenance.

**C — Wait until upstream ships before Passport-side integration.**
Passport ships v1.0 initial release as Midnight-only; C25 integration
follows when upstream is stable. *Recorded as the default sequencing.*

**D — Co-build with upstream.** Tighter coupling than A — Passport
contributes to the upstream interface design rather than only consuming
it. Higher coordination cost; only viable if upstream invites
co-authorship.

## Track readings

- **Track 1 (Demo):** Out of demo entirely. The October demo is
  Midnight-only; cross-chain comes online additively when the upstream
  work lands.
- **Track 2 (Spec / v1.0):** A (integrate verbatim against upstream
  PRD / ARD), with C (wait until upstream ships) as the sequencing
  default.
