#!/usr/bin/env bash
# run-all.sh — compile, bring up the devnet, and run every probe.
#
# Acceptance criterion: this single script reproduces the entire experiment
# end-to-end on a clean checkout.
#
# Prerequisites: Docker, Node.js >= 22, `compact` on PATH, openssl.
#
# Usage:
#   ./run-all.sh               # run everything
#   ./run-all.sh --fresh       # reset chain state first
#   ./run-all.sh --tests w1,w3 # run a subset

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/infra"
EVIDENCE_DIR="$SCRIPT_DIR/evidence"

FRESH=false
TESTS=""
for arg in "${@:-}"; do
  case $arg in
    --fresh) FRESH=true ;;
    --tests=*) TESTS="${arg#--tests=}" ;;
    --tests) shift; TESTS="${1:-}";;
  esac
done

ALL_TESTS=(w1 w2 w3 w4 w5 w6)
if [[ -n "$TESTS" ]]; then
  IFS=',' read -r -a SELECTED <<< "$TESTS"
else
  # w4 is the fallback probe — only meaningful if w3 reports a glue crash —
  # so the default run skips it.
  SELECTED=(w1 w2 w3 w5 w6)
fi

check_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 not found"; exit 1; }; }
check_cmd docker
check_cmd node
check_cmd openssl
check_cmd compact

NODE_MAJOR=$(node --version | sed 's/v\([0-9]*\).*/\1/')
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "ERROR: Node 22+ required (found $(node --version))"
  exit 1
fi

# ── infra/.env ──────────────────────────────────────────────────────────────

if [[ ! -f "$INFRA_DIR/.env" ]]; then
  SECRET=$(openssl rand -hex 32)
  sed "s/^APP__INFRA__SECRET=$/APP__INFRA__SECRET=$SECRET/" "$SCRIPT_DIR/.env.example" > "$INFRA_DIR/.env"
  echo "infra/.env created (APP__INFRA__SECRET generated)"
fi

set -a
source "$INFRA_DIR/.env"
set +a
export MIDNIGHT_NETWORK=local

# ── Build ───────────────────────────────────────────────────────────────────

cd "$SCRIPT_DIR"
echo "Installing npm dependencies..."
npm install --silent

echo "Compiling Compact contracts..."
npm run compile

mkdir -p "$EVIDENCE_DIR"

# ── W1 needs no chain — run it before compose ───────────────────────────────

if printf '%s\n' "${SELECTED[@]}" | grep -qx 'w1'; then
  echo ""
  echo "=== W1: compile-disclosure (no devnet needed) ==="
  npx tsx src/tests/w1-compile-disclosure.ts || true
fi

NEEDS_CHAIN=false
for tid in "${SELECTED[@]}"; do
  [[ "$tid" != "w1" ]] && NEEDS_CHAIN=true
done

if $NEEDS_CHAIN; then
  # ── Compose ───────────────────────────────────────────────────────────────
  # The macOS override (inherited from account-custody-prototype) maps the
  # STANDARD ports — unlike dust-sponsorship's +10000 offsets — so the same
  # ports apply on every host OS.
  COMPOSE_FILES="-f $INFRA_DIR/docker-compose.yml"
  NODE_PORT=9944
  INDEXER_PORT=8088
  PROOF_PORT=6300
  if [[ "$(uname -s)" == "Darwin" ]]; then
    COMPOSE_FILES="$COMPOSE_FILES -f $INFRA_DIR/docker-compose.macos.yml"
  fi
  export NODE_URL="http://localhost:$NODE_PORT"
  export INDEXER_URL="http://localhost:$INDEXER_PORT/api/v4/graphql"
  export INDEXER_WS_URL="ws://localhost:$INDEXER_PORT/api/v4/graphql/ws"
  export PROOF_SERVER_URL="http://127.0.0.1:$PROOF_PORT"
  COMPOSE="docker compose $COMPOSE_FILES"

  if $FRESH; then
    echo ""
    echo "=== Resetting chain state ==="
    $COMPOSE down -v 2>/dev/null || true
    rm -rf midnight-level-db deployment.json
    sleep 2
  fi

  echo ""
  echo "=== Starting local Midnight devnet ==="
  $COMPOSE up -d node indexer proof-server

  echo "Waiting for node..."
  ELAPSED=0
  until curl -sf http://localhost:$NODE_PORT/health > /dev/null 2>&1; do
    if (( ELAPSED >= 60 )); then
      echo "ERROR: node did not start within 60s"
      $COMPOSE logs node --tail 20
      exit 1
    fi
    printf "."; sleep 2; (( ELAPSED += 2 ))
  done
  echo " OK"

  echo "Waiting for indexer..."
  ELAPSED=0
  until curl -sf http://localhost:$INDEXER_PORT/api/v4/graphql -H 'Content-Type: application/json' \
    -d '{"query":"{ __typename }"}' > /dev/null 2>&1; do
    if (( ELAPSED >= 120 )); then
      echo "WARN: indexer not ready after 120s"
      break
    fi
    printf "."; sleep 3; (( ELAPSED += 3 ))
  done
  echo " OK"

  echo "Waiting for proof server..."
  ELAPSED=0
  until curl -sf http://localhost:$PROOF_PORT/version > /dev/null 2>&1; do
    if (( ELAPSED >= 30 )); then
      echo "WARN: proof server not responding"; break
    fi
    printf "."; sleep 2; (( ELAPSED += 2 ))
  done
  echo " OK"

  # ── Per-probe execution ───────────────────────────────────────────────────

  test_file_for() {
    case "$1" in
      w2) echo "src/tests/w2-stateless-deposit.ts" ;;
      w3) echo "src/tests/w3-witness-spend.ts" ;;
      w4) echo "src/tests/w4-manual-offer.ts" ;;
      w5) echo "src/tests/w5-third-party-deposit.ts" ;;
      w6) echo "src/tests/w6-leak-audit.ts" ;;
      *)  echo "" ;;
    esac
  }

  for tid in "${SELECTED[@]}"; do
    [[ "$tid" == "w1" ]] && continue
    file=$(test_file_for "$tid")
    if [[ -z "$file" ]]; then
      echo "WARN: unknown test id '$tid', skipping"; continue
    fi
    echo ""
    echo "=== ${tid}: ${file##*/} ==="
    npx tsx "$file" || true   # never abort the suite — collect every probe's outcome
  done
fi

# ── Compose FINDINGS.md ─────────────────────────────────────────────────────

echo ""
echo "=== Composing FINDINGS.md from evidence ==="
npx tsx src/compose-findings.ts

echo ""
echo "=== Done ==="
echo "Evidence: $EVIDENCE_DIR"
echo "Report:   $SCRIPT_DIR/FINDINGS.md"
