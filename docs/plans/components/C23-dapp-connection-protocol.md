# C23 · dApp connection protocol

**Serves:** P7 · P8 · P10.

## Outcome

The protocol surface that lets third-party dApps request scoped grants
— including the Sign-In-with-Passport (DecentralisedAuth) authentication
half of the same surface. **Open Wallet Standard (OWS)** is the committed
standard for the Cardano + Midnight workflow (approved 2026/05/13,
committed 2026/06/04). Passport commits to OWS: it supports and exposes
OWS-conformant APIs so that ecosystem dApps and Midnight City (an AI
simulation running on the Midnight blockchain,
[midnight.city](https://midnight.city/)) connect through one standard
surface. Underlying transport / discovery layers (CAIP-25, EIP-6963,
WalletConnect v2) sit beneath it. Maps to MIP-5 / MIP-7.

## Dependencies

- **C10** — grants requested through this protocol.
- **C22** — intent surface determines what flows through the protocol's
  request / response shape.
- **C20** — selective-disclosure proofs travel through the protocol for
  compliance / sign-in.
- **External · primary** — Open Wallet Standard (OWS); Passport is
  **committed** to OWS (2026/06/04). Integration with the Cardano +
  Midnight workflow approved 2026/05/13, **in progress** upstream; we
  track and engage the draft directly rather than waiting on it.
- **External · underlying** — CAIP-25 spec, EIP-6963 multi-injected
  provider, WalletConnect v2 transport.

## Open questions

**OWS spec maturity and shape.** OWS is in-progress upstream; what is
locked in the current draft, what is still moving, and what is our
extension surface inside it?

**OWS ↔ CAIP-25 / EIP-6963 relationship.** Does OWS subsume them, layer
on top, or coexist? The mockup currently treats OWS as the umbrella —
this needs upstream confirmation.

**Transport choice.** Provider injection, WalletConnect v2 relay,
deeplinks? Design doc § 5.9 references all three; OWS may pin one.

**Privacy scopes.** What scopes are pre-defined vs custom? OWS will
have a scope vocabulary; Passport adopts it and contributes any gaps
upstream rather than maintaining a private vocabulary.

**Cross-chain dApp integration.** A dApp with cross-chain UX (per P10) —
does the connection protocol expose chain agnosticism, or does the dApp
specify chains explicitly?

**MIP co-author.** Per MIPS.md, every MIP needs a named external
co-author. Who co-authors MIP-5 (connection protocol) — the Midnight
Foundation, a wallet provider, or both? OWS upstream contributors are
a candidate.

## Failure modes

**OWS draft churns.** Spec shifts after we integrate; rework cost.
*Detection:* we engage the OWS upstream draft directly, tracking the
change-log and contributing to its open questions rather than only
watching it; integration tests pinned to a specific draft version.

**dApp can't integrate.** Protocol shape too Passport-specific for
ecosystem dApps. *Detection:* third-party dApp integration partner
can't construct conforming requests.

**Permission scope confusion.** A dApp asks for one scope but the
wallet enforces a different one. *Detection:* differential test of scope
translation.

**Transport unavailable.** WalletConnect relay down; dApp can't reach
wallet. *Detection:* fallback transport not configured.

## Alternatives

**A — Open Wallet Standard (OWS)** *(committed 2026/06/04; approved
2026/05/13, in progress upstream)*. Cardano + Midnight workflow target;
common wallet-handshake surface across both ecosystems. Strategic pillar
of Midnight City, so Passport stays as close to canonical OWS as
possible.

**B — CAIP-25 + EIP-6963 + WalletConnect v2** (original design doc
default; now framed as the underlying-transport layer beneath OWS
rather than the top-level protocol).

**C — Passport-native protocol** (more control, less ecosystem fit).
Rejected: diverges from OWS.

**D — Hybrid (OWS wire format with Passport-specific scope
vocabulary).** Disfavoured: a private scope vocabulary forks from OWS
and weakens conformance. Prefer adopting the OWS scope vocabulary and
contributing any gaps upstream.
