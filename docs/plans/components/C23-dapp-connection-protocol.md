# C23 · dApp connection protocol

**Serves:** P7 · P8 · P10.

## Outcome

The CAIP-25-shaped, EIP-6963-discoverable protocol surface that lets
third-party dApps request scoped grants — including the
Sign-In-with-Passport (DecentralisedAuth) authentication half of the
same surface. Maps to MIP-5 / MIP-7.

## Dependencies

- **C10** — grants requested through this protocol.
- **C22** — intent surface determines what flows through the protocol's
  request / response shape.
- **C20** — selective-disclosure proofs travel through the protocol for
  compliance / sign-in.
- **External** — CAIP-25 spec, EIP-6963 multi-injected provider,
  WalletConnect v2 transport.

## Open questions

**Transport choice.** Provider injection, WalletConnect v2 relay,
deeplinks? Design doc § 5.9 references all three.

**Privacy scopes.** What scopes are pre-defined vs custom? CAIP-25 has
a permissions model; we need a Passport vocabulary.

**Cross-chain dApp integration.** A dApp with cross-chain UX (per P10) —
does the connection protocol expose chain agnosticism, or does the dApp
specify chains explicitly?

**MIP co-author.** Per MIPS.md, every MIP needs a named external
co-author. Who co-authors MIP-5 (connection protocol) — Lace, Midnight
Foundation, or both?

## Failure modes

**dApp can't integrate.** Protocol shape too Passport-specific for
ecosystem dApps. *Detection:* third-party dApp integration partner
can't construct conforming requests.

**Permission scope confusion.** A dApp asks for one scope but the
wallet enforces a different one. *Detection:* differential test of scope
translation.

**Transport unavailable.** WalletConnect relay down; dApp can't reach
wallet. *Detection:* fallback transport not configured.

## Alternatives

**A — CAIP-25 + EIP-6963 + WalletConnect v2** (design doc and Midnight
ecosystem default).

**B — Passport-native protocol** (more control, less ecosystem fit).

**C — Hybrid (CAIP-25 wire format with Passport-specific scope
vocabulary).**
