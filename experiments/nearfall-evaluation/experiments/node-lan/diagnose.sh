#!/usr/bin/env bash

# Usage:
#   ./diagnose.sh summary        # one-shot summary of all protocols across all logs
#   ./diagnose.sh tail-aura      # live tail of AURA activity
#   ./diagnose.sh tail-grandpa   # live tail of GRANDPA activity
#   ./diagnose.sh tail-beefy     # live tail of BEEFY activity
#   ./diagnose.sh tail-all       # live tail of all consensus activity

LOGS="node-?.log"

case "${1:-summary}" in

  summary)

    echo "========================================"
    echo " NODE IDENTITIES"
    echo "========================================"
    grep -h "pubkey:" $LOGS | sort -u

    echo ""
    echo "========================================"
    echo " AURA"
    echo "========================================"

    echo "--- Slot claims per node ---"
    for log in $LOGS; do
      node=$(basename $log .log)
      count=$(grep -c "Claimed slot" $log 2>/dev/null || echo 0)
      echo "  $node: $count slots claimed"
    done

    echo "--- Most recent slot claims ---"
    grep -h "Claimed slot" $LOGS | tail -7

    echo "--- Skipped slots ---"
    skipped=$(grep -ch "Skipping slot" $LOGS 2>/dev/null | awk '{s+=$1} END {print s}')
    echo "  Total skipped slots: $skipped"
    grep -h "Skipping slot" $LOGS | tail -5

    echo "--- Equivocations ---"
    equivs=$(grep -ch "equivocating" $LOGS 2>/dev/null | awk '{s+=$1} END {print s}')
    echo "  Total equivocation warnings: $equivs"
    grep -h "equivocating" $LOGS | tail -5

    echo ""
    echo "========================================"
    echo " GRANDPA"
    echo "========================================"

    echo "--- Most recent concluded rounds ---"
    grep -h "concluded round" $LOGS | tail -5

    echo "--- Finalized blocks ---"
    grep -h "Finalized in round" $LOGS | tail -5

    echo "--- Rounds without finalization ---"
    none=$(grep -ch "Finalized in round = None" $LOGS 2>/dev/null | awk '{s+=$1} END {print s}')
    echo "  Rounds with Finalized=None: $none"

    echo "--- Stalls / timeouts ---"
    stalls=$(grep -chE "stall|timeout" $LOGS 2>/dev/null | awk '{s+=$1} END {print s}')
    echo "  Total stall/timeout messages: $stalls"
    grep -hE "stall|timeout" $LOGS | tail -5

    echo "--- Slot author distribution (unique AURA claims) ---"
    grep -h "Claimed slot" $LOGS \
      | awk '{print $1}' \
      | sort | uniq -c | sort -rn | head -10

    echo ""
    echo "========================================"
    echo " BEEFY"
    echo "========================================"

    echo "--- Startup / initialization ---"
    grep -h "BEEFY pallet available\|Loading BEEFY voter state\|run BEEFY worker" $LOGS | tail -7

    echo "--- Vote targets ---"
    grep -h "Try voting on\|vote target" $LOGS | tail -7

    echo "--- Finalization progress ---"
    grep -h "best beefy\|best_beefy\|mandatory_done" $LOGS | tail -5

    echo "--- Stake warnings ---"
    nomatch=$(grep -ch "No match found" $LOGS 2>/dev/null | awk '{s+=$1} END {print s}')
    echo "  Total 'No match found' stake warnings: $nomatch"

    echo "--- Missing validator id ---"
    missing=$(grep -ch "Missing validator id" $LOGS 2>/dev/null | awk '{s+=$1} END {print s}')
    echo "  Total 'Missing validator id' messages: $missing"

    echo "--- Errors ---"
    grep -hE "beefy.*[Ee]rror|[Ee]rror.*beefy" $LOGS | tail -5

    echo ""
    echo "========================================"
    echo " BLOCK SYNC"
    echo "========================================"

    echo "--- Best block per node ---"
    for log in $LOGS; do
      node=$(basename $log .log)
      best=$(grep "Imported #" $log 2>/dev/null | tail -1)
      echo "  $node: $best"
    done

    echo "--- Recent imports ---"
    grep -h "Imported #" $LOGS | tail -7

    ;;

  tail-aura)
    echo "Tailing AURA activity across $LOGS ..."
    tail -F $LOGS 2>/dev/null \
      | grep --line-buffered -iE \
          "Claimed slot|Skipping slot|Starting consensus|Pre-sealed block|Discarding proposal|equivocating|aura.*error|error.*aura"
    ;;

  tail-grandpa)
    echo "Tailing GRANDPA activity across $LOGS ..."
    tail -F $LOGS 2>/dev/null \
      | grep --line-buffered -iE \
          "concluded round|Finalized in round|Casting prevote|Casting precommit|Imported justification|stall|timeout|authority set|grandpa.*error|error.*grandpa"
    ;;

  tail-beefy)
    echo "Tailing BEEFY activity across $LOGS ..."
    tail -F $LOGS 2>/dev/null \
      | grep --line-buffered -iE \
          "Try voting|vote target|best beefy|Signed commitment|justif|BEEFY pallet|run BEEFY worker|Missing validator|No match found|beefy.*error|error.*beefy" \
      | grep --line-buffered -v "Gossip rebroadcast"
    ;;

  tail-all)
    echo "Tailing all consensus activity across $LOGS ..."
    tail -F $LOGS 2>/dev/null \
      | grep --line-buffered -iE \
          "Claimed slot|Skipping slot|equivocating|concluded round|Finalized in round|Casting prevote|Casting precommit|stall|timeout|Try voting on|best beefy|Signed commitment|Missing validator|Imported #|authority set change" \
      | grep --line-buffered -v "Gossip rebroadcast"
    ;;

  *)
    echo "Usage: $0 {summary|tail-aura|tail-grandpa|tail-beefy|tail-all}"
    exit 1
    ;;

esac
