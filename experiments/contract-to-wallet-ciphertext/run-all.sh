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
#   ./run-all.sh --tests p1,p2 # run a subset

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

ALL_TESTS=(p1 p2 p3)
if [[ -n "$TESTS" ]]; then
  IFS=',' read -r -a SELECTED <<< "$TESTS"
else
  SELECTED=(p1 p2 p3)
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

# P1 reads the installed toolchain only; P2 and P3 need the devnet.
NEEDS_CHAIN=true

if $NEEDS_CHAIN; then
  # ── Compose ───────────────────────────────────────────────────────────────
  # The macOS override (inherited from account-custody-prototype) maps the
  # The macOS override maps the STANDARD ports, so the same ports apply on
  # every host OS.
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
  # The node and the proof server come up first. The indexer is held back
  # deliberately: its SPO component asks the node for block 1 as soon as it
  # connects, and on a freshly reset chain the node reports healthy while
  # still at block 0. Starting them together loses that race often enough
  # to break `--fresh`, and the indexer exits with
  #   Cannot construct OnlineClientAtBlock: block number 1 not found
  $COMPOSE up -d node proof-server

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

  node_height() {
    curl -s -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}' \
      "http://localhost:$NODE_PORT" 2>/dev/null \
      | sed -n 's/.*"number":"0x\([0-9a-f]*\)".*/\1/p'
  }

  echo "Waiting for the first block..."
  ELAPSED=0
  until [[ -n "$(node_height)" && "$(node_height)" != "0" ]]; do
    if (( ELAPSED >= 120 )); then
      echo "ERROR: node produced no block within 120s"
      $COMPOSE logs node --tail 20
      exit 1
    fi
    printf "."; sleep 2; (( ELAPSED += 2 ))
  done
  echo " OK (block 0x$(node_height))"

  echo ""
  echo "=== Starting indexer ==="
  $COMPOSE up -d indexer

  echo "Waiting for indexer..."
  ELAPSED=0
  until curl -sf http://localhost:$INDEXER_PORT/api/v4/graphql -H 'Content-Type: application/json' \
    -d '{"query":"{ __typename }"}' > /dev/null 2>&1; do
    # A crashed indexer never becomes ready; surface it rather than waiting out
    # the timeout, and retry once in case it still lost the race.
    if ! docker ps --format '{{.Names}}' | grep -q "indexer"; then
      echo ""
      echo "WARN: indexer exited; restarting once"
      $COMPOSE logs indexer --tail 5
      $COMPOSE up -d indexer
    fi
    if (( ELAPSED >= 120 )); then
      echo "ERROR: indexer not ready after 120s"
      $COMPOSE logs indexer --tail 20
      exit 1
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
      p1) echo "src/tests/p1-api-surface.ts" ;;
      p2) echo "src/tests/p2-ciphertext-discovery.ts" ;;
      p3) echo "src/tests/p3-spend-and-secrecy.ts" ;;
      *)  echo "" ;;
    esac
  }

  for tid in "${SELECTED[@]}"; do
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
