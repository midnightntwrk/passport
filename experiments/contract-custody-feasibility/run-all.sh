#!/usr/bin/env bash
# run-all.sh — bring up the devnet, compile, deploy, and run every test case.
#
# Acceptance criterion: this single script reproduces the entire experiment
# end-to-end on a clean checkout. Anyone with the pinned SDK installed must
# be able to reproduce the findings.
#
# Prerequisites:
#   - Docker
#   - Node.js >= 22
#   - `compact` compiler on PATH (matching the Compact runtime version pinned
#     in package.json)
#   - openssl (for one-time .env generation)
#
# Usage:
#   ./run-all.sh              # run everything
#   ./run-all.sh --fresh      # reset chain state first
#   ./run-all.sh --tests u1   # run a subset (comma-separated test ids)
#
# Per-test evidence lands in evidence/<id>-<name>.json. After every test runs,
# `tsx src/compose-findings.ts` regenerates the results table in FINDINGS.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/infra"
EVIDENCE_DIR="$SCRIPT_DIR/evidence"

# ── Args ────────────────────────────────────────────────────────────────────

FRESH=false
TESTS=""
for arg in "${@:-}"; do
  case $arg in
    --fresh) FRESH=true ;;
    --tests=*) TESTS="${arg#--tests=}" ;;
    --tests) shift; TESTS="${1:-}";;
  esac
done

ALL_TESTS=(u1 u2 u3 u4 s1 s2 s3 s4 s5 d1 d2)
if [[ -n "$TESTS" ]]; then
  IFS=',' read -r -a SELECTED <<< "$TESTS"
else
  SELECTED=("${ALL_TESTS[@]}")
fi

# ── Prerequisites ───────────────────────────────────────────────────────────

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

# Load .env into this shell so wallet seeds are available to tsx subprocesses.
set -a
source "$INFRA_DIR/.env"
set +a
export AUTO_CONFIRM=1
export MIDNIGHT_NETWORK=local

# ── Build ───────────────────────────────────────────────────────────────────

cd "$SCRIPT_DIR"
echo "Installing npm dependencies..."
npm install --silent

echo "Compiling Compact contract..."
npm run compile

# ── Compose ─────────────────────────────────────────────────────────────────

COMPOSE_FILES="-f $INFRA_DIR/docker-compose.yml"
if [[ "$(uname -s)" == "Darwin" ]]; then
  COMPOSE_FILES="$COMPOSE_FILES -f $INFRA_DIR/docker-compose.macos.yml"
fi
COMPOSE="docker compose $COMPOSE_FILES"

if $FRESH; then
  echo ""
  echo "=== Resetting chain state ==="
  $COMPOSE down -v 2>/dev/null || true
  rm -rf midnight-level-db deployment.json deployment-second.json
  sleep 2
fi

# ── Devnet ──────────────────────────────────────────────────────────────────

echo ""
echo "=== Starting local Midnight devnet ==="
$COMPOSE up -d node indexer proof-server

echo "Waiting for node..."
ELAPSED=0
until curl -sf http://localhost:9944/health > /dev/null 2>&1; do
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
until curl -sf http://localhost:8088/api/v4/graphql -H 'Content-Type: application/json' \
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
until curl -sf http://localhost:6300/version > /dev/null 2>&1; do
  if (( ELAPSED >= 30 )); then
    echo "WARN: proof server not responding"; break
  fi
  printf "."; sleep 2; (( ELAPSED += 2 ))
done
echo " OK"

# ── Deploy ──────────────────────────────────────────────────────────────────

mkdir -p "$EVIDENCE_DIR"

if [[ ! -f "deployment.json" ]]; then
  echo ""
  echo "=== Deploying primary custody contract ==="
  npx tsx src/deploy.ts
fi

# U2 needs a second contract instance.
if printf '%s\n' "${SELECTED[@]}" | grep -qx 'u2' && [[ ! -f "deployment-second.json" ]]; then
  echo ""
  echo "=== Deploying secondary custody contract (for U2) ==="
  CUSTODY_DEPLOY_SLOT=secondary npx tsx src/deploy.ts
fi

# ── Per-test execution ──────────────────────────────────────────────────────
#
# Avoid associative arrays (bash 3.2 on macOS doesn't support them).
# Use a function that maps a test id → filename via case/esac.

test_file_for() {
  case "$1" in
    u1) echo "src/tests/u1-receive-unshielded.ts" ;;
    u2) echo "src/tests/u2-send-to-contract.ts" ;;
    u3) echo "src/tests/u3-send-to-user.ts" ;;
    u4) echo "src/tests/u4-roundtrip.ts" ;;
    s1) echo "src/tests/s1-mint-to-self.ts" ;;
    s2) echo "src/tests/s2-mint-and-send.ts" ;;
    s3) echo "src/tests/s3-cross-tx-custody.ts" ;;
    s4) echo "src/tests/s4-receive-shielded.ts" ;;
    s5) echo "src/tests/s5-manual-witness-shielded-spend.ts" ;;
    d1) echo "src/tests/d1-self-payment.ts" ;;
    d2) echo "src/tests/d2-paymaster.ts" ;;
    *)  echo "" ;;
  esac
}

# bash 3.2-safe uppercase: tr instead of `${var^^}`.
upcase() { echo "$1" | tr '[:lower:]' '[:upper:]'; }

for tid in "${SELECTED[@]}"; do
  file=$(test_file_for "$tid")
  if [[ -z "$file" ]]; then
    echo "WARN: unknown test id '$tid', skipping"; continue
  fi
  TID_UPPER=$(upcase "$tid")
  echo ""
  echo "=== ${TID_UPPER}: ${file##*/} ==="
  if [[ ! -f "$file" ]]; then
    echo "WARN: test file '$file' missing — recording PENDING evidence."
    npx tsx -e "
      import { writeEvidence } from './src/common.ts';
      writeEvidence('${TID_UPPER}', {
        test: '${TID_UPPER}',
        name: 'not-yet-implemented',
        verdict: 'PENDING',
        note: 'Test runner file missing: $file',
        evidence: { reason: 'scaffolding-incomplete' },
      });
    " || true
    continue
  fi
  npx tsx "$file" || true   # never abort the suite — collect every test's outcome
done

# ── Compose FINDINGS.md ─────────────────────────────────────────────────────

echo ""
echo "=== Composing FINDINGS.md from evidence ==="
if [[ -f "src/compose-findings.ts" ]]; then
  npx tsx src/compose-findings.ts
else
  echo "(compose-findings.ts not yet implemented — leaving FINDINGS.md untouched)"
fi

echo ""
echo "=== Done ==="
echo "Evidence: $EVIDENCE_DIR"
echo "Report:   $SCRIPT_DIR/FINDINGS.md"
