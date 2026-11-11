# Chain-verified holdings reconstruction

Client implementation dated 2026/11/11, addressing the holdings reconstruction
portion of `CUST-03`. This guide distinguishes evidence of a coin from evidence
of a complete account balance. No contract migration is required.

`scanHoldings` reconstructs holdings from an account address, viewing keys, and
public chain data. It does not require a device, a signature, a funding wallet,
or submission of a trial spend. `CustodyAccount.recoverHoldings` adds retained
local and journal descriptions and can explicitly apply verified observations.
Both return **live**, **spent**, or **unknown** for each distinct coin, a pinned
block, coverage information, and a `verifiedSubtotal` for each asset.

## What establishes a verified holding

The concrete adapter targets the pinned v9 ledger and indexer API. It checks the
node genesis hash, selects an already indexed and finalised block, checks its
canonical hash, and reads both contract state and its commitment tree at that
exact block. Continued scans remain pinned to the same block.

1. Decrypt an inbox entry with a supplied viewing key, or accept a retained
   description as a candidate. Authentication alone does not establish a coin.
2. Derive its contract-owned commitment and locate candidate positions from
   matching shielded receive/mint events, or retained index hints.
3. Check the actual commitment witness through the trusted prover's `/check`
   endpoint. Merely constructing an input at an occupied index is insufficient.
4. Derive the exact contract-owned nullifier and read its finite history through
   the pinned block. Only clean protocol completion establishes absence. Validate
   each returned receipt and recheck the anchor before and after that stream.

A qualified commitment with an applied nullifier is **spent**. A qualified
commitment with a completed, empty nullifier history is **live at that block**.
Missing events, rejected witnesses, timeouts, truncated streams, malformed
responses, and budget exhaustion remain **unknown**, with no verified value.

The filtered contract commitment tree omits nullifiers, so it cannot establish
spentness on its own. The pinned indexer stores nullifiers from applied ledger
effects, including successful segments of partial transactions. Its block and
nullifier writes share one database transaction. An already indexed upper bound
is therefore required before treating stream completion as absence. These are
explicit trust assumptions about the configured node, indexer, and prover, not
cryptographic proof of indexer completeness.

