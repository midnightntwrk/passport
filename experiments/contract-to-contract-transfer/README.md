# Contract-to-Contract Direct Shielded Transfer

Can custody contract A pay custody contract B **directly** — one
client-composed transaction pairing A's shielded send (recipient = B's
contract address) with B's `receiveShielded` claim — on the current stack,
without Compact cross-contract calls?

The C4 canvas records this as untested; MIP-0012 section 6.6 forbids it and
mandates one-hop routing, partly for privacy (the transaction links both
contract addresses). **This experiment accepts the linking by explicit
decision** and isolates the technical question. See
[`EXPERIMENT_GUIDELINE.md`](EXPERIMENT_GUIDELINE.md) for the brief and
[`FINDINGS.md`](FINDINGS.md) for results.

## Probes

| ID | Question |
|----|----------|
| P1 | Do the composition surfaces exist? Control: the un-composed direct send's exact failure. |
| P2 | Does the node accept the composed two-call direct transfer? (headline) |
| P3 | Observer surfaces (linking measured; value/color hidden?) + B spends the received coin. |

## Run

```sh
./run-all.sh              # compile, devnet up, P1 → P2 → P3
./run-all.sh --fresh      # reset chain state first
./run-all.sh --tests p2   # a subset
```

Prerequisites: Docker, Node.js >= 22, `compact` on PATH, openssl. Probes are
sequential: P3 consumes `evidence/p2-context.json` written by a passing P2.

## Layout

- `contracts/c2c.compact` — stateless custody (inbox + witness spends) plus
  `spend_to_contract` (sends to a `ContractAddress`, returns `[sent, change]`).
- `src/tests/p1..p3` — the probes; every stage writes `evidence/*.json`.
- Base plumbing (wallet, providers, coin store, faucet) inherited from
  `experiments/stateless-shielded-custody`.
