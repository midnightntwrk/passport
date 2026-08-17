# C24 · Fee model

> **Workstream — mechanism resolved.** How transaction fees are paid
> given DUST's non-transferability and the absence of a
> contract-paymaster. The mechanism is settled: wallet-level fee
> splitting (alternative A) is confirmed end-to-end by
> `experiments/dust-sponsorship-feasibility/` (F1 – F6, node 1.0.0).
> What remains open is the sponsor service contract and operator model.

**Serves:** P1 · P3 · P5 · P8.

## Outcome

A fee model that lets users transact from the moment they receive their
account — including from a zero-NIGHT, zero-DUST starting state — without
requiring a single named sponsor (P8) and without requiring the user to
acquire or manage DUST themselves (P1 spirit). Survives multi-device usage
(P3) and total-loss recovery (P5).

**Status 2026/06:** wallet-level DUST sponsorship lands end-to-end on
the current stack. The dust-sponsorship-feasibility experiment (F1 – F6)
produced five PASS and one PARTIAL whose "failure" refutes a
third-party corruption warning: a two-balanced Night transfer (F1), a
sponsored circuit call from a zero-NIGHT, zero-DUST user (F2), and —
decisively for onboarding — a sponsored **contract deployment** by a
zero-token user (F6). No NIGHT prerequisite exists; the fee model can
promise zero-token onboarding outright, with the NIGHT airdrop (B)
demoted to an optional follow-up for long-term self-sufficiency. The
negative tests failed in ways a sponsor service can detect and handle:
capacity exhaustion fails locally before anything reaches the node
(F5), and a TTL-expired round-trip is rejected at submission, making
the user's TTL the sponsor's hard latency budget (F4).

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
  `dust_actions` within the same transaction. Confirmed end-to-end on
  `midnight-node:1.0.0` (F1, F2, F6).
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

**Sponsor service contract.** The mechanism is confirmed; what C24 must
now specify is the service around it: sequential dust accounting per
sponsor wallet (building against unsettled sponsor state re-spends the
same dust coin and the node rejects with `DustDoubleSpend`), client-side
capacity detection (F5 fails locally inside
`balanceFinalizedTransaction`), the user-TTL latency budget (F4:
sponsor-side re-balancing cannot resurrect an expired base transaction),
explicit `['dust']` balancing (states intent, guards against coin-selection
regressions), and the privacy trade-off that the sponsor sees the user's
finalised transaction before submission and can link its dust spends to
user activity.

**End-to-end devnet confirmation (resolved).** Executed 2026/06 on
`midnight-node:1.0.0` at
[`experiments/dust-sponsorship-feasibility/`](../../../experiments/dust-sponsorship-feasibility/):
F1 – F6 all definitive, five PASS and one PARTIAL that refutes the
tutorial's corruption warning. Sponsored transfer, circuit call, and
contract deployment all land; zero-token onboarding is confirmed.

**Sponsor exhaustion behaviour.** What does the wallet do when a sponsor
rejects — retry, fall back to alternate sponsor, surface error? Bootstrap
users have no recourse without DUST. Detection is confirmed client-side:
an exhausted sponsor fails locally, before submission (F5).

**Transition from sponsored to self-funded.** When does the user stop
needing a sponsor — after first NIGHT receipt, after a DUST-balance
threshold, per-tx decision? Affects sponsor cost projections.

**Re-balance race / discipline (resolved).** The tutorial's corruption
warning is refuted on the current stack (F3): a sponsor that wrongly
balances with `tokenKindsToBalance: 'all'` degrades gracefully to
dust-only balancing — the user's already-balanced sections and change
output survive intact, and the node accepts. The warning presumably
described an older SDK. Recommendation unchanged: a sponsor should still
pass `['dust']` explicitly. The real discipline requirement sits
elsewhere: a sponsor must not balance against its own unsettled state
(serialise per wallet, or track pending dust spends), or the node
rejects the second transaction with `DustDoubleSpend`.

**Sponsor abuse mitigation.** Without rate-limiting, a sponsor is a free
fee resource. What rate-limit, authentication, or proof-of-personhood
does v1.0's reference sponsor require?

