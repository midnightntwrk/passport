#!/usr/bin/env bash
# Fresh runtime outputs for TypeScript imports, with an explicit key scope.
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-runtime-plus-fixture-key}"
case "$mode" in runtime-plus-fixture-key|keyed) ;; *) echo "Unknown compile mode: $mode" >&2; exit 2 ;; esac
if [[ -n "${CI_EVIDENCE_DIR:-}" ]]; then
  mkdir -p "$CI_EVIDENCE_DIR"
  printf '%s\n' "$mode" > "$CI_EVIDENCE_DIR/compile-mode.txt"
fi
compiler="${COMPACTC:-compactc}"
zkir="${ZKIR_BIN:-zkir-v3}"
version="$("$compiler" --version)"
[[ "$version" = 0.35.0 || "$version" = '0.35.0 '* ]] || { echo "Expected Compact 0.35.0, got $version" >&2; exit 1; }
[[ ! -L contracts/managed ]] || { echo 'Refusing symlinked managed output directory' >&2; exit 1; }
mkdir -p contracts/managed
for name in account control faucet probe-block-time probe-p256 probe-grant-caller; do
  rm -rf "contracts/managed/$name"
  flags=()
  if [[ "$name" != probe-grant-caller ]]; then flags+=(--feature-zkir-v3); fi
  if [[ "$mode" = runtime-plus-fixture-key ]]; then flags+=(--skip-zk); fi
  # Preserve the existing package compile flags, including the caller probe.
  "$compiler" "${flags[@]}" "contracts/$name.compact" "contracts/managed/$name"
  test -s "contracts/managed/$name/contract/index.js"
  test -s "contracts/managed/$name/compiler/contract-info.json"
done
if [[ "$mode" = runtime-plus-fixture-key ]]; then
  # The unchanged durable-change SDK test constructs an unproven transaction
  # against this real verifier key. It mocks proving and does not verify a proof.
  base=contracts/managed/account
  circuit=withdraw_shielded_with_jubjub
  test -s "$base/zkir/$circuit.zkir"
  mkdir -p "$base/keys"
  "$zkir" compile "$base/zkir/$circuit.zkir" "$base/keys/$circuit.prover" "$base/keys/$circuit.verifier"
  test -s "$base/keys/$circuit.verifier"
  test -s "$base/keys/$circuit.prover"
fi
