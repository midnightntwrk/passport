# C17 · View-key + indexer sync

**Serves:** P3 · P8.

## Outcome

The read half of the wallet — how visible chain state is reconstructed
for the UI, and what (if anything) a substitutable indexer must be
trusted with to do it. Substitutable per P8.

**Status 2026/07 — the view/spend separation is settled; the sync
architecture is reframed by it.** For account-custodied assets the
custody MIP (MIP-3A) makes the separation normative and the
stateless-shielded-custody experiment validated it end to end:

- **Read** is the account encryption secret — a pure *viewing
  capability* (MIP-3A R9). It decrypts the inbox and drives the
  normative discovery walk (6.5), reconstructing every holding from
  public chain data; it confers no authority to move a single coin
  (S2). Delegable out of band to an accountant, auditor, or compliance
  function without ceding custody; rotation is specified (6.7).
- **Spend** is the authorisation seam — the device JubJub key of
  MIP-3B. Different secrets, independently held, independently
  delegable. Validated by W5 (third-party deposit → owner decrypts →
  owner spends) and bounded by the W6 leak audit.

The load-bearing consequence for this canvas: **for account-held
assets, no viewing key is ever handed to an indexer.** The inbox walk
needs only public chain data plus local decryption, so the indexer
stays generic — its one required surface is contract-address →
transaction enumeration, which is exactly the gap W5 recorded (PARTIAL
verdict) and MIP-3A's Path to Active tracks as an ecosystem
dependency. The classic "hand the view key to a hosted indexer"
trade-off survives only where protocol-level Zswap viewing keys are
still in play (below).

## Dependencies

- **C16** — the account encryption secret and any protocol viewing
  keys are held in wallet local storage.
- **C4 / MIP-3A** — the inbox walk is the normative discovery
  procedure; the enumeration surface is its ecosystem dependency.
- **C2** — sync includes name ownership state.
- **C10 · C11** — sync includes grant state.
- **C18 – C21** — sync includes attestation Merkle proofs.
- **External** — Midnight indexer protocol; third-party or self-hosted
  indexer providers.

## Open questions

**Indexer enumeration surface.** Contract-address → transaction
enumeration does not exist today; discovery falls back to walking the
inbox counter or a block scan. Request upstream (tracked in MIP-3A's
Path to Active), and define the fallback's performance envelope.

**User-held coin sync (narrowed by the exclusivity decision).** The
one-hop counterparty rule (MIP-3A 6.6) routes account-to-account
payments through user-held Zswap coins, but under C4's exclusive
custody those are transient in-flight value the client sweeps into the
account, never a standing balance. The sync surface therefore shrinks
to incoming-payment detection during the in-flight window — via
protocol-level viewing keys and ledger-ciphertext trial decryption.
The hosted-indexer privacy trade-off still lives exactly there: hand
the Zswap viewing key to a provider for payment notification, or
trial-decrypt client-side?

**Indexer protocol shape.** gRPC, JSON-RPC, GraphQL? Different
ergonomics for SDKs and dApps.

**Multiple-indexer composition.** If the user wants two indexers
(redundancy), does the wallet aggregate, or pick one?

**Viewing-capability granularity.** The account viewing capability is
deliberately coarse — whole inbox, past and future until rotation
(MIP-3A R9): no date-range, colour, or subset scoping. Finer-grained
viewing (epoch-scoped keys, incoming/outgoing split) is a deferred
successor standard; does any v1.0 delegation use case force it sooner?

## Failure modes

**Indexer learns too much.** A malicious indexer correlates queries to
identify the user — for account assets it sees only which contract
addresses are queried (activity metadata); for user-held coin sync
with a delegated Zswap viewing key it sees holdings. *Detection:*
privacy review of indexer query patterns.

**Indexer goes down.** User can't see balances or grant state.
*Detection:* fallback indexer not configured; user is stuck. The inbox
walk's block-scan fallback keeps account assets recoverable without
any indexer, at a cost.

**Sync drift.** Indexer is behind chain state; wallet UI shows stale
balances. *Detection:* timestamp comparison between indexer and chain.

**Viewing-capability leak.** The account encryption secret discloses
the account's entire shielded past and future until rotation — but
never spend authority (MIP-3A S2). *Detection / response:*
`rotate_enc_key` plus re-encryption; old entries remain readable to
the holder.

## Alternatives

**A — Hosted indexer (single provider).** Simplest; the privacy cost
now applies mainly to user-held coin sync — account assets need no
view-key handover.

**B — Multiple-provider directory.** Substitutable per P8.

**C — Client-only light-client sync.** Strongest privacy, most
resource-intensive; for account assets the inbox walk already gives a
bounded client-side path needing only enumeration or a block scan.

**D — Hybrid (default to provider, fall back to client-only).**

The custody decision tilts the space: account assets get C-like
privacy at near-A cost by construction, so the live choice is about
user-held coin sync and the generic indexer surfaces (names, grants,
unshielded balances).
