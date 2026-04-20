#!/usr/bin/env bash

export CFG_PRESET=preprod
export BASE_PATH=preprod
export VALIDATOR=false
export NODE_KEY=0a0076255e6b232f8656cb3f2516a16680639eb3dc4589cc12b090a1496131d7

export DB_SYNC_POSTGRES_CONNECTION_STRING=psql://cardano:bcb33b5c09e31e3dd5a2b4ff0ee111e6@192.168.1.11:5432/preprod?sslmode=disable
export NODE_KEY=0a0076255e6b232f8656cb3f2516a16680639eb3dc4589cc12b090a1496131d7
export CARDANO_SECURITY_PARAMETER=432

./midnight-node-lenient \
  --log sidechain_mc_hash=error,partner_chains_db_sync_data_sources::block=error,sp_partner_chains_bridge=warn,midnight_node::some_module=warn \
  --bootnodes /dns/bootnode-1.preprod.midnight.network/tcp/30333/ws/p2p/12D3KooWQxxUgq7ndPfAaCFNbAxtcKYxrAzTxDfRGNktF75SxdX5 \
  --bootnodes /dns/bootnode-2.preprod.midnight.network/tcp/30333/ws/p2p/12D3KooWNrUBs22FfmgjqFMa9ZqKED2jnxwsXWw5E4q2XVwN35TJ \
  --chain res/preprod/chain-spec-raw.json \
  --state-pruning archive \
  --blocks-pruning archive \
  --port 30333 \
  --rpc-port 9944 \
  --rpc-methods=Safe \
  --rpc-external \
  --rpc-cors all
