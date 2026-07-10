# Stateless Shielded Custody

Can a Compact contract custody shielded coins **without** publishing their
`QualifiedShieldedCoinInfo` in public ledger state — removing the "QSCI
publicity" leak that the `insertCoin` pattern carries? This experiment
settles the retracted S5 claim from `contract-custody-feasibility` on the
current stack, and byte-audits what an observer actually sees.

See [`EXPERIMENT_GUIDELINE.md`](EXPERIMENT_GUIDELINE.md) for the brief and
[`FINDINGS.md`](FINDINGS.md) for results.

## Design under test

- **Deposit**: `receiveShielded` + an opaque encrypted blob in an on-ledger
  inbox (coin info encrypted to the account's advertised key). No
  `insertCoin`.
- **Spend**: the QSCI enters the circuit as a **witness** from wallet-local
  storage; `sendShielded` itself routes any change back to the contract as a
  self-owned output, which the circuit returns through the private call
  result (no re-owning step; upstream removed the redundant re-send in
  OpenZeppelin/compact-contracts#661).
- **Control**: the same contract carries the S6/OZ `insertCoin` pattern for
  the leak-audit baseline.

## Probes

| ID | Question |
|----|----------|
| W1 | What does the compiler force to be disclosed? (hashes only, or raw coin fields?) |
| W2 | Does a stateless deposit land, with no QSCI in public state and a decryptable inbox? |
| W3 | Does the **node** accept a witness-QSCI spend? (the settle-it) Plus the change chain. |
| W4 | Fallback if W3 crashes in SDK glue: manual offer via `ZswapInput.newContractOwned`. |
| W5 | Third-party deposit + owner discovery from chain data only. |
| W6 | Byte-scan observer surfaces: stateless vs insertCoin control. |

## Run

```sh
./run-all.sh            # compile, devnet up, all probes (w4 excluded by default)
./run-all.sh --fresh    # reset chain state first
./run-all.sh --tests w3 # a subset
```

Prerequisites: Docker, Node 22+, `compact` toolchain on PATH.
Evidence lands in `evidence/`; the FINDINGS results table regenerates after
every run.

## Layout

- `contracts/stateless.compact` — the experiment contract (stateless +
  control paths); `contracts/probes/` — the W1 disclosure variants.
- `src/wallet/` — coin store (witness source), blob crypto, custody client.
- `src/tests/` — one runner per probe.
- `infra/` — local devnet (node 1.0.0, indexer 4.3.3, proof server 8.1.0).
