#!/usr/bin/env bash
# Regenerate every prover/verifier key of a compiled Compact contract from
# its ZKIR alone, time the regeneration, and compare the output byte for
# byte against the keys compactc produced.
#
# Usage: ./run.sh <managed-contract-dir> [zkir-binary] [out-dir]
#
#   managed-contract-dir  e.g. ../../contract/contracts/managed/account
#   zkir-binary           defaults to the zkir-v3 of the compactc version
#                         recorded in <dir>/compiler/contract-info.json
#   out-dir               scratch directory for regenerated keys
set -euo pipefail

MANAGED="${1:?managed contract dir}"
ZKIR="${2:-}"
OUT="${3:-$(mktemp -d)}"

if [ -z "$ZKIR" ]; then
  ver=$(sed -n 's/.*"compiler-version": *"\([^"]*\)".*/\1/p' "$MANAGED/compiler/contract-info.json" | head -1)
  # compactc reports 0.33.0 for the 0.33.0-rc.2 toolchain; prefer an exact
  # match, then the first installed version with that prefix.
  cand=$(ls -d ~/.compact/versions/"$ver"*/ 2>/dev/null | head -1)
  ZKIR="${cand}aarch64-darwin/zkir-v3"
  [ -x "$ZKIR" ] || ZKIR="${cand}$(uname -m)-$(uname -s | tr A-Z a-z)/zkir-v3"
fi
[ -x "$ZKIR" ] || { echo "zkir binary not found: $ZKIR" >&2; exit 1; }

mkdir -p "$OUT"
echo "zkir:     $ZKIR ($("$ZKIR" --version))"
echo "contract: $MANAGED"
echo "out:      $OUT"
echo
printf '%-52s %4s %7s %10s %9s %8s %8s %8s\n' circuit k rows zkir_bytes prover_MB time_s peak_GB match
for ir in "$MANAGED"/zkir/*.zkir; do
  c=$(basename "$ir" .zkir)
  log=$(/usr/bin/time -l "$ZKIR" compile "$ir" "$OUT/$c.prover" "$OUT/$c.verifier" 2>&1)
  k=$(sed -n 's/.*(k=\([0-9]*\), rows=\([0-9]*\)).*/\1/p' <<<"$log")
  rows=$(sed -n 's/.*(k=\([0-9]*\), rows=\([0-9]*\)).*/\2/p' <<<"$log")
  t=$(sed -n 's/.* \([0-9.]*\) real.*/\1/p' <<<"$log")
  rss=$(awk '/maximum resident/{printf "%.2f", $1/1024/1024/1024}' <<<"$log")
  zb=$(stat -f %z "$ir")
  pmb=$(awk -v b="$(stat -f %z "$OUT/$c.prover")" 'BEGIN{printf "%.1f", b/1024/1024}')
  if cmp -s "$MANAGED/keys/$c.prover" "$OUT/$c.prover" && cmp -s "$MANAGED/keys/$c.verifier" "$OUT/$c.verifier"; then
    m=IDENTICAL
  else
    m=DIFFERS
  fi
  printf '%-52s %4s %7s %10s %9s %8s %8s %8s\n' "$c" "$k" "$rows" "$zb" "$pmb" "$t" "$rss" "$m"
done