**OAuth-façade compatibility.** Can a sponsor expose an OAuth-shaped
surface (P8 rationale) so third-party dApps request sponsored fees through
the same compatibility layer as P7 grants?

**C4 interaction (resolved).** Contract-call shapes compose cleanly
with wallet-level fee splitting: F2 landed a sponsored circuit call and
F6 a sponsored contract deployment — the two transaction shapes
contract custody needs. The sponsored-provider seam is small: a
midnight-js `walletProvider.balanceTx` that runs the user phase then
the sponsor phase, which is the sponsor service in miniature.

## Failure modes

**Sponsor service unavailable.** A fresh-account user with zero NIGHT and
zero DUST cannot transact at all without a sponsor. *Detection:* fresh
accounts produce transaction-submission timeouts; no sponsor reachable
across the configured directory.

**Re-balance corruption.** Refuted as a corruption risk on the current
stack (F3 degrades gracefully); the surviving failure mode is the
sponsor balancing against its own unsettled state, which the node
rejects with `DustDoubleSpend`. *Detection:* submission errors on the
second of two quickly-successive sponsored transactions; *mitigation:*
serialise balancing per sponsor wallet.

**Sponsor exhaustion.** Sponsor's NIGHT-derived DUST runs out under load
(per the tutorial: roughly 50k – 500k transactions per 100 NIGHT before
regen-bound). *Detection:* confirmed client-side — the balancing call
fails locally with `Insufficient Funds: could not balance dust` before
anything reaches the node (F5).

**DUST regeneration model changes.** Protocol-level changes to NIGHT →
DUST generation break the bootstrapping assumption — regen-rate
adjustments, eligibility rules. *Detection:* `DustGenerationDetails` API
surface or design doc § 5.6 changes.

**TTL expiry across the round-trip.** User signs, sends to sponsor;
sponsor processes too slowly; tx TTL expires before submission.
Confirmed behaviour (F4): the node rejects at submission and the
sponsor balancing with a fresh TTL cannot resurrect the expired base
transaction — the user's TTL is the sponsor service's hard latency
budget. *Detection:* sponsor service receives valid transactions that
fail with TTL errors.

## Alternatives

**A — Wallet-level fee splitting (the tutorial pattern).** User balances
`{shielded, unshielded}`, excluding `dust`; sponsor balances `{dust}` via
`tokenKindsToBalance`; sponsor signs and submits. **Confirmed
end-to-end** (F1 – F6 on `midnight-node:1.0.0`), including the sponsored
contract deployment (F6) that begins every Passport onboarding. Most
direct fit for fresh-account onboarding from a zero-NIGHT, zero-DUST
start; no contract-paymaster and no upstream changes required.

**B — NIGHT airdrop.** Sponsor sends NIGHT to user once; user generates
own DUST automatically and pays own fees thereafter. Trade-off: slower
bootstrap — wait for DUST regeneration before first user-paid tx. Cost:
sponsor holds NIGHT, not just DUST. Operational simplicity: no
shared-balancing complexity, no cross-wallet handshake per tx. With A
confirmed, B is demoted to an optional follow-up that gives users
long-term self-sufficiency rather than a bootstrap prerequisite.

**C — Hybrid (A for first tx, B for ongoing).** First user tx via
wallet-level fee splitting; same call path includes a NIGHT airdrop
transitioning the user to self-funded for subsequent txs. Combines
fastest bootstrap with eventual self-funding.

**D — User pre-funds NIGHT externally.** No sponsor service. User must
acquire NIGHT before onboarding (faucet, exchange, external transfer).
Hardest UX; incompatible with the "newcomer" persona.

*Future direction — once Midnight v1+ adds a protocol-level paymaster
surface, it would obviate the sponsor model entirely. Not on v1.0;
tracked as a v1+ enhancement.*

## Readings

- **MVP (October demo):** B (NIGHT airdrop) — operationally simplest;
  bootstraps from a single transfer and avoids the
  shared-balancing/round-trip complexity for a demo timeline.
- **v1.0 deliverable:** A (wallet-level fee splitting) — the
  principled path, now confirmed end-to-end (F1 – F6). C (hybrid)
  remains a serious enhancement: the same sponsored call path can
  include a NIGHT airdrop that transitions the user to self-funded.
