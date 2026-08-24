# C19 · Credential issuance

**Serves:** P9.

## Outcome

Off-chain issuer (e.g., zkMe) verifies user attributes and contributes
leaves to the on-chain Merkle root (C18). Per design doc § 8.

## Dependencies

- **C18** — issuance updates this tree.
- **C8** — domain separators.
- **External** — zkMe (zkKYC), or alternative issuers (multi-issuer per
  P9).

## Open questions

**Issuer onboarding.** What does it take to add a new issuer?
Permissionless, governance-gated, or something in between?

**Issuer revocation.** If an issuer goes rogue or is decommissioned,
what happens to credentials they issued? Per design doc § 8.7 there is
revocation infrastructure; specifics?

**Issuance privacy.** The issuer learns what attributes are being issued
(that is the role); does the issuance transaction reveal the user's
identity to chain observers?

**Issuer reputation.** Multiple issuers possible; how does the user
pick? Reputation system, browsing UI, or default issuer?

## Failure modes

**Compromised issuer issues bogus credentials.** A breached issuer mints
credentials they should not. *Detection:* anomaly detection on issuance
volume or pattern.

**Issuer goes offline.** Users cannot get credentials issued.
*Detection:* user reports of stuck issuance flows.

**Cross-issuer confusion.** Two issuers use overlapping attribute
schemas; verifiers cannot disambiguate. *Detection:* a credential
intended for issuer A's schema is accepted under issuer B's.

## Alternatives

**A — zkMe as primary issuer** (design doc reference).

**B — Multi-issuer from day one** (per design doc principle 5).

**C — Hybrid (one default issuer + extension points for others).**

## Readings

- **External prior art.** A permissioned, commitment-holding issuer flow
  is realised by the agent-DID registry
  ([midnight-agent-did-manager](https://github.com/mzf11125/midnight-agent-did-manager),
  `contracts/did_registry.compact`): `issue_did` is gated on an on-chain
  issuer key, and request/issue state is stored as commitments; see
  [research/agent-did-registry.md](../../../research/agent-did-registry.md).
- **External prior art.** A single-attestor credential is realised by
  [Kredz](https://github.com/zkos-labs/kredz)
  (`kredz_score_profile.compact`): `attest_score` is gated on a
  witness-derived attestor key, and the score is stored only as a
  `persistentHash(score, salt)` commitment; see
  [research/kredz-credit-credentials.md](../../../research/kredz-credit-credentials.md).
