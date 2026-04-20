#!/usr/bin/env bash
# test-e2e.sh — End-to-end test of the Schnorr wallet (pure Rust)
#
# Prerequisites:
#   - Docker running
#   - Rust toolchain (cargo)
#   - openssl (for .env secret generation)
#   - Pre-compiled contract artifacts in contracts/managed/
#
# Usage:
#   ./test-e2e.sh              # uses WALLET_SEED from infra/.env
#   ./test-e2e.sh --fresh      # reset chain state first
#
# What it does:
#   1. Checks prerequisites
#   2. Builds the Rust binary
#   3. Starts local Midnight devnet (node + indexer + proof-server)
#   4. Runs the pure Rust e2e test (key derivation, Schnorr signing,
#      proof server interaction, contract artifact loading)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/infra"

# ── Prerequisites ───────────────────────────────────────────────────────────

check_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 not found"; exit 1; }; }
check_cmd docker
check_cmd cargo
check_cmd openssl

echo "Prerequisites OK"

# ── Generate infra/.env if missing ──────────────────────────────────────────

if [[ -f "$INFRA_DIR/.env" ]]; then
  echo "infra/.env already exists — skipping generation"
else
  SECRET=$(openssl rand -hex 32)
  sed "s/^APP__INFRA__SECRET=$/APP__INFRA__SECRET=$SECRET/" "$SCRIPT_DIR/.env.example" > "$INFRA_DIR/.env"
  echo "infra/.env created (APP__INFRA__SECRET generated)"
fi

# ── Build ───────────────────────────────────────────────────────────────────

echo ""
echo "Building Rust binary..."
cd "$SCRIPT_DIR"
cargo build

echo ""
echo "Running Schnorr unit tests..."
cargo test

echo ""
echo "Build complete."
echo ""

# ── Load .env ────────────────────────────────────────────────────────────────

set -a
source "$INFRA_DIR/.env"
set +a

# ── Parse flags ──────────────────────────────────────────────────────────────

FRESH=false
for arg in "${@:-}"; do
  case $arg in
    --fresh) FRESH=true ;;
  esac
done

# ── Detect OS for docker compose ─────────────────────────────────────────────

COMPOSE_FILES="-f $INFRA_DIR/docker-compose.yml"
if [[ "$(uname -s)" == "Darwin" ]]; then
  COMPOSE_FILES="$COMPOSE_FILES -f $INFRA_DIR/docker-compose.macos.yml"
  echo "[info] macOS detected — using bridge networking"
fi
COMPOSE="docker compose $COMPOSE_FILES"

# ── Chain reset (--fresh only) ───────────────────────────────────────────────

if $FRESH; then
  echo ""
  echo "=== Resetting chain state ==="
  $COMPOSE down -v 2>/dev/null || true
  sleep 2
fi

# ── Step 1: Start local devnet ───────────────────────────────────────────────

echo ""
echo "=== Step 1: Starting local Midnight devnet ==="
echo ""

$COMPOSE up -d node indexer proof-server

echo ""
echo "Waiting for node to be healthy..."
ELAPSED=0
until curl -sf http://localhost:9944/health > /dev/null 2>&1; do
  if (( ELAPSED >= 60 )); then
    echo "ERROR: node did not start within 60s"
    $COMPOSE logs node --tail 20
    exit 1
  fi
  printf "."
  sleep 2
  (( ELAPSED += 2 ))
done
echo " OK"

echo "Waiting for indexer..."
ELAPSED=0
until curl -sf http://localhost:8088/api/v4/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ __typename }"}' > /dev/null 2>&1; do
  if (( ELAPSED >= 120 )); then
    echo "WARN: indexer not ready after 120s — check logs:"
    echo "  $COMPOSE logs indexer --tail 20"
    break
  fi
  printf "."
  sleep 3
  (( ELAPSED += 3 ))
done
echo " OK"

echo "Waiting for proof server..."
ELAPSED=0
until curl -sf http://localhost:6300/version > /dev/null 2>&1; do
  if (( ELAPSED >= 30 )); then
    echo "WARN: proof server not responding"
    break
  fi
  printf "."
  sleep 2
  (( ELAPSED += 2 ))
done
echo " OK"

echo ""
echo "Services:"
$COMPOSE ps
echo ""

# ── Step 2: Run pure Rust e2e test ──────────────────────────────────────────

echo ""
echo "=== Step 2: Running pure Rust E2E test ==="
echo ""

cd "$SCRIPT_DIR"
cargo run -- e2e --seed "$WALLET_SEED"

echo ""
echo "=== End-to-end test complete ==="
echo ""
