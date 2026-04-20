#!/bin/bash

# Midnight Contract Test Runner
# Usage: ./test.sh [contract-path] [options]
# Returns: Test results with pass/fail summary

set -e

# Default values
CONTRACT_PATH="${1:-.}"
shift 2>/dev/null || true
VITEST_OPTIONS="$@"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "Midnight Contract Test Runner" >&2
echo "=============================" >&2
echo "" >&2

# Resolve contract path
if [[ -d "$CONTRACT_PATH" ]]; then
    CONTRACT_PATH=$(cd "$CONTRACT_PATH" && pwd)
else
    echo "Error: Directory not found: $CONTRACT_PATH" >&2
    exit 1
fi

echo "Contract path: $CONTRACT_PATH" >&2
echo "" >&2

# Check for package.json
if [[ ! -f "$CONTRACT_PATH/package.json" ]]; then
    echo "Error: No package.json found in $CONTRACT_PATH" >&2
    exit 1
fi

# Check if contract needs compilation
MANAGED_DIR="$CONTRACT_PATH/src/managed"
COMPACT_FILES=$(find "$CONTRACT_PATH" -name "*.compact" -type f 2>/dev/null)

if [[ -n "$COMPACT_FILES" && ! -d "$MANAGED_DIR" ]]; then
    echo "Compiling contract..." >&2
    cd "$CONTRACT_PATH"
    npm run build 2>&1 >&2
    echo "Compilation complete" >&2
    echo "" >&2
fi

# Run tests
echo "Running tests..." >&2
echo "" >&2

cd "$CONTRACT_PATH"

# Capture test output
TEST_OUTPUT=$(npm run test -- $VITEST_OPTIONS 2>&1) || true
TEST_EXIT_CODE=${PIPESTATUS[0]}

# Display output
echo "$TEST_OUTPUT" >&2

# Parse results
PASSED=$(echo "$TEST_OUTPUT" | grep -oE "[0-9]+ passed" | head -1 | grep -oE "[0-9]+")
FAILED=$(echo "$TEST_OUTPUT" | grep -oE "[0-9]+ failed" | head -1 | grep -oE "[0-9]+")
SKIPPED=$(echo "$TEST_OUTPUT" | grep -oE "[0-9]+ skipped" | head -1 | grep -oE "[0-9]+")
TOTAL=$(echo "$TEST_OUTPUT" | grep -oE "[0-9]+ total" | head -1 | grep -oE "[0-9]+")
DURATION=$(echo "$TEST_OUTPUT" | grep -oE "Time:.*[0-9.]+" | head -1 | grep -oE "[0-9.]+s")

# Default values if not found
PASSED=${PASSED:-0}
FAILED=${FAILED:-0}
SKIPPED=${SKIPPED:-0}
TOTAL=${TOTAL:-0}
DURATION=${DURATION:-"0s"}

echo "" >&2
echo "=============================" >&2

if [[ "$FAILED" == "0" ]]; then
    echo -e "${GREEN}All tests passed!${NC}" >&2
else
    echo -e "${RED}Some tests failed${NC}" >&2
fi

echo "" >&2

# Output JSON for programmatic use
cat <<EOF
{
  "passed": $PASSED,
  "failed": $FAILED,
  "skipped": $SKIPPED,
  "total": $TOTAL,
  "duration": "$DURATION",
  "success": $([ "$FAILED" == "0" ] && echo "true" || echo "false"),
  "contractPath": "$CONTRACT_PATH"
}
EOF

exit $TEST_EXIT_CODE
