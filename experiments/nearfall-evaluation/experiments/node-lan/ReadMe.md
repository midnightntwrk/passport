# 👱🤖 Midnight Node LAN — 7-Node Local Validator Network

A self-contained seven-node Midnight validator network running AURA block
production, GRANDPA finality, and BEEFY bridge finality — all on localhost, with
no Cardano dependency (main-chain follower is mocked via `CFG_PRESET=dev`).

## Purpose

Baseline for observing Midnight consensus behaviour in isolation: block
production rates, GRANDPA finalization, and BEEFY justification propagation,
without the latency and availability constraints of a public network or a live
cardano-db-sync instance.

## Prerequisites

- Podman with `podman kube play` support
- The `midnight-node` binary (built from source) for key and chain-spec
  generation — see the Makefile
- All seven `node-N/` directories populated with key material (see
  [Key generation](#key-generation) below)
- Data directories created and world-writable:

```bash
mkdir -p node-1/state
mkdir -p node-{2..7}
mkdir -p index
chmod -R 777 node-{1..7} index
```

## Key generation

The `Makefile` drives all key material creation via `midnight-node key generate`.
From this directory:

```bash
# Generate node keys, AURA/GRANDPA/BEEFY keys, and chain-spec for all 7 nodes
make authorities.json initialAuthorities.json chain-spec-raw.json
```

Intermediate targets of interest:

| Target | Description |
|--------|-------------|
| `node-N/key` | libp2p node key (determines peer ID) |
| `node-N/identity` | peer ID string (derived from `node-N/key`) |
| `node-N/aura.seed` | AURA secret seed (Sr25519) |
| `node-N/grandpa.seed` | GRANDPA secret seed (Ed25519) |
| `node-N/beefy.seed` | BEEFY secret seed (Ecdsa) |
| `node-N/beefy.keygen` | Full BEEFY key output including public key (hex) |
| `chain-spec-raw.json` | Raw chain-spec encoding all validator keys |

## Running

```bash
podman kube play --replace=true --start=true midnight-lan.yaml   # start
podman kube down midnight-lan.yaml                               # stop
podman pod logs --follow midnight-lan                            # all logs
podman pod logs --follow --container node-1 midnight-lan         # single node
```

## Network layout

| Container | Role | RPC port | P2P port |
|-----------|------|----------|----------|
| `node-1` | Validator, bootnode | 9945 | 30334 |
| `node-2` | Validator | 9946 | 30335 |
| `node-3` | Validator | 9947 | 30336 |
| `node-4` | Validator | 9948 | 30337 |
| `node-5` | Validator | 9949 | 30338 |
| `node-6` | Validator | 9950 | 30339 |
| `node-7` | Validator | 9951 | 30340 |
| `indexer` | Indexer (connected to node-1) | 8088 | — |
| `proofserver` | ZK proof server | 6300 | — |
| `beefy-inserter` | One-shot key inserter (exits after completion) | — | — |

Nodes 2–7 connect to node-1 as their explicit bootnode. All containers share the
pod's network namespace (localhost).

## BEEFY key insertion

BEEFY keys cannot be passed as static environment variables — they must be
inserted into each node's keystore at runtime via the `author_insertKey` RPC
method (cf. `run-node.sh`). The `beefy-inserter` container handles this
automatically:

1. For each of the 7 nodes in parallel, it polls `system_health` until the RPC
   is up, then waits 10 s for the BEEFY pallet to initialise.
2. It reads the secret seed and public key from `node-N/beefy.keygen` and calls
   `author_insertKey` with key type `beef`.
3. It exits cleanly once all 7 insertions succeed. The inserted keys are
   persisted in each node's on-disk keystore; subsequent pod restarts do not
   require re-insertion.

## Volume layout

| Volume | Host path | Container path | Used by |
|--------|-----------|----------------|---------|
| `chain-spec` | `./chain-spec-raw.json` | `/chain-spec-raw.json` | all nodes |
| `data-node-1` | `./node-1/state` | `/data` | `node-1` |
| `data-node-N` (N=2–7) | `./node-N` | `/data` | `node-N` |
| `keys-node-N` | `./node-N` | `/keys` (nodes), `/keys/N` (inserter) | `node-N`, `beefy-inserter` |
| `data-index` | `./index` | `/data` | `indexer` |

## Alternative: running nodes directly via Make

Before the Podman pod setup, nodes were started directly on the host using the
Makefile and `run-node.sh`:

```bash
make node-1.log &
make node-2.log &
# … repeat for nodes 3–7
```

Each `node-N.log` target invokes `run-node.sh N`, which starts the node, waits
for its RPC port to become available, and then inserts the BEEFY key via
`author_insertKey`. Logs are written to `node-N.log` (and archived to
`node-N.log.gz`).

```bash
make clear-logs    # remove node-N.log files
make clear-state   # wipe node-N/state/
```

## Monitoring

```bash
# Check sync and peer counts across all nodes
./check-sync.sh

# Peer counts only
make count-peers

# Finalized heads (GRANDPA and BEEFY)
make get-finalized
```

## TPS experiment

The `experiments/mn-tui/` directory contains a standalone script (`src/night-tps.ts`)
for sending NIGHT token transfers and measuring submission TPS against this network.

### Prerequisites

Node.js ≥ 18, with dependencies already installed in `experiments/mn-tui/`:

```bash
cd experiments/mn-tui
npm install    # only needed once
```

The network must be running with the indexer and proof server reachable.

### Setup (fund wallets from genesis)

The genesis mint wallet (fixed seed `0x00…01`) holds all NIGHT in the genesis
block. Setup derives N test wallets, transfers NIGHT from genesis to each, and
registers each wallet for DUST generation (required before any transaction can
be submitted):

```bash
cd experiments/mn-tui
npm run tps -- setup \
  --node     http://localhost:9945 \
  --indexer  http://localhost:8088/api/v4/graphql \
  --prover   http://localhost:6300 \
  --wallets  1
```

Wallet mnemonics and addresses are saved to `night-tps-wallets.json`.

### Run (TPS burst)

Load the funded wallets and send a burst of 1 NIGHT transfers in a circular
pattern (wallet-1 → wallet-2 → … → wallet-N → wallet-1):

```bash
npm run tps -- run \
  --node     http://localhost:9945 \
  --indexer  http://localhost:8088/api/v4/graphql \
  --prover   http://localhost:6300 \
  --txs      1
```

### Example transcript

```
$ npm run tps -- setup --node http://localhost:9945 --indexer http://localhost:8088/api/v4/graphql --prover http://localhost:6300 --wallets 1 --txs 1

> mn-tui@0.1.0 tps
> tsx src/night-tps.ts setup --node http://localhost:9945 --indexer http://localhost:8088/api/v4/graphql --prover http://localhost:6300 --wallets 1 --txs 1

Network : undeployed
Node    : http://localhost:9945
Indexer : http://localhost:8088/api/v4/graphql
Prover  : http://localhost:6300

=== setup: funding 1 wallet(s) × 1000.000000 NIGHT on undeployed ===

Initialising genesis wallet (seed 00…01)…
Genesis address : mn_addr_undeployed1h3ssm5ru2t6eqy4g3she78zlxn96e36ms6pq996aduvmateh9p9sk96u7s
Waiting for genesis wallet sync…
Genesis NIGHT   : 5000000000.000000
Genesis DUST    : 12500000000000000000000000 (already registered)

Generating test wallet mnemonics…
  wallet-1: mn_addr_undeployed1sg80kt3ec9lk8al2knj59gx5rsc8u40dxj23lum8j5x6mgzv8zvqzdqzp2

Funding test wallets from genesis…
  Sending 1000.000000 → wallet-1…
  tx: 00b48eab898ac9bd78f899191732ab36f2d315e9476394afa90c10fdbe71e3ef39

Wallet store saved to ./night-tps-wallets.json

Registering test wallets for DUST…

wallet-1 (mn_addr_undeployed1sg80kt3ec9lk8al2knj59gx5rsc8u40dxj23lum8j5x6mgzv8zvqzdqzp2)
  Waiting for sync + funds…
  NIGHT balance : 1000.000000
  Registering 1 NIGHT UTXO(s) for DUST generation…
    UTXO: {"utxo":{"value":"1000000000","owner":"mn_addr_undeployed1sg80kt3ec9lk8al2knj59gx5rsc8u40dxj23lum8j5x6mgzv8zvqzdqzp2","type":"0000000000000000000000000000000000…
  DUST registration tx: 00cf82d5b9385341f86beff8e688f8d2d01ab7088ee57137cc96674037a25d64de
  Waiting for DUST to accrue....
  DUST balance  : 355481000000000

=== setup complete — wallets are funded and ready for "run" ===


$ npm run tps -- run --node http://localhost:9945 --indexer http://localhost:8088/api/v4/graphql --prover http://localhost:6300 --wallets 1 --txs 1

> mn-tui@0.1.0 tps
> tsx src/night-tps.ts run --node http://localhost:9945 --indexer http://localhost:8088/api/v4/graphql --prover http://localhost:6300 --wallets 1 --txs 1

Network : undeployed
Node    : http://localhost:9945
Indexer : http://localhost:8088/api/v4/graphql
Prover  : http://localhost:6300

=== run: 1 wallet(s) × 1 tx(s) = 1 transfers on undeployed ===

Initialising wallets…
Waiting for all wallets to sync…
  wallet-1: DUST=570423000000000, NIGHT=1000.000000

Sending (circular pattern, each wallet → next)…
  wallet-1 tx 1/1  00531df066aa2e1d55…  (15721 ms)

=== Results ===
Total transactions : 1
Wall-clock time    : 15.72 s
Submission TPS     : 0.06  (proof generation + submission, not finality)
Latency per tx     : avg 15721 ms  min 15721 ms  max 15721 ms
```

### Notes

- **Submission TPS** measures the time from first proof-generation start to last
  transaction submitted to the relay, across all wallets in parallel. It does
  not measure block inclusion or GRANDPA/BEEFY finality.
- **~15 s per transaction** is dominated by ZK proof generation at the proof
  server. Multiple wallets run in parallel so total wall-clock time scales
  sub-linearly with wallet count.
- **DUST** is a fee token that accrues continuously from registered NIGHT UTXOs.
  After `setup`, wait a few minutes before `run` if the DUST balance seems low.
- **Wallet state** is stored in `night-tps-wallets.json` (mnemonics in plain
  text — do not use on mainnet with real funds).

## Images

| Image | Version | Notes |
|-------|---------|-------|
| `docker.io/bwbush/midnight-node` | `0.22.2-patched` | Patched for genesis-era mc-hash; see `experiments/pubnet-node` |
| `docker.io/midnightntwrk/indexer-standalone` | `4.0.1` | Midnight chain indexer |
| `docker.io/midnightntwrk/proof-server` | `8.0.3` | ZK proof server |
| `docker.io/curlimages/curl` | `latest` | BEEFY key inserter (curl + sh) |
