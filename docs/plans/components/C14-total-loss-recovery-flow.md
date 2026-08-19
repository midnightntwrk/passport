# C14 · Total-loss recovery flow

**Serves:** P1 · P5 · P6.

## Outcome

The flow by which a user recovers their account when all authorised
devices are lost. Implements P5 (recover-from-zero). Mirrors I-5.1
through I-5.4.

**Status 2026/07 — decided; specification is the next step.** The
mechanism is **BUSS (ANARKey, EPRINT 2025/551): stateless guardians
plus paper keys**, chosen after the workspace assessment
(`research/anarkey-buss-recovery-assessment.md`, PR #90) and already
implemented in the account-custody prototype, replacing its
plaintext-Shamir placeholder:

- **On-chain:** the recovery commitment plus the BUSS public vector φ
  (up to four 32-byte points) and a session nonce — nothing else. φ is
  provably simulatable, so no secret material sits in public state.
- **Guardians are stateless:** each derives its share on demand as
  `σ = H(session_id ‖ own_sk)` from a key it already holds — nothing
  to store, nothing to verify daily. Any `t+1` guardians plus the
  on-chain φ reconstruct the recovery secret off-chain.
- **Recovery executes through the seam** fixed by the
  account-authorisation MIP: the recover circuit verifies the
  recovery authorisation, bumps the device epoch (invalidating every
  stale device and grant), registers exactly one fresh device, and
  clears φ. Assets never move; the encrypted inbox rebuilds the coin
  store from chain data.
- **One wire format everywhere:** `buss-req.v0` / `buss-sig.v0` /
  `buss-paper.v0` strings and the guardian-key derivation are shared
  between the CLI and the app, so an app user can guard a CLI account
  and vice versa. The BUSS mathematics runs client-side through
  `buss-wasm` (wasm-bindgen over the Pleiades library).

What remains is to **specify it** — the recovery-paths MIP (building
block three), instantiating the seam with the BUSS construction while
keeping the contract surface scheme-agnostic, with DeRec and
encrypted-blob backup as substitutable profiles behind the same seam.

## Dependencies

- **C15** — the guardian protocol; realised in the prototype as the
  BUSS wire formats above.
- **C1** — recovered identity reattaches to the same account (epoch
  bump; assets never move).
- **C16** — recovery reconstructs into wrapped storage on a fresh
  device.
- **C9** — the fresh device's passkey-derived key registers on the
  recovered account.
- **External** — the Pleiades (arc-pleiades) library consumed by
  `buss-wasm`; the ANARKey paper (EPRINT 2025/551) as the construction
  reference.

## Open questions

**Parameters and policy.** Guardian-set size and threshold defaults
(the prototype supports up to four φ points), guardian onboarding and
replacement ceremonies, and whether a time-locked self-recovery path
complements the guardian quorum.

**Guardian-request authentication.** How a guardian satisfies itself
that a `buss-req` really comes from the account owner (out-of-band
confirmation UX) — the maths bounds what a malicious quorum can do,
the UX bounds how often one forms.

**Recovery of the encryption secret.** The device set recovers via the
epoch bump; the account encryption secret (viewing capability, inbox
walk) must also survive total loss — inside the BUSS-recovered
material, or as a separate item in the paper key?

**Cryptographer review of the integration.** The ANARKey construction
is published; our integration (φ handling, session nonces, the
φ-clearing step, wire formats) needs the same review discipline as the
custody and authorisation MIPs — an acceptance criterion for the
recovery MIP.

**MPS-0018 cross-listing.** The recovery-paths MIP is the second
recommended MIP of MPS-0018; the upstream recommendation names DeRec
and encrypted-blob, so the draft should position BUSS as the realised
mechanism and those as substitutable profiles.

## Failure modes

**Insufficient guardians respond.** Below-quorum participation.
*Detection:* user-initiated recovery times out or stalls. Paper keys
are the no-social-graph backstop.

**Compromised guardians collude.** An above-quorum coalition
reconstructs without user consent. *Detection / bound:* the session
nonce and on-chain φ scope what a coalition can do and when; guardian
UX confirms requests out of band.

**Recovery exposes seed material to the UI.** I-1.4 violated — the
recovered secret must flow into the recover circuit's witness, never
onto a screen. *Detection:* code review of the recovery flow.

**Recovered identity does not match original.** Different name or
account anchor than registered. *Detection:* the end-to-end recovery
test fails to restore visible balances and credentials.

**Library dependency.** `buss-wasm` binds the Pleiades library as a
git dependency; version drift or upstream stall affects the reference
implementation. *Detection:* pinned builds; the MIP specifies the
construction, not the library.

## Alternatives

**A — DeRec (3-of-5 Shamir, daily verification).** Not chosen:
stateful helpers with a daily verification burden; remains a
substitutable profile behind the same seam.

**B — Encrypted-blob backup to user-chosen storage.** Complementary
profile for users without a social graph; the BUSS paper key already
covers much of this ground.

**C — Hybrid (social + blob fallback).** Effectively what the chosen
design delivers: guardians plus paper keys, one mechanism.

**D — Identity-proof-based recovery** (KYC re-establishes the
account). Rejected: weaker security, introduces an identity operator.

**E — BUSS / ANARKey stateless guardians + paper keys.** **Chosen
2026/07** — assessed (PR #90), implemented in the account-custody
prototype behind the MIP-0013 recovery seam, and next to be specified as
the recovery-paths MIP.
