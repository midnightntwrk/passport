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
# Reuse an installation when the manifest and installed versions match the lock.
if ! node --input-type=commonjs <<'JS'
const { packages } = require('./package-lock.json');
const { isDeepStrictEqual } = require('node:util');
const { dependencies } = require('./package.json');
if (!isDeepStrictEqual(dependencies, packages[''].dependencies)) process.exit(1);
try {
  for (const [path, entry] of Object.entries(packages)) {
    if (path && require('./' + path + '/package.json').version !== entry.version) process.exit(1);
  }
} catch {
  process.exit(1);
}
JS
then
  npm ci --no-audit --no-fund
fi
for contract in account registry; do
  "${compiler[@]}" "contracts/$contract.compact" "managed/$contract"
done
node probe.mjs
node probe.mjs mixed-order-grantee
node probe.mjs mixed-order-announcement
