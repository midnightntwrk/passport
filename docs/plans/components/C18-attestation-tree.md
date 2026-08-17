# C18 · Attestation tree

**Serves:** P9.

## Outcome

Merkle tree of attribute leaves anchored on-chain — the substrate for
credentials. Each leaf is a `persistentHash([domain_separator,
user_secret_key])` or similar. The user holds their secret key and
Merkle proof locally.

## Dependencies

- **C8** — domain separator in leaf construction.
- **C16** — Merkle proofs held in wallet local storage.
- **C19** — issuance produces leaves and updates the on-chain root.
- **C20** — proofs of membership consume the Merkle tree.

## Open questions

**Tree depth and width.** What is the maximum number of attributes per
user? Affects proof size and cost.

**Update model.** Issuer updates the root by submitting an update
transaction; how is concurrency handled when multiple issuers update
simultaneously?

**Multi-issuer support.** One tree per issuer (parallel trees) or shared
tree (issuers append to common root)? Shared is more efficient; parallel
is easier to attribute.

## Failure modes

**Tree update conflict.** Concurrent issuer updates cause one to be lost
or rolled back. *Detection:* simulated concurrency test.

**Proof staleness.** User's Merkle proof is invalidated by tree updates.
*Detection:* proof verification fails after issuer updates root.

**Domain-separator confusion.** Cross-reference C8. *Detection:* an
attestation leaf can be confused with a non-attestation use of
`persistentHash`.

## Alternatives

**A — One tree per issuer** (parallel; clear attribution).

**B — Shared tree across issuers** (efficient; attribution via leaf
metadata).

**C — Hybrid (shared root for global presence, per-issuer subtrees).**
