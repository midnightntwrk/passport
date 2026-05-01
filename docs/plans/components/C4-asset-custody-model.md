# C4 · Asset custody model

> **Workstream.** The upstream design question for the cryptographic
> stack: derivation, signing, recovery, and storage all fall out of the
> choice made here.

**Serves:** P3 · P4 · P5 · P6.

## Outcome

A ratified choice of how user assets are held, authorised, and recovered —
satisfying P3 (multi-device), P4 (lost-device recovery), P5 (total-loss
recovery), and P6 (key non-exfiltration) simultaneously, integrating
cleanly with C1 (account-custody contract), C5 (signing primitive), C14
(total-loss recovery flow), and C16 (wallet local storage).

## Feasibility map

Established by `experiments/contract-custody-feasibility/` (S1 – S6,
evaluated against `midnight-node:0.22.5`).

| Asset class · direction | Status |
|---|---|
| Night · user ↔ contract | **Feasible** (U1, U3 PASS) |
| Night · contract ↔ contract | **Protocol-feasible; SDK-blocked.** Pending fixes: `midnight-js` multi-contract-call utility + wallet `midnight-wallet#293`. Workaround: route through user → user. |
| Shielded · user → contract deposit | **Feasible** (S4 PASS, via `rawTokenType` recipe). |
| Shielded · contract → user / cross-block | **Feasible** (S6 PASS, via OZ `Map<color, QualifiedShieldedCoinInfo>` + `Map.insertCoin` pattern). |
| Shielded · contract ↔ contract | **Untested.** Not exercised by S1 – S6. Plausibly subject to the same same-tx pairing requirement that blocks Night U2 — and therefore plausibly blocked by the same SDK gap. Follow-up probe needed. |
| Dust · contract pays user fee | **Not feasible on v1** — *contract-attached* paymaster only. Does not preclude wallet-level sponsorship; see C24. |
| Foreign-chain assets (cross-chain) | **Out of C4's scope** — handled by upstream cross-chain vaults via C25 (Cross-chain integration interface). Passport's account-custody contract custodies Midnight-native assets only. |

## Dependencies

- **C1** — implementation vessel. C4 determines what C1 holds.
- **C5** — signing surface constrained by custody choice.
- **Upstream** — `midnight-js` multi-contract-call utility and
  `midnight-wallet#293` (gates contract ↔ contract Night).

## Open questions

**QSCI privacy trade-off.** The OZ pattern stores `Map<color,
QualifiedShieldedCoinInfo>` in *public* ledger state — the contract's
holdings (value and colour) are publicly visible. This is a meaningful
privacy regression vs. user-held shielded notes. Do we accept QSCI
publicity as a v1.0 trade-off, or design mitigations (padding, dummy
entries, value-bucketing, salted commitments)?

**Asset-class boundary.** Same custody pattern across Night, Shielded, and
Dust, or hybrid by class? The Dust gap may force hybrid regardless of
preference.

**Per-device vs. derivation.** If contract-custody, do per-device Jubjub
keys directly authorise contract calls (no HD tree), or do we derive
per-account-and-role from a seed root for compatibility and recovery?

**Recovery semantics.** How does the chosen model preserve "recovered
account ↔ recovered assets" under I-5.3 (continuity of identity)?
Contract-custody: assets follow C1, straightforward. Address-custody:
depends on whether the seed sits in the recovered envelope.

**OAuth façade compatibility.** Does the chosen custody pattern work
cleanly behind an OAuth-shaped façade (P8 rationale), or does the façade
need a custody-specific adapter?

**Dust fee path.** Delegated to C24 (Fee model). C4 owns the
*custody-side* question (where Dust balances live, if anywhere); the
*fee-payment* question lives in C24.

**Shielded contract ↔ contract feasibility.** Untested by S1 – S6.
Plausibly subject to the same same-tx pairing requirement and SDK gap that
blocks Night U2. Doesn't affect alternative A's viability for ordinary
user operations (which only need user ↔ contract flows), but matters for
dApp-contract integration patterns. Tracked as an S7 follow-up to be
appended to `experiments/contract-custody-feasibility/`.

## Failure modes

**QSCI publicity is unacceptable.** We adopt the OZ shielded pattern;
publicly-visible contract holdings break a downstream privacy invariant —
e.g., balance-based linkability across calls. *Detection:* on-chain
analysis of the contract's ledger state reveals balance and token-type
distributions per account.

**Inter-contract Night fix never lands.** The two pending SDK PRs stall.
Designs that depend on contract ↔ contract Night flows remain stuck on
user → user routing. *Detection:* candidate designs fail U2 / U4-shaped
probes.

**Address-custody re-introduces seed dependency.** Architecture requires
the user (or a process the user must trust) to reconstruct a seed for
asset operations. *Detection:* P1 violated — seed surfaces in any
user-required flow.

**Hybrid creates cross-class friction.** Mixed-pattern custody requires
multi-step orchestration for common operations. *Detection:* user-facing
flows decompose into multiple proof flows the wallet UI cannot collapse.

**Recovery doesn't follow assets.** Recovery restores account identity but
not asset access. *Detection:* C14 end-to-end test fails to restore
visible balances.

## Alternatives

**A — Contract-custody (Night + Shielded via OZ pattern).** All non-Dust
assets in C1; per-device Jubjub keys authorise contract calls. Trade-off:
QSCI publicity for contract-held shielded coins. Dust takes a separate
path (see C24).

**A′ — Contract-custody with QSCI mitigations.** Same as A, with privacy
mitigations layered on (padding, dummy entries, value-bucketing). Cost:
additional contract complexity and on-chain state. Open question: are the
mitigations sufficient, or do they only narrow the leak?

**B — Address-custody.** Assets at chain-native addresses derived from a
seed-shaped root. C1 holds only devices, grants, and names. Inherits
CIP-1852 or equivalent HD derivation. P1 tension: I-1.1 says "user never
*required* to see or hold seed" — a seed wrapped in C16 and used only by
signing satisfies P1 even if a seed exists.

**C — Hybrid by asset class.** Night + Shielded in contract-custody (per
A); Dust at addresses (or vice versa). May be forced by the Dust gap
regardless of preference for A.

**D — Wait-and-transition.** Hold off until the inter-contract Night fix
and a Dust paymaster API are available. Risk: indefinite — Dust paymaster
has no announced timeline; inter-contract Night fix has PRs but no merge
date.

## Track readings

- **Track 1 (Demo):** B (address-custody) — fastest to ship; sidesteps the
  QSCI publicity question; takes the seed-existing-but-wrapped reading of
  P1.
- **Track 2 (Spec / v1.0):** A or A′ (contract-custody) — the principled
  path; requires resolving the QSCI publicity question and either
  accepting the trade-off or layering mitigations. The cryptographic-stack
  design downstream of this canvas is calibrated to A / A′ as the v1.0
  destination.
