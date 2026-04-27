# Contract Custody Feasibility — Experiment

This experiment empirically determines whether a Compact smart contract on
Midnight v1 can act as a custody address for shielded (Zswap), unshielded
(Night), and Dust assets, and whether a contract can pay the Dust fees of
a transaction.

It is a strict feasibility check — every result is backed by a reproducible
transaction hash or a specific node error code, no theoretical analysis.

## Quick start

```bash
./run-all.sh                  # full sweep: u1..u4, s1..s4, d1..d2
./run-all.sh --fresh          # reset chain state first
./run-all.sh --tests=u1,u2    # subset
```

The script handles prerequisite checks, dependency installation, contract
compilation, devnet startup, deployment, sequential test execution, and
mechanical regeneration of the results table in `FINDINGS.md`.

## Where to start reading

| File                        | Purpose                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `EXPERIMENT_GUIDELINE.md`   | The brief — goal, in-scope tests, deliverables, acceptance criteria          |
| `FINDINGS.md`               | The spike report — populated by `./run-all.sh`. Verdict lives here           |
| `contracts/custody.compact` | Single test contract; one circuit per brief test case                       |
| `src/tests/`                | One TypeScript runner per test case. Each writes `evidence/<id>-<name>.json` |
| `src/compose-findings.ts`   | Regenerates the FINDINGS.md results table from `evidence/`                   |
| `evidence/`                 | Per-test JSON: request, response, tx hash or error code, node-side notes    |

## Prerequisites

- Docker (for the local Midnight devnet)
- Node.js >= 22
- `compact` compiler on PATH (matching the runtime version pinned in
  `package.json`)
- `openssl` (for one-time `infra/.env` generation)

> No Rust signer required — this experiment does not use Schnorr or any
> off-chain signing.

## Test layout

| ID  | Spike              | Maps to brief test                                          |
| --- | ------------------ | ----------------------------------------------------------- |
| U1  | unshielded-night   | `receiveUnshielded` — user → contract                       |
| U2  | unshielded-night   | `sendUnshielded` → ContractAddress (was error 186)          |
| U3  | unshielded-night   | `sendUnshielded` → UserAddress (regression check)           |
| U4  | unshielded-night   | end-to-end round trip                                       |
| S1  | shielded-zswap     | `mintShieldedToken` to `kernel.self()`                      |
| S2  | shielded-zswap     | atomic mint+send shielded                                   |
| S3  | shielded-zswap     | cross-transaction shielded custody (Merkle-rehash)          |
| S4  | shielded-zswap     | `receiveShielded` user → contract (**net-new, the dealbreaker**) |
| D1  | contract-dust      | contract holds Dust + self-pays its tx fee                  |
| D2  | contract-dust      | contract acts as paymaster for user transaction             |

## Adding a tx to a flaky test

Tests are intentionally idempotent: each connects to the deployed contract
(`deployment.json`, plus `deployment-second.json` for U2/U4) and submits
its own circuit call. Run them individually with `npm run test:u1`,
`npm run test:s4`, etc. Each writes `evidence/<id>-<name>.json` whether it
succeeds or fails.

## After the experiment

1. The verdict block in `FINDINGS.md` summarises feasibility for each asset
   type.
2. The "Implications for the Passport account model" section feeds back
   into [`RESEARCH.md`](../../RESEARCH.md).
3. Spike-level summaries land in `.planning/spikes/MANIFEST.md`.
