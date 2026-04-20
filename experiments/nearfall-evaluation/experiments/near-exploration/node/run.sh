#!/bin/sh

if ! which jq
then
  apt-get update
  apt-get install -y curl jq
fi

BOOT_NODES=$(curl -s -X POST https://rpc.testnet.near.org -H "Content-Type: application/json" -d '{
        "jsonrpc": "2.0",
        "method": "network_info",
        "params": [],
        "id": "dontcare"
      }' | jq -r '.result.active_peers as $list1 | .result.known_producers as $list2 |
          $list1[] as $active_peer | $list2[] |
          select(.peer_id == $active_peer.id) |
          "\(.peer_id)@\($active_peer.addr)"' | paste -sd "," -)
echo "BOOT_NODES=$BOOT_NODES"

if [ ! -d data ]
then
  neard --home ~/.near init --chain-id testnet --download-genesis --download-config rpc --boot-nodes "$BOOT_NODES"
fi

exec neard --home ~/.near run --boot-nodes "$BOOT_NODES"
