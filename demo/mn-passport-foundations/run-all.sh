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

# ── Compose ─────────────────────────────────────────────────────────────────

COMPOSE_FILES="-f $INFRA_DIR/docker-compose.yml"
if [[ "$(uname -s)" == "Darwin" ]]; then
  COMPOSE_FILES="$COMPOSE_FILES -f $INFRA_DIR/docker-compose.macos.yml"
fi

if $FRESH; then
  echo "Resetting chain state..."
  docker compose $COMPOSE_FILES down -v || true
fi

echo "Starting localnet..."
docker compose $COMPOSE_FILES up -d --wait

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
  exit 1
fi
echo "All scenarios passed."
