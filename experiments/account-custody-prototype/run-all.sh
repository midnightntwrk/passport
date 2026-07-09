#!/usr/bin/env bash
# run-all.sh — bring up the localnet, compile, unit-test, and run every
# integration lifecycle scenario.
#
# Prerequisites: Docker, Node.js >= 22, `compact` on PATH, openssl.
#
# Usage:
#   ./run-all.sh                       # everything
#   ./run-all.sh --fresh               # reset chain state first
#   ./run-all.sh --tests night,grants  # subset of integration scenarios

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/infra"

FRESH=false
TESTS=""
for arg in "${@:-}"; do
  case $arg in
    --fresh) FRESH=true ;;
    --tests=*) TESTS="${arg#--tests=}" ;;
    --tests) shift; TESTS="${1:-}";;
  esac
done

ALL_TESTS=(night grants shielded recovery)
if [[ -n "$TESTS" ]]; then
  IFS=',' read -r -a SELECTED <<< "$TESTS"
else
  SELECTED=("${ALL_TESTS[@]}")
fi

check_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 not found"; exit 1; }; }
check_cmd docker
check_cmd node
check_cmd openssl
check_cmd compact

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

if [[ ! -d "$SCRIPT_DIR/buss-wasm/pkg-node" ]]; then
  echo "Building BUSS wasm package (Pleiades bridge)..."
  "$SCRIPT_DIR/buss-wasm/build.sh"
fi

# ── Compose ─────────────────────────────────────────────────────────────────

COMPOSE_FILES="-f $INFRA_DIR/docker-compose.yml"
if [[ "$(uname -s)" == "Darwin" ]]; then
  COMPOSE_FILES="$COMPOSE_FILES -f $INFRA_DIR/docker-compose.macos.yml"
fi

if $FRESH; then
  echo "Resetting chain state..."
  docker compose $COMPOSE_FILES down -v || true
  # Node-side private-state store — stale entries from the previous chain.
  rm -rf "$SCRIPT_DIR/midnight-level-db" "$SCRIPT_DIR/deployment.json"
fi

echo "Starting localnet..."
# On a fresh chain the indexer can lose a startup race against the node
# ("block number 1 not found" → container exits once); --wait then fails.
# Bring the stack up, then heal the indexer if it tripped.
docker compose $COMPOSE_FILES up -d --wait || true

INDEXER="account-custody-prototype-indexer-1"
for _ in $(seq 1 30); do
  state=$(docker inspect -f '{{.State.Status}}' "$INDEXER" 2>/dev/null || echo missing)
  health=$(docker inspect -f '{{.State.Health.Status}}' "$INDEXER" 2>/dev/null || echo none)
  if [[ "$state" == "running" && "$health" == "healthy" ]]; then
    break
  fi
  if [[ "$state" == "exited" ]]; then
    echo "Indexer lost the fresh-chain startup race — restarting it..."
    docker start "$INDEXER" >/dev/null
  fi
  sleep 2
done
state=$(docker inspect -f '{{.State.Health.Status}}' "$INDEXER" 2>/dev/null || echo none)
if [[ "$state" != "healthy" ]]; then
  echo "ERROR: indexer did not become healthy; see: docker logs $INDEXER"
  exit 1
fi

# ── Unit tests ──────────────────────────────────────────────────────────────

echo ""
echo "Running unit tests (simulator)..."
npx vitest run

# ── Integration scenarios ───────────────────────────────────────────────────

FAILED=()
for t in "${SELECTED[@]}"; do
  echo ""
  echo "Running lifecycle-$t..."
  npx tsx "src/tests/lifecycle-$t.ts" || FAILED+=("$t")
done

echo ""
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "FAILED scenarios: ${FAILED[*]}"
  # The most common non-code failure: an aged chain. The genesis wallet's
  # Dust state drifts from the node's ("Invalid Transaction: Custom error:
  # 138"; node logs show Malformed(BalanceCheckOverspend) for token Dust).
  if docker logs --since 30m account-custody-prototype-node-1 2>&1 \
      | grep -q "BalanceCheckOverspend"; then
    echo ""
    echo "The node is rejecting transactions with Dust BalanceCheckOverspend —"
    echo "the chain state is stale (known aged-localnet issue, not a code bug)."
    echo "Rerun with a clean chain:   ./run-all.sh --fresh"
  fi
  exit 1
fi
echo "All scenarios passed."
