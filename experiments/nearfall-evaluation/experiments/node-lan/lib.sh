
function findPort {
sed -n '/Running JSON-RPC server: addr=127\.0\.0\.1:/{s/^.*addr=127\.0\.0\.1:\(.*\),.*$/\1/;p;q}' $1
}

function rpcCall {
  curl -sS \
       -H "Content-Type: application/json" \
       -X POST \
       -d '{"jsonrpc":"2.0","id":1,"method":"'"$2"'","params":[]}' \
       http://127.0.0.1:$1
}

function rpcNodes {
(
  for port in $NODE_PORTS
  do
    rpcCall $port $1 | jq -r '{"'$((port-9944))'": .result}'
  done
) | jq -s '{"'$1'": add}'
}

function listChain {
  local port=$1 local hash
  hash=$(rpcCall $port chain_getFinalizedHead | jq -r .result)
  while true; do
    local header
    header=$(curl -sS \
      -H "Content-Type: application/json" \
      -X POST \
      -d '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":["'"$hash"'"]}' \
      http://127.0.0.1:$port | jq -r '.result')
    local number parentHash
    parentHash=$(echo "$header" | jq -r '.parentHash')
    [ "$parentHash" = "null" ] && break
    number=$(printf '%d' "$(echo "$header" | jq -r '.number')")
    echo "$number"$'\t'"$hash"
    hash=$parentHash
  done
}

NODE_PORTS="$(seq 9945 9951)"
