#!/usr/bin/env bash

# Configuration
RPC_URL="http://localhost:9944"
REFRESH_RATE=5 # Seconds between updates

echo "Starting Midnight Node Monitor..."
echo "Press [CTRL+C] to stop."
echo "-----------------------------------"

while true; do
    # Fetch data from RPC
    HEALTH=$(curl -s -H "Content-Type: application/json" -d '{"id":1, "jsonrpc":"2.0", "method": "system_health"}' $RPC_URL)
    SYNC=$(curl -s -H "Content-Type: application/json" -d '{"id":1, "jsonrpc":"2.0", "method": "system_syncState"}' $RPC_URL)

    # Parse values using jq (ensure jq is installed: sudo apt install jq)
    PEERS=$(echo $HEALTH | jq -r '.result.peers')
    IS_SYNCING=$(echo $HEALTH | jq -r '.result.isSyncing')
    CURRENT=$(echo $SYNC | jq -r '.result.currentBlock')
    HIGHEST=$(echo $SYNC | jq -r '.result.highestBlock')

    # Convert hex to decimal if necessary (Substrate sometimes returns hex)
    CURRENT_DEC=$((CURRENT))
    HIGHEST_DEC=$((HIGHEST))

    # Calculate Percentage
    if [ $HIGHEST_DEC -gt 0 ]; then
        PERCENT=$(echo "scale=2; ($CURRENT_DEC / $HIGHEST_DEC) * 100" | bc)
    else
        PERCENT=0
    fi

    # Clear screen and print status
    clear
    echo "Midnight Node Status [$(date +%T)]"
    echo "-----------------------------------"
    echo "Syncing:     $IS_SYNCING"
    echo "Peers:       $PEERS"
    echo "Progress:    $CURRENT_DEC / $HIGHEST_DEC ($PERCENT%)"
    
    if [ "$IS_SYNCING" = "false" ] && [ $CURRENT_DEC -ge $HIGHEST_DEC ]; then
        echo "Status:      ✅ FULLY SYNCED"
    else
        echo "Status:      ⏳ SYNCING IN PROGRESS"
    fi

    sleep $REFRESH_RATE
done
