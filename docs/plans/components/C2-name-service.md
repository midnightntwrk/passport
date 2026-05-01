# C2 · Name service

**Serves:** P2 · P8 · P10.

## Outcome

Name ↔ account binding plus name resolution. Every account has a stable,
human-readable name (P2). Resolves to chain-native addresses for
transfers and to Passport's account anchor (C1) for protocol operations.
Cross-chain extensions via P10 / C25.

## Dependencies

- **C1** — names bind to account-custody contract instances.
- **C8** — namehash uses domain-separated `persistentHash`.
- **C18 – C21** — names appear in credential payloads where appropriate.
- **C25** — cross-chain resolution boundary with the upstream MCS layer.
- **External** — Midnight-native naming infrastructure per design doc § 4.

## Open questions

**Registry / Resolver split or single contract?** ENS separates
`namehash → owner` from `namehash → records`. Single contract is simpler
but less flexible; split is more flexible at cost of complexity. The
design doc § 4.1 recommends split.

**Anti-squat policy.** Per-device-key rate limit (design doc: 3 commits
/ 24h), proof-of-personhood, auction-only — or a combination?

**Cross-chain resolution.** With P10 in scope, names need to resolve to
addresses on multiple chains. Mechanism: per-resolver function
(`addr(chain)` style), via the upstream MCS layer, or both?

**Reserved names.** Whose authority? Design doc proposes DAO governance;
what's our v1.0 governance model?

## Failure modes

**Squatting at scale.** Pre-registration of common names; rate-limits
insufficient. *Detection:* high fraction of registered names go unused
or are listed for sale.

**Homoglyph attack.** Visually-similar names confuse users. *Detection:*
phishing reports of confusable names; ENSIP-15 violation tests.

**Cross-chain resolution drift.** Name resolves to different addresses
on different chains in a way that breaks user expectations. *Detection:*
user-visible name resolution disagrees with what dApp uses.

## Alternatives

**A — ENS-style two-contract** (registry + resolver, ENSIP-15
normalisation in-circuit). Design doc default.

**B — Single-contract name service.** Simpler, less flexible.

**C — Hybrid with off-chain CCIP-Read** (subdomains, profile records via
off-chain gateway).
