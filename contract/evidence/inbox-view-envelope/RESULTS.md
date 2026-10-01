# Inbox viewing-key envelope — observed localnet results

**PASS.** Run started 2026-10-01T20:03:21.438Z; completed 2026-10-01T20:17:43.854Z.

**192 bytes per reader per viewing-key generation** (384 bytes for two readers; 1,920 for ten).
This fits a 32-byte account viewing secret and 64 bytes of public P-256 registration metadata.

## Envelope appends

| Observation | Payload B | Inbox-only serialization delta B | Whole-state delta B | Full transaction B | Contract proof B | Proving s | Modelled fee SPECKs |
|---|---:|---:|---:|---:|---:|---:|---:|
| envelope A / generation 0 | 192 | 522 | 553 | 10919 | 6364 | 22.629 | 490242082176916 |
| envelope B / generation 0 | 192 | 608 | -738 | 10958 | 6364 | 22.441 | 71971224132952 |
| envelope A / staged generation 1 | 192 | -709 | 723 | 10919 | 6364 | 21.972 | 678862757247673 |
| envelope B / staged generation 1 | 192 | 253 | 260 | 10919 | 6364 | 22.204 | 218088751182298 |
| envelope A only / generation 2 | 192 | 271 | 280 | 10951 | 6364 | 22.348 | 218278145685613 |

Each row is one P-256-authorised append. The inbox map is serialized in a constant blank ContractState frame.
Both inbox-only and whole-state snapshot deltas can be negative in these observations; they are not a stable per-record storage-allocation metric.
Whole-state deltas additionally include rolling authentication-state changes and storage-usage annotations. The fixed logical payload remains 192 bytes per record.
Serialization is not physical database allocation; the full transaction includes funding-wallet DUST overhead.
Proving includes local HTTP/key loading; these are single observations, not cold-cache or repeated benchmark means.
Fees use the indexed ledger parameters, not an independently measured amount burnt or a currency conversion.

## Other required calls

| Call | Full transaction B | Contract proof B | Contract proving s | Modelled fee SPECKs |
|---|---:|---:|---:|---:|
| enrol B | 10774 | 6364 | 22.367 | 381504827953274 |
| activate generation 1 | 10660 | 6364 | 26.675 | 216254105233682 |
| backfill live coin under generation 1 | 10903 | 6364 | 22.215 | 217994053930641 |
| B fresh restore / first shielded spend | 21076 | 6364 | 27.024 | 341059434794500 |
| B fresh restore / post-rotation shielded spend | 21079 | 6364 | 22.535 | 341236691583076 |
| activate generation 2 | 10696 | 6364 | 22.295 | 216467174049911 |

Shielded spends also generate Zswap proofs; their separate observations are retained in the JSON. This column times only the contract proof.
Enrolling B adds one device call and one envelope append. Rotating for N retained readers takes N appends plus one rotation call.
The pre-rotation live coin also needed one 192-byte encrypted-description backfill under the new viewing key.

## Restore outcomes

Account throughout: `b7b147dd6d9d9b7d56df0176c36aa7f022c69360e54a26344f8944f418ff4b14`.

- **B fresh restore / first shielded spend: PASS.** Empty private store, A signing disabled, public history scan, recovered B registration key, accepted spend `0077312a7d739f88cc221b61c6f35a717227c9b1c58cf73f4d7365433f08df808c`.
- **B fresh restore / post-rotation shielded spend: PASS.** Empty private store, A signing disabled, public history scan, recovered B registration key, accepted spend `00b901e168e21d3794ca38ac83cefb28f66fd97309a254ba9e4e47638a5d150793`.
- B could not decrypt the final fresh viewing generation after being excluded from its envelopes; A could.
- The account address and B signing credential persisted across both restores.

The suite uses software ES256 authenticators and synthetic PRF outputs. It exercises real node proofs and spends,
but fresh clients are isolated private-state providers in one process, sharing the public network/prover/fee payer.
Browser PRF support and cross-machine passkey synchronization require separate evidence.

Final inbox: 8 records, 5 viewing envelopes, 1536 total payload bytes.
Existing append prover artifact: 469855622 bytes (448.09 MiB). It is local proving infrastructure, not per-reader chain storage.

## Reproduction and boundaries

See [experiment guide](../../../experiments/inbox-view-envelope/README.md) for the wire layout, required bootstrap inputs,
trusted recipient-roster assumption, historical-epoch limits and commands.
Recovery: Default test deployment has no usable recovery wrap. Rotation/recovery continuity is NOT tested or claimed.

Environment: aarch64 8 CPUs 25159827456 memoryBytes; base commit `579da739eaee1a319073128b92c43799923d94d8`.
Ledger-parameter SHA-256: `20449040e86df9286e4df7b273cde5ecf207fcc09a0f67f6ded1ef00dcea93cb`.
The 52-circuit deployment used the existing 15,000-verifier-byte wave budget.
Sources: [offline](offline.json), [localnet snapshot](published-localnet.json), [source/artifact hashes](provenance.json).
