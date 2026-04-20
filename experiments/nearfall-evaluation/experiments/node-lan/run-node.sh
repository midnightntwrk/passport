#!/usr/bin/env bash

set -eo pipefail

MIDNIGHT_NODE=../../../midnight-node/target/release/midnight-node

SEQUENCE=$1
LABEL=node-$SEQUENCE

PORT=$((9944+SEQUENCE))

mkdir -p $LABEL/state

export CFG_PRESET=dev
export AURA_SEED_FILE=$LABEL/aura.seed
export GRANDPA_SEED_FILE=$LABEL/grandpa.seed
export BEEFY_SEED_FILE=$LABEL/beefy.seed
export CROSS_CHAIN_SEED_FILE=$LABEL/beefy.seed
export NODE_KEY_FILE=$LABEL/key
export BASE_PATH=$LABEL/state
export CHAIN=local
export VALIDATOR=true

if (( $SEQUENCE == 1 ))
then
  unset BOOTNODES
elif (( $SEQUENCE == 2 ))
then
  export BOOTNODES="/ip4/127.0.0.1/tcp/30334/p2p/$(cat node-1/identity)"
else
  export BOOTNODES="/ip4/127.0.0.1/tcp/30334/p2p/$(cat node-1/identity) /ip4/127.0.0.1/tcp/30335/p2p/$(cat node-2/identity)"
fi

wait_for_rpc() {
  until curl -sS -H "Content-Type: application/json" -X POST \
    -d '{"jsonrpc":"2.0","id":1,"method":"system_health","params":[]}' \
    http://127.0.0.1:$PORT > /dev/null 2>&1; do
    sleep 1
  done
}

insert_beefy_key() {
  local seed=$(sed -n -e '/Secret seed/{s/^  Secret seed:       \(.*\)$/\1/;p}' $LABEL/beefy.keygen)
  local pubkey=$(sed -n -e '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' $LABEL/beefy.keygen)
  curl -sS -H "Content-Type: application/json" -X POST \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"author_insertKey\",\"params\":[\"beef\",\"$seed\",\"$pubkey\"]}" \
    -w "%{http_code}\n" \
    -o /dev/null \
    http://127.0.0.1:$PORT
}

"$MIDNIGHT_NODE" \
  --chain chain-spec-raw.json \
  --state-pruning archive \
  --blocks-pruning archive \
  --port $((30333+SEQUENCE)) \
  --rpc-port $((9944+SEQUENCE)) \
  --log aura=trace,grandpa=trace,beefy=trace,afg=trace,babe=trace &
NODE_PID=$!

wait_for_rpc
# We actually need to also wait for the beefy pallet to become ava
sleep 10s
insert_beefy_key
echo "BEEFY key inserted for $LABEL"

wait $NODE_PID

