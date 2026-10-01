# Compact 0.35 upgrade verification

Checked on 2026-10-01, on an arm64 Mac. Node.js SDK pins are in
`package.json` and `package-lock.json`; the compiler is 0.35.0, runtime 0.20.0,
with `--feature-zkir-v3` (ZKIR 3.1). This is a ledger-9 localnet configuration.

## Standalone images

| Component | Exact image | Multi-arch manifest digest |
|---|---|---|
| Node | `midnightntwrk/midnight-node:2.1.0-rc.4` | `sha256:9040c346c27f569b72dfbbad9420cf38fc7cc6a13b38adf814a925bbe9311678` |
| Indexer | `ghcr.io/midnightntwrk/indexer-standalone:4.4.0-rc.6-b5e6c809` | `sha256:ecfec6a26b9f8f89b7531e8f7c390f841661fb079bdf0bc57fa2cf8bb3f99c2f` |
| Proof server | `midnightntwrk/proof-server:9.0.0-rc.8` | `sha256:2666c7bd7b4517f8ad135565387f98d14347a9ac715c6c466d4a8a852b545ecf` |

The node and proof server are the latest published releases on this ledger
line. Proof-server 10.0.0-alpha.1 belongs to the ledger-10 line. The indexer is
the newest published rc.6 standalone candidate found in GHCR, built from
`b5e6c8097ffbd9e18959907c0c353122cfd7e74e` on 29 September. All three manifest
lists include amd64 and arm64; the run below uses arm64.

Sources:
- [Node release](https://github.com/midnightntwrk/midnight-node/releases/tag/node-2.1.0-rc.4)
- [Proof-server release](https://github.com/midnightntwrk/midnight-ledger/releases/tag/proof-server-9.0.0-rc.8)
- [Indexer candidate source](https://github.com/midnightntwrk/midnight-indexer/commit/b5e6c8097ffbd9e18959907c0c353122cfd7e74e)
- [Indexer rc.6 release tracking](https://github.com/midnightntwrk/midnight-indexer/issues/1499)

### Why the indexer uses a commit-pinned candidate

The latest numbered indexer release is 4.4.0-rc.5. On this fresh rc.4 node it
exits while indexing genesis with `cannot get online client at block 0x0000…0000`.
Restarting after finality advances reproduces it. This matches
[upstream #1516](https://github.com/midnightntwrk/midnight-indexer/issues/1516):
rc.5's generated runtime metadata predates the node's changes, and its fallback
tries to query genesis's nonexistent parent. The rc.6 candidate contains the
metadata update and successfully indexes the new chain. It is a published
candidate image, not a completed rc.6 release.

## Localnet run

The verification project is `account-custody-compact035`, using newly created
node/indexer volumes. Indexer storage predating rc.5 requires re-indexing.

```sh
printf 'APP__INFRA__SECRET=%s\n' "$(openssl rand -hex 32)" > infra/.env
docker compose -p account-custody-compact035 \
  -f infra/docker-compose.yml -f infra/docker-compose.macos.yml \
  up -d --pull always --wait

export WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001
export EVIDENCE_DIR=evidence/compact-0.35
export MIDNIGHT_NODE_CONTAINER=account-custody-compact035-node-1
export MIDNIGHT_PROOF_CONTAINER=account-custody-compact035-proof-server-1
npm run test:auth-coinless
```

Runtime checks: node `system_version` reports `2.1.0-1b2b31c7`, runtime
`specVersion=2001000`, `transactionVersion=4`; indexer binary reports
`4.4.0-rc.6 (2026-09-29)`; proof server `/version` reports `9.0.0-rc.8`.
Indexer GraphQL served finalized block 33 with `protocolVersion=2001000`.

## Verification results

- Full key generation: account 36, control 2, faucet 4, block-time probe 3 circuits.
- TypeScript, unit, grants-offline (121/121), recovery-offline, recovery-sim,
  Rust cross-implementation, and SDK/artifact smoke checks pass.
- `test:auth-coinless`: **PASS** on the fresh localnet. Faucet deployment,
  two complete account deployments, proofs for both k256 and JubJub, cross-arm
  enrolment in both directions, and maintenance-authority retirement passed.
  The live-authority control accepted the verifier-key swap; the retired
  account's identical swap was rejected at submission (node error 134).
  [Run evidence](evidence/compact-0.35/auth-coinless-arms-auth-coinless.json).
- Independently read node events at blocks **102**, **106**, **141**, **145**:
  the k256 call, JubJub call, live-authority swap, and reverse enrolment each
  have `midnight.TxApplied` with the corresponding indexer transaction hash
  and `system.ExtrinsicSuccess`.
- Tampered signatures, weak-key forgeries and self-removal aborted during
  local transaction building. These are negative build tests, not submitted
  invalid-proof tests or a completed public-key admissibility map.
- Updated the coin-position query to the indexer's `zswapStartIndex` and
  `zswapEndIndex` fields; checked the aliased query against the live indexer.
  The full custody, grants and recovery on-node suites have not been rerun
  on this stack; their older evidence retains its original attribution.

### Deployment budget adjustment

The previous 25,434-verifier-byte account deployment was refused by node
rc.4 with `ExhaustsResources`. The planner now applies a **15,000-byte**
budget to both deploy and maintenance waves. The current 36-operation roster
plans as seven waves for either initial arm; both accounts in the successful
run used the k256-first roster. This is a working packing budget, not a new
measurement of the node's exact ceiling. The older wave-ceiling experiment
and cost tables remain historical.

Historical evidence in the parent `evidence/` directory retains its original
stack attribution. `EVIDENCE_DIR` selects a separate output directory for this run.
