# Experiment Brief — Contract-to-Contract Direct Shielded Transfer

**Date opened:** 2026/07/16
**Component:** C4 (asset custody model); consequences for MIP-0012 section 6.6.
**Base:** `experiments/stateless-shielded-custody` (contract shapes, harness, infra).

## Question

Can custody contract A pay custody contract B **directly**: A's send circuit
emits a shielded output whose recipient is B's contract address, and B's
deposit circuit claims it (`receiveShielded`) in the **same client-composed
transaction**, on the current stack, with no Compact cross-contract calls?

## Why now

The C4 canvas records shielded contract ↔ contract as **untested**, plausibly
blocked by the same-tx pairing requirement (the SDK gap that blocked Night U2
in `contract-custody-feasibility`). MIP-0012 section 6.6 forbids the direct
payment and mandates one-hop user-key routing, on two independent legs:

1. **Technical**: an output addressed to a foreign contract must be claimed
   by that contract in the same transaction; never validated by us.
2. **Privacy**: the direct transaction names both contract addresses,
   publishing the counterparty pair (INV-6 exists to prevent this).

**Decision on record (2026/07/16): the linking of the two accounts is
ACCEPTED for this experiment.** The probe therefore isolates the technical
leg, and measures (rather than avoids) the privacy cost.

## Design under test

Both parties are instances of one stateless-custody contract (no public
QSCI; encrypted inbox; witness-supplied spends), extended with:

- `spend_to_contract(target, color, amount)` — `sendShielded` to a
  `ContractAddress` recipient; returns `[sent, change]`. The `sent` coin's
  nonce is the deterministic `nonce_evolve` of the input coin's nonce, so
  the composing client knows B's claim argument before proving.

The composed transaction pairs `A.spend_to_contract` with
`B.deposit_stateless(sent, blob)` via the midnight-js public pipeline:
`createUnprovenCallTx` twice → `UnprovenTransaction.merge` →
`submitTx({ unprovenTx, circuitId: [both] })`.

## Probes

| ID | Question | Success criterion |
|----|----------|-------------------|
| P1 | Do the composition surfaces exist (build-without-submit + merge)? Control: what does the UN-composed direct send do? | Surfaces inventoried; control outcome recorded verbatim (expected: rejection). |
| P2 | Does the node accept the composed two-call direct transfer? | Node accept; `B.inbox_count = 1`; `A.round = 2`. **The headline.** |
| P3 | What does an observer see, and can B spend the received coin? | Both addresses visible together (accepted, measured); value/color/nonce hidden; B's onward spend accepted cross-tx. |

## Interpretation grid

- **P2 PASS** ⇒ direct contract-to-contract payment is possible today by
  client-side composition. MIP-0012's 6.6 technical parenthetical ("rejected
  by the current ledger") is wrong for composed transactions and needs a
  re-word; the MUST becomes a privacy-only rule, and the user decides whether
  it relaxes to SHOULD with the linking documented (the C24-style
  sponsor-visible trade).
- **P2 blocked in SDK glue** (createUnprovenCallTx/merge/prove/balance) ⇒
  same-tx pairing remains an SDK gap; record the exact missing surface as
  the upstream ask; the protocol question stays open.
- **P2 rejected by the node** ⇒ the technical leg is a ledger wall after
  all; 6.6 stands as written on both legs; record the error code as the
  evidence MIP-0012 currently lacks.

## Constraints

- Local devnet only (`midnight-node:1.0.0`, `indexer-standalone:4.3.3`,
  `proof-server:8.1.0`), same pins as the base experiment.
- No authentication in the contract — device auth is proven elsewhere and
  would only add variables.
- Reproducibility: `./run-all.sh` end-to-end on a clean checkout; every
  probe writes `evidence/*.json`; `FINDINGS.md` regenerates from evidence.
