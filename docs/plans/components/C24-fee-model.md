# C24 · Fee model

> **Workstream.** How transaction fees are paid given DUST's
> non-transferability and the absence of a contract-paymaster.

**Serves:** P1 · P3 · P5 · P8.

## Outcome

A fee model that lets users transact from the moment they receive their
account — including from a zero-NIGHT, zero-DUST starting state — without
requiring a single named sponsor (P8) and without requiring the user to
acquire or manage DUST themselves (P1 spirit). Survives multi-device usage
(P3) and total-loss recovery (P5).

## Dependencies

- **Ledger `Intent` struct's `dust_actions` field** — the protocol
  primitive for fee payment within a Midnight transaction. The guaranteed
  segment (segment 0) always executes if the transaction is accepted at
  all, carrying dust fees regardless of fallible-segment outcomes. This is
  Cardano-collateral-shaped — the network is always paid.
- **Wallet SDK** — `@midnight-ntwrk/wallet-api: ^5.0.0` and
  `wallet-sdk-facade`, exposing `balanceUnboundTransaction`,
  `balanceFinalizedTransaction` with the `tokenKindsToBalance: 'all' |
  ('dust' | 'shielded' | 'unshielded')[]` parameter. Wallet-level fee
  splitting via this parameter populates the sponsor's Intent's
  `dust_actions` within the same transaction. Confirmed at type level.
- **Sponsor service** — substitutable per P8. Operator model is an open
  question.
- **C16** (Wallet local storage) — DUST generation status and regeneration
  rate held in local state.
- **Midnight DUST regeneration semantics** (design doc § 5.6) — automatic
  regeneration from NIGHT holdings; no explicit "register NIGHT" step
  documented.

## Open questions

**Sponsor operator model.** Who runs the v1.0 reference sponsor — a
Passport-blessed sponsor, a directory of community sponsors, self-host?
P8 permits substitutable operators, but a fresh-account user with no
NIGHT cannot transact unsponsored, so *some* sponsor must always be
available. A directory or self-host path needs to be documented before
v1.0.

**End-to-end devnet confirmation.** APIs verified at type level; on-node
behaviour not yet. Does a wallet-to-wallet split-balance transaction
actually land on `midnight-node:0.22.5`? Scaffolded as a follow-up
experiment at
[`experiments/dust-sponsorship-feasibility/`](../../../experiments/dust-sponsorship-feasibility/)
(README + EXPERIMENT_GUIDELINE only — no `src/` yet).

**Sponsor exhaustion behaviour.** What does the wallet do when a sponsor
rejects — retry, fall back to alternate sponsor, surface error? Bootstrap
users have no recourse without DUST.

**Transition from sponsored to self-funded.** When does the user stop
needing a sponsor — after first NIGHT receipt, after a DUST-balance
threshold, per-tx decision? Affects sponsor cost projections.

**Re-balance race / discipline.** The tutorial warns that re-balancing
other token types causes double-spending errors. The protocol-level
isolation comes from the Intent struct's per-segment atomicity — each
Intent's offers and `dust_actions` are bound, not interchangeable. The
wallet-level discipline question becomes: how do we ensure the sponsor's
`balanceFinalizedTransaction` call only modifies its *own* Intent's
`dust_actions` and doesn't disturb the user's already-finalised Intent?
Does v1.0 need a wallet-side wrapper to police this, or is the SDK already
structured to enforce it?

**Sponsor abuse mitigation.** Without rate-limiting, a sponsor is a free
fee resource. What rate-limit, authentication, or proof-of-personhood
does v1.0's reference sponsor require?

**OAuth-façade compatibility.** Can a sponsor expose an OAuth-shaped
surface (P8 rationale) so third-party dApps request sponsored fees through
the same compatibility layer as P7 grants?

**C4 interaction.** If C4 lands on contract-custody (alt A), do
contract-call signature shapes compose cleanly with wallet-level fee
splitting, or does the contract-call branch interfere?

## Failure modes

**Sponsor service unavailable.** A fresh-account user with zero NIGHT and
zero DUST cannot transact at all without a sponsor. *Detection:* fresh
accounts produce transaction-submission timeouts; no sponsor reachable
across the configured directory.

**End-to-end devnet rejection.** APIs exist but the node rejects the
resulting two-balanced transaction — fee-balance mismatch, signature
ordering, or TTL expiry. *Detection:* the planned experiment fails to
land a sponsored tx on devnet.

**Re-balance corruption.** Sponsor inadvertently re-balances shielded /
unshielded → double-spend errors. *Detection:* sponsor wallet returns
submission errors after the user already finalised their portion.

**Sponsor exhaustion.** Sponsor's NIGHT-derived DUST runs out under load
(per the tutorial: roughly 50k – 500k transactions per 100 NIGHT before
regen-bound). *Detection:* sponsor wallet rejects with capacity-exhausted.

**DUST regeneration model changes.** Protocol-level changes to NIGHT →
DUST generation break the bootstrapping assumption — regen-rate
adjustments, eligibility rules. *Detection:* `DustGenerationDetails` API
surface or design doc § 5.6 changes.

**TTL expiry across the round-trip.** User signs, sends to sponsor;
sponsor processes too slowly; tx TTL expires before submission.
*Detection:* sponsor service receives valid transactions that fail with
TTL errors.

## Alternatives

**A — Wallet-level fee splitting (the tutorial pattern).** User balances
`{shielded, unshielded}`, excluding `dust`; sponsor balances `{dust}` via
`tokenKindsToBalance`; sponsor signs and submits. Status: APIs verified at
type level; end-to-end devnet pending. Most direct fit for fresh-account
onboarding from a zero-NIGHT, zero-DUST start.

**B — NIGHT airdrop.** Sponsor sends NIGHT to user once; user generates
own DUST automatically and pays own fees thereafter. Trade-off: slower
bootstrap — wait for DUST regeneration before first user-paid tx. Cost:
sponsor holds NIGHT, not just DUST. Operational simplicity: no
shared-balancing complexity, no cross-wallet handshake per tx.

**C — Hybrid (A for first tx, B for ongoing).** First user tx via
wallet-level fee splitting; same call path includes a NIGHT airdrop
transitioning the user to self-funded for subsequent txs. Combines
fastest bootstrap with eventual self-funding.

**D — User pre-funds NIGHT externally.** No sponsor service. User must
acquire NIGHT before onboarding (faucet, exchange, external transfer).
Hardest UX; incompatible with the "newcomer" persona.

**E — Wait for contract-paymaster API.** Future direction once Midnight
v1+ adds protocol-level paymaster surfaces. Not on v1.0; track as a
future-enhancement candidate.

## Track readings

- **Track 1 (Demo):** B (NIGHT airdrop) — operationally simplest;
  bootstraps from a single transfer and avoids the
  shared-balancing/round-trip complexity for a demo timeline.
- **Track 2 (Spec / v1.0):** A (wallet-level fee splitting) — the
  principled path; conditional on the planned end-to-end devnet
  experiment landing. C (hybrid) is a serious contender if A is
  confirmed end-to-end.
