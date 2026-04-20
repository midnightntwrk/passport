#!/usr/bin/env bash

source lib.sh

(
rpcNodes system_localPeerId
rpcNodes system_peers
rpcNodes system_health
rpcNodes chain_getHeader
rpcNodes chain_getFinalizedHead
rpcNodes grandpa_roundState
rpcNodes beefy_getFinalizedHead
) | jq -s add
