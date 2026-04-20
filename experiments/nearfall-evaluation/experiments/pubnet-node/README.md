# 👱🤖 Midnight Node — Mainnet/Preprod Sync Fix

## Problem

When running a Midnight node (v0.22.2) against the Cardano **preprod** or **mainnet** network,
block verification fails immediately at genesis with:

```
💔 Verification failed for block …: "Main chain state <hash> referenced in imported
block at slot <slot> with timestamp <ts> not found"
```

The error originates in `sidechain-mc-hash` (`get_mc_state_reference`), which validates
each Midnight block's Cardano anchor by calling `get_stable_block_for`. That function
checks two conditions:

1. The Cardano block exists in cardano-db-sync.
2. The Cardano block's timestamp falls within the stability window
   `[reference − 3k/f, reference − k/f]`, where the reference timestamp is derived
   from the Midnight slot number and the Midnight slot duration.

The genesis-era Midnight blocks (both preprod and mainnet) reference Cardano blocks
whose timestamps fall **outside** this window — the Cardano anchor is too old relative
to the Midnight slot clock. For example, on preprod the offset is roughly **15.6 hours**
(the anchor block was ~15.6 h old at the time the Midnight block was produced, but the
window only allows up to ~7.2 h = 3k/f with k = 432, f = 0.05).

This is a fixed property of the committed chain history; it cannot be corrected by
changing environment variables or the chain-spec.

## Solution

Patch the `partner-chains` SDK (tag `v1.8.1`) to fall back from the strict
timestamp-filtered lookup to a pure hash lookup when the former returns `None`.
The fallback is only reached when the block hash is valid but its timestamp lies
outside the stability window — i.e., exactly the genesis-era situation described above.

Diagnostic `WARN`-level log messages are emitted when the fallback fires, showing the
reference timestamp, stability window, actual block timestamp, and the offset in days.

### Patch files

| File | Target repo | What it changes |
|------|-------------|-----------------|
| [`partner-chains.patch`](partner-chains.patch) | `input-output-hk/partner-chains` @ `v1.8.1` | Adds hash-only fallback in `get_mc_state_reference`; adds diagnostic logging in `BlockDataSourceImpl::get_stable_block_by_hash_from_db`; adds `log` dependency to `sidechain-mc-hash` |
| [`midnight-node.patch`](midnight-node.patch) | `midnight-node` @ `v0.22.2` | Adds `[patch]` section to `Cargo.toml` redirecting all `partner-chains` git dependencies to a local checkout of the patched SDK; updates `Cargo.lock` accordingly |

### Applying the patches

```bash
# 1. Clone and patch partner-chains
git clone --branch v1.8.1 https://github.com/input-output-hk/partner-chains
cd partner-chains
git apply /path/to/partner-chains.patch
cd ..

# 2. Clone and patch midnight-node
git clone --branch v0.22.2 <midnight-node-repo>
cd midnight-node
git apply /path/to/midnight-node.patch

# 3. Build
cargo build --release -p midnight-node
```

The midnight-node patch assumes `partner-chains/` is a sibling directory of
`midnight-node/`. Adjust the paths in `Cargo.toml` if your layout differs.

### Docker image

After building the patched binary (`cargo build --release --bin midnight-node`),
package it as a Docker image using the provided `Dockerfile`:

**Prerequisites:** Docker or Podman; `x86_64-linux` host; the patched binary at
`target/release/midnight-node`; the `res/` tree from the midnight-node source.

**1. Fix the dynamic linker path** so the binary works outside the Nix build
environment:

```bash
patchelf \
  --set-interpreter /lib64/ld-linux-x86-64.so.2 \
  --set-rpath /usr/lib/x86_64-linux-gnu \
  target/release/midnight-node
```

**2. Write a `Dockerfile`:**

```dockerfile
FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3 libgcc-s1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY target/release/midnight-node /usr/local/bin/midnight-node
COPY res/ /res/
```

**3. Build and push the image:**

```bash
docker build -t bwbush/midnight-node:0.22.2-patched .
docker push bwbush/midnight-node:0.22.2-patched
```

The entire `res/` tree is baked into the image at `/res/`. The node reads
`/res/cfg/default.toml` on startup and the network-specific config
(`/res/cfg/mainnet.toml` or `/res/cfg/preprod.toml`) selected by `CFG_PRESET`.
Chain-specs are at `/res/{mainnet,preprod}/chain-spec-raw.json`.

### Running with Podman Kubernetes YAML

Two pod spec files are provided:

| File | Network | Host data directory | Host ports |
|------|---------|---------------------|------------|
| [`midnight-mainnet.yaml`](midnight-mainnet.yaml) | Midnight mainnet | `./mainnet` | P2P 30334, RPC 9945 |
| [`midnight-preprod.yaml`](midnight-preprod.yaml) | Midnight preprod | `./preprod` | P2P 130333, RPC 19944 |

Each pod mounts a local directory at `/data` inside the container for chain
state and SQLite index databases. The node process writes to this directory
without a fixed UID, so the host directory must be world-writable:

```bash
mkdir -p mainnet && chmod 777 mainnet
mkdir -p preprod && chmod 777 preprod
```

Update `DB_SYNC_POSTGRES_CONNECTION_STRING` in each YAML to point at your
cardano-db-sync PostgreSQL instance before running.

Start, stop, and follow logs:

```bash
podman kube play midnight-mainnet.yaml       # start
podman kube down midnight-mainnet.yaml       # stop
podman pod logs --follow midnight-mainnet    # logs
```

```bash
podman kube play midnight-preprod.yaml       # start
podman kube down midnight-preprod.yaml       # stop
podman pod logs --follow midnight-preprod    # logs
```

### Run scripts

Two convenience scripts are provided. Both run `midnight-node-lenient` (the patched
binary) as a non-validating archive node and connect to the respective public bootnodes.

| Script | Network | Chain spec |
|--------|---------|------------|
| [`run-mainnet.sh`](run-mainnet.sh) | Midnight mainnet | `res/mainnet/chain-spec-raw.json` |
| [`run-preprod.sh`](run-preprod.sh) | Midnight preprod | `res/preprod/chain-spec-raw.json` |

Both scripts share the same structure:

- `CFG_PRESET` / `BASE_PATH` select the network and on-disk state directory.
- `VALIDATOR=false` disables block production.
- `DB_SYNC_POSTGRES_CONNECTION_STRING` points at the cardano-db-sync PostgreSQL
  instance (update the host/credentials to match your setup).
- `CARDANO_SECURITY_PARAMETER=432` is the correct Cardano mainnet/preprod value.
- `--state-pruning archive --blocks-pruning archive` retains full history.
- `--rpc-port 9944 --rpc-methods=Safe --rpc-external` exposes a public-safe RPC
  endpoint on all interfaces.
- The `--log` flag suppresses the fallback warning messages (see below).

### Suppressing diagnostic log messages

To silence the fallback warnings once the genesis period has passed:

```
--log sidechain_mc_hash=error,partner_chains_db_sync_data_sources::block=error
```
