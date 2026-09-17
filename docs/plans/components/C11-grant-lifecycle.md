# C11 · Grant lifecycle

**Serves:** P4 · P7.

## Outcome

The operations on grants — issue, modify, revoke, expire. Implements P4
(revoke-and-continue) and P7 (scoped grants) over time. Verifiable from
chain state per I-7.6.

**Status 2026/09 — specified** by the scoped-grants MIP (see C10).
`issue_grant` is one device-gated circuit; `revoke_grant` and
`revoke_all_grants` are available to any active device, take effect
from chain state in the same block, and the revoke-all is O(1). Expiry
is an explicit timestamp checked in-circuit on use through a block-time
read the node re-executes at admission; the unit is measured as whole
seconds since the UNIX epoch, enforced at client build and at node
admission and never in the proof (`contract/GRANTS-E3.md`). Renewal is
revoke then issue, composable in one transaction; there is no
modification concept. Expired and revoked records remain as tombstones
for enumerability; pruning and window enforcement are deferred to a
circuit revision. Exercised on node (`contract/GRANTS-E2.md`).

## Dependencies

- **C10** — operates on the grant primitive.
- **C12** — enforcement reads the current lifecycle state.
- **C1** — lifecycle state lives in C1.
- **C13** — lost-device flow leverages grant revocation.

## Open questions

**Revocation propagation.** Resolved: instant, from chain state, by
any active device; the epoch bump also invalidates every grant.

**Modification semantics.** Resolved: revoke then issue, in one
transaction if desired; `issue_grant` does not evaluate expiry.

**Expiry handling.** Resolved: tombstones. Pruning and window
enforcement are deferred to a circuit revision.

**Client-side expiry hygiene.** Which party prompts renewal, and how
the dApp learns its grant expired before a call fails at build time.

## Failure modes

**Revocation lag.** Revoked grant remains usable due to caching or
replication delay. *Detection:* timed test of revocation propagation
across the chain.

**State bloat.** Expired grants accumulate; chain state grows
unboundedly. *Detection:* per-account state-size projections at scale.

**Modify-as-replace race.** Two concurrent modifications cause one to be
lost. *Detection:* concurrency test on grant modify path.

## Alternatives

**A — Instant revocation, automatic expiry-cleanup.** Not chosen:
automatic cleanup needs a payer for the pruning transaction.

**B — TTL-based revocation, lazy expiry.** Rejected: a replay window
after revocation contradicts P4.

**C — Hybrid: instant for revocation, lazy for expiry.** **Chosen
2026/09.** Revocation is instant from chain state; expiry is checked
in-circuit on use and expired records remain as tombstones.
