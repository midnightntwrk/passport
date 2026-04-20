#!/usr/bin/env bash
# test-e2e.sh — End-to-end test of the Schnorr wallet experiment
#
# Prerequisites:
#   - Docker running
#   - Node 22+, cargo, openssl available on PATH
#
# Usage:
#   ./test-e2e.sh              # uses WALLET_SEED from infra/.env
#   ./test-e2e.sh --fresh      # reset chain state first
#
# What it does:
#   1. Starts local Midnight devnet (node + indexer + proof-server)
#   2. Waits for services to be healthy
#   3. Deploys the schnorr-wallet contract
#   4. Registers a JubJub owner key
#   5. Deposits unshielded tokens into the contract
#   6. Withdraws tokens via Schnorr signature (computed by Rust CLI)
#   7. Prints final contract state

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/infra"

# ── Prerequisites ───────────────────────────────────────────────────────────

check_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 not found"; exit 1; }; }
check_cmd docker
check_cmd node
check_cmd openssl
check_cmd cargo

NODE_VERSION=$(node --version | sed 's/v\([0-9]*\).*/\1/')
if [[ "$NODE_VERSION" -lt 22 ]]; then
  echo "ERROR: Node 22+ required (found $(node --version))"
  exit 1
fi

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

echo "Installing npm dependencies..."
cd "$SCRIPT_DIR"
npm install

echo "Compiling Compact contract..."
npm run compile

echo "Building Rust signer..."
cd "$SCRIPT_DIR/signer"
cargo build

cd "$SCRIPT_DIR"
echo ""
echo "Setup complete."
echo ""

# ── Load .env ────────────────────────────────────────────────────────────────

set -a
source "$INFRA_DIR/.env"
set +a
export AUTO_CONFIRM=1
export MIDNIGHT_NETWORK=local
export DEPOSIT_AMOUNT=1000

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

# ── Step 2: Deploy contract ──────────────────────────────────────────────────

echo ""
echo "=== Step 2: Deploy schnorr-wallet contract ==="
echo ""

cd "$SCRIPT_DIR"
npx tsx src/deploy.ts

echo "Waiting for indexer to process deploy block..."
sleep 15

# ── Step 3: Register owner key ───────────────────────────────────────────────

echo ""
echo "=== Step 3: Register JubJub owner key ==="
echo ""

npx tsx src/register.ts

echo "Waiting for indexer to process register block..."
sleep 15

# ── Step 4: Check contract state ─────────────────────────────────────────────

echo ""
echo "=== Step 4: Contract state after registration ==="
echo ""

npx tsx src/contract-state.ts

# ── Step 5: Deposit tokens ───────────────────────────────────────────────────

echo ""
echo "=== Step 5: Deposit tokens into contract ==="
echo ""

npx tsx src/deposit.ts

echo "Waiting for indexer to process deposit block..."
sleep 15

# ── Step 6: Check contract state ─────────────────────────────────────────────

echo ""
echo "=== Step 6: Contract state after deposit ==="
echo ""

npx tsx src/contract-state.ts

# ── Step 7: Withdraw tokens via Schnorr signature ────────────────────────────

echo ""
echo "=== Step 7: Withdraw tokens (Schnorr-signed via Rust CLI) ==="
echo ""

npx tsx src/withdraw.ts

echo "Waiting for indexer to process withdraw block..."
sleep 15

# ── Step 8: Final contract state ─────────────────────────────────────────────

echo ""
echo "=== Step 8: Final contract state ==="
echo ""

npx tsx src/contract-state.ts

echo ""
echo "=== End-to-end test complete ==="
echo ""
