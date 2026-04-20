#!/usr/bin/env bash

export CFG_PRESET=mainnet
export BASE_PATH=mainnet
export VALIDATOR=false
export NODE_KEY=0a0076255e6b232f8656cb3f2516a16680639eb3dc4589cc12b090a1496131d7

export DB_SYNC_POSTGRES_CONNECTION_STRING=psql://cardano:bcb33b5c09e31e3dd5a2b4ff0ee111e6@192.168.1.11:5432/mainnet?sslmode=disable
export NODE_KEY=0a0076255e6b232f8656cb3f2516a16680639eb3dc4589cc12b090a1496131d7
export CARDANO_SECURITY_PARAMETER=432

./midnight-node-lenient \
  --log sidechain_mc_hash=error,partner_chains_db_sync_data_sources::block=error,sp_partner_chains_bridge=warn,midnight_node::some_module=warn \
  --bootnodes /dns4/bootnode-whippet-bengal.mainnet.midnight.network/tcp/30333/ws/p2p/12D3KooWMmfho3eEFvcnThAfzc9QfieTc91fdhvByL4a2naRjbr2 \
  --bootnodes /dns4/bootnode-labrador-marten.mainnet.midnight.network/tcp/30333/ws/p2p/12D3KooWK2c9vf4UtrjGB27A8weKd6eiBnRQSfeR4TVmQv9MDdDt \
  --bootnodes /dns4/bootnode-glider-spaniel.bn.midnight.network/tcp/30333/ws/p2p/12D3KooWHif7N1ZPhrB8WxTFqjWTxo2U2a2FtJuSA8XRBdFMss6i \
  --bootnodes /dns4/bootnode-dog-pelican.bn.midnight.network/tcp/30333/ws/p2p/12D3KooWQ2NCZCnqkYKHKsYVUc8amBKAk4jhEMJyYDAJjmSuM4uK \
  --chain res/mainnet/chain-spec-raw.json \
  --state-pruning archive \
  --blocks-pruning archive \
  --port 30333 \
  --rpc-port 9944 \
  --rpc-methods=Safe \
  --rpc-external \
  --rpc-cors all
