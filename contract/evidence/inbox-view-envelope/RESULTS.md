# Inbox viewing-key envelope: observed localnet results

**PASS.** Run started 2026-10-17T13:25:57.375Z; completed 2026-10-17T13:40:14.746Z.

**192 bytes per reader per viewing-key generation** (384 bytes for two readers; 1,920 for ten).
This fits a 32-byte account viewing secret and 64 bytes of public P-256 registration metadata.

## Envelope appends

| Observation | Payload B | Inbox-only serialisation delta B | Whole-state delta B | Full transaction B | Contract proof B | Proving s | Modelled fee SPECKs |
|---|---:|---:|---:|---:|---:|---:|---:|
| envelope A / generation 0 | 192 | 522 | 553 | 10919 | 6364 | 26.872 | 490578971428572 |
| envelope B / generation 0 | 192 | 608 | -738 | 10950 | 6364 | 22.012 | 69745828571429 |
| envelope A / staged generation 1 | 192 | -709 | 723 | 10920 | 6364 | 21.874 | 680336000000001 |
| envelope B / staged generation 1 | 192 | 253 | 260 | 10920 | 6364 | 21.817 | 216800000000001 |
| envelope A only / generation 2 | 192 | 271 | 267 | 10950 | 6364 | 22.294 | 210121142857143 |

Each row is one P-256-authorised append. The inbox map is serialised in a constant blank ContractState frame.
Both inbox-only and whole-state snapshot deltas can be negative in these observations; they are not a stable per-record storage-allocation metric.
Whole-state deltas additionally include rolling authentication-state changes and storage-usage annotations. The fixed logical payload remains 192 bytes per record.
Serialisation is not physical database allocation; the full transaction includes funding-wallet DUST overhead.
Proving includes local HTTP/key loading; these are single observations, not cold-cache or repeated benchmark means.
Fees use the indexed ledger parameters, not an independently measured amount burnt or a currency conversion.

## Other required calls

| Call | Full transaction B | Contract proof B | Contract proving s | Modelled fee SPECKs |
|---|---:|---:|---:|---:|
| enrol B | 10774 | 6364 | 26.122 | 381224685714286 |
| activate generation 1 | 10659 | 6364 | 27.929 | 215005028571429 |
| backfill live coin under generation 1 | 10903 | 6364 | 22.123 | 216702857142858 |
| B fresh restore / first shielded spend | 21079 | 6364 | 26.650 | 338083885714286 |
| B fresh restore / post-rotation shielded spend | 21079 | 6364 | 22.411 | 344644342857143 |
| activate generation 2 | 10697 | 6364 | 22.067 | 215222171428572 |

Shielded spends also generate Zswap proofs; their separate observations are retained in the JSON. This column times only the contract proof.
Enrolling B adds one device call and one envelope append. Rotating for N retained readers takes N appends plus one rotation call.
The pre-rotation live coin also needed one 192-byte encrypted-description backfill under the new viewing key.

## Restore outcomes

Account throughout: `3473332587e305c0eeadcd42c7b60a8893cfb2a1c0a5493786ea1438622078f1`.

- **B fresh restore / first shielded spend: PASS.** Empty private store, A signing disabled, public history scan, recovered B registration key, accepted spend `003df3e3157c6b13f7107cd1bac88db3fc73531ddef8865a1755c5c87157f254f3`.
- **B fresh restore / post-rotation shielded spend: PASS.** Empty private store, A signing disabled, public history scan, recovered B registration key, accepted spend `00e218c9dc46da77e23fa1277c42fcc8492e2896a2e7c57f108ff4ed7dec0c8bc9`.
- B could not decrypt the final fresh viewing generation after being excluded from its envelopes; A could.
- The account address and B signing credential persisted across both restores.

Candidate retry was not exercised: every restore accepted its first candidate.

The suite uses software ES256 authenticators and synthetic PRF outputs. It exercises real node proofs and spends,
but fresh clients are isolated private-state providers in one process, sharing the public network, prover, and fee payer.
Browser PRF support and cross-machine passkey synchronisation require separate evidence.

Final inbox: 8 records (1536 payload bytes), of which 5 are viewing envelopes (960 bytes).
Existing append prover artefact: 469855622 bytes (448.09 MiB). It is local proving infrastructure, not per-reader chain storage.

## Reproduction and boundaries

See [experiment guide](../../../experiments/inbox-view-envelope/README.md) for the wire layout, required bootstrap inputs,
trusted recipient-roster assumption, historical-epoch limits, and commands.
Recovery: Default test deployment has no usable recovery wrap. Rotation/recovery continuity is NOT tested or claimed.

Environment: aarch64 8 CPUs 25159827456 memoryBytes; source commit `2d5e7f0b7f6229806df1848dc1d91904ca26da78`, working tree dirty: no; merge-base with main `0d7bb0bc834f2d45d9fe2d84c4d022a30d648423`.
Ledger-parameter SHA-256: `27eb882109310560df1a1bed6109a85999ae27cf7453c234163a178abad850d5`.
The 52-circuit deployment used a 15,000-verifier-byte wave budget.
Sources: [offline](offline.json), [localnet snapshot](published-localnet.json), [source and artefact hashes](provenance.json).
