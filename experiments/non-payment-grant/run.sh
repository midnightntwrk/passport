#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -n "${COMPACTC:-}" ]]; then
  compiler=("$COMPACTC")
else
  compiler=(compact compile +0.36.1)
fi
version="$("${compiler[@]}" --version)"
[[ "$version" =~ (^|[[:space:]])0\.36\.1([[:space:]]|$) ]] || { echo "Expected Compact 0.36.1, got $version" >&2; exit 1; }
for contract in account registry; do
  "${compiler[@]}" "contracts/$contract.compact" "managed/$contract"
done
node probe.mjs