Primary implementation basis: pinned indexer
[finite subscription](https://github.com/midnightntwrk/midnight-indexer/blob/b5e6c809/indexer-api/src/infra/api/v4/subscription/shielded_nullifier_transactions.rs),
[nullifier storage](https://github.com/midnightntwrk/midnight-indexer/blob/b5e6c809/indexer-api/src/infra/storage/shielded_nullifiers.rs),
[applied ledger events](https://github.com/midnightntwrk/midnight-indexer/blob/b5e6c809/indexer-common/src/domain/ledger/ledger_state.rs),
and [transactional indexing](https://github.com/midnightntwrk/midnight-indexer/blob/b5e6c809/chain-indexer/src/infra/storage.rs).

## Read-only scan

```ts
import { createSdkChainRecoveryAdapter, scanHoldings } from './src/index.js';

const adapter = createSdkChainRecoveryAdapter({
  networkId: expectedGenesisHash, // 32-byte hexadecimal genesis hash
  nodeUrl, indexerUrl, indexerWsUrl, proofServerUrl, zkConfigProvider,
});
const report = await scanHoldings(adapter, {
  networkId: expectedGenesisHash, address,
  viewingKeys: [currentViewingSecret],
  maxEntries: 256, maxCandidates: 256, maxCoinIndices: 256,
});
```

Use the canonical lowercase, unprefixed hexadecimal address and genesis hash.
The adapter validates the genesis against the configured node; a network nickname
such as `local` is not sufficient. HTTP and WebSocket endpoints are explicit.
The prover receives private coin witnesses. Use a trusted prover, and protect
transport and endpoint credentials as appropriate. Exact commitment and nullifier
queries also reveal search interests to the indexer. This is not an anonymous
query protocol.

Reports contain private coin descriptions. Keep them with the encrypted wallet
profile, not in public logs, telemetry, issue attachments, or audit reports.
Serialisation must preserve bigint values and byte arrays; ordinary JSON alone
does not round-trip the whole report. Cursor fields themselves are JSON-safe.

## Bounded scans and continuation

Inbox, candidate, and commitment limits default to 256 and accept 1 through
4096. The adapter limits output-event retrieval to eight pages of 100 by default;
`maxEventPages` adjusts that window. Timeouts are explicit adapter options.

`report.cursor` continues the inbox. Each unknown holding may also have a
`searchCursor`, containing its coin identity, snapshot, event-window offset,
and next commitment position. Supply both forms of continuation when present:

```ts
const next = await scanHoldings(adapter, {
  networkId: expectedGenesisHash, address,
  viewingKeys: [currentViewingSecret],
  ...(report.cursor ? { cursor: report.cursor } : {}),
  candidates: report.holdings.filter(h => h.searchCursor).map(h => ({
    coin: h.coin, searchCursor: h.searchCursor,
  })),
});
```

All cursors in one call must refer to the same network, account, and block. A
new event window resets the position because event order need not match
commitment order. A position pause stays within its current event window.
Corrupt, conflicting, or out-of-scope cursors are rejected. Retry unavailable
evidence without inventing progress. Retain prior reports if presenting a
multi-page result, deduplicate by coin identity, and keep their snapshot scope.
Do not add subtotals from overlapping pages.

`coverage.complete` describes a single full pass over that pinned inbox and its
candidate set, with the current viewing key, no unreadable or missing entries,
and no unknown candidates. A final resumed page remains incomplete. It never
proves that all account-owned coins were described in the inbox. Historical
viewing keys may be supplied alongside the current key, up to 32 keys per call.
Unreadable old entries remain visible as a coverage gap.

## Applying observations to an account

```ts
const report = await account.recoverHoldings(adapter, {
  networkId: expectedGenesisHash,
  viewingKeys: [currentViewingSecret],
  apply: true, // default false
});
```

Application merges exact verified live identities, records verified spent
tombstones, and preserves unrelated same-colour holdings. Unknown retained
inventory is not deleted and does not contribute to `verifiedSubtotal`. A local
spent marker wins over an older live observation; the report records that
conflict and excludes its value. The provider-wide guard protects same-process
account operations. Use the existing single-writer profile; other processes
and direct provider mutations are outside that guard.

Existing `heldCoin` and `coinStore` accessors still include retained unknown
inventory. Use the recovery report's verified observations when presenting
verified holdings.

Recovery does **not** change uncertain or partial journal transaction stages.
An input being spent, even with an expected change commitment present, does not
prove which intended operation succeeded. Unresolved durable reservations stay
quarantined. Repairing partial execution needs separate transaction-level evidence.

## Remaining boundaries

- Owner change lost before inbox backfill, with its local description and journal
  also lost, is not recoverable from a commitment alone. The durable journal
  remains necessary for that gap.
- This API consumes viewing keys; it does not restore them, validate a recovery
  wrap, or repair a stale wrap after rotation. Those are the next recovery work.
- A live classification is a snapshot observation. Another client can spend the
  coin later. Refresh before use, and still handle on-chain rejection.
- A custom `ChainRecoveryAdapter` is trusted to honour the evidence contract.
  The core cannot turn fabricated adapter observations into independent proof.
- This is targeted custody reconstruction, not complete MIP conformance or
  general transaction-outcome reconciliation.

## Validation

`npm run test:chain-recovery` covers core reconstruction, account application,
real native-ledger negative controls, and controlled HTTP/WebSocket failures.
SDK transport fixtures mock prover responses and do not claim live proofs.
The separate localnet journey in `src/tests/chain-recovery-localnet.ts` exercises
real proof checks and fresh-process reconstruction. Its run results are recorded
in the remediation queue after execution.
