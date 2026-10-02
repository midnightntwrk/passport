# Inbox viewing-key envelope: observed localnet results

**PASS.** Run started 2026-10-02T08:35:19.075Z; completed 2026-10-02T08:49:26.917Z.

**192 bytes per reader per viewing-key generation** (384 bytes for two readers; 1,920 for ten).
This fits a 32-byte account viewing secret and 64 bytes of public P-256 registration metadata.

## Envelope appends

| Observation | Payload B | Inbox-only serialisation delta B | Whole-state delta B | Full transaction B | Contract proof B | Proving s | Modelled fee SPECKs |
|---|---:|---:|---:|---:|---:|---:|---:|
| envelope A / generation 0 | 192 | 522 | 553 | 10920 | 6364 | 27.638 | 298414577059274 |
| envelope B / generation 0 | 192 | 608 | -738 | 10951 | 6364 | 22.246 | 112879841885797 |
| envelope A / staged generation 1 | 192 | -709 | 736 | 10919 | 6364 | 22.060 | 385193472093425 |
| envelope B / staged generation 1 | 192 | 253 | 247 | 10919 | 6364 | 22.659 | 174523688999128 |
| envelope A only / generation 2 | 192 | 271 | 280 | 10951 | 6364 | 21.987 | 177869705257558 |

Each row is one P-256-authorised append. The inbox map is serialised in a constant blank ContractState frame.
Both inbox-only and whole-state snapshot deltas can be negative in these observations; they are not a stable per-record storage-allocation metric.
Whole-state deltas additionally include rolling authentication-state changes and storage-usage annotations. The fixed logical payload remains 192 bytes per record.
Serialisation is not physical database allocation; the full transaction includes funding-wallet DUST overhead.
Proving includes local HTTP/key loading; these are single observations, not cold-cache or repeated benchmark means.
Fees use the indexed ledger parameters, not an independently measured amount burnt or a currency conversion.

## Other required calls

| Call | Full transaction B | Contract proof B | Contract proving s | Modelled fee SPECKs |
|---|---:|---:|---:|---:|
| enrol B | 10773 | 6364 | 26.370 | 249028413826116 |
| activate generation 1 | 10660 | 6364 | 26.290 | 174806692353630 |
| backfill live coin under generation 1 | 10903 | 6364 | 22.038 | 177386567963892 |
| B fresh restore / first shielded spend | 21079 | 6364 | 26.815 | 307724406452219 |
| B fresh restore / post-rotation shielded spend | 21077 | 6364 | 22.159 | 307775106400985 |
| activate generation 2 | 10660 | 6364 | 22.156 | 174806692353630 |

Shielded spends also generate Zswap proofs; their separate observations are retained in the JSON. This column times only the contract proof.
Enrolling B adds one device call and one envelope append. Rotating for N retained readers takes N appends plus one rotation call.
The pre-rotation live coin also needed one 192-byte encrypted-description backfill under the new viewing key.

## Restore outcomes

Account throughout: `5ff5e36e027f0cb636beab22a01ec6e5dbecedd11f32e79dd75e178bdc8b006f`.

- **B fresh restore / first shielded spend: PASS.** Empty private store, A signing disabled, public history scan, recovered B registration key, accepted spend `003ac04221fc16b17f9e0353d3456d3972f189b9b211eeeb9752c3c02299e09d1c`.
- **B fresh restore / post-rotation shielded spend: PASS.** Empty private store, A signing disabled, public history scan, recovered B registration key, accepted spend `000fa930abac7ec731ea0f9c285209c8f8985a60b9a7f7bf706d4a1fa869965d31`.
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

Environment: aarch64 8 CPUs 25159827456 memoryBytes; source commit `dca9581ad2a1f30c5e7cab526420ad701bd14e56`, working tree dirty: no; merge-base with the P-256 branch `579da739eaee1a319073128b92c43799923d94d8`.
Ledger-parameter SHA-256: `d7d5f27e5dba936f21c14a8a8a1d5128c65f17fd09b2958c5b3c3593a94cd708`.
The 52-circuit deployment used a 15,000-verifier-byte wave budget.
Sources: [offline](offline.json), [localnet snapshot](published-localnet.json), [source and artefact hashes](provenance.json).
