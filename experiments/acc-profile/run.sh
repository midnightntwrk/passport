#!/usr/bin/env bash
# Compile and size the account before collecting sequential loopback proof times.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: run.sh [--sizes-only] [--prefixes] [--sharing] [--out NEW_DIRECTORY]

Default: measure all account and verifier circuit sizes, then run the inventory
sweep and paired raw-signature and rotation comparisons.
  --sizes-only  Skip keys, Node fixtures, Docker and timing.
  --prefixes    Also measure ordered verifier and rotation instruction prefixes.
  --sharing     Also measure the common-encoding WebAuthn probe and rotation.
  --out DIR     Save measurements in a new directory (default: a temp directory).

COMPACT_DIR      Compact 0.35.0 directory containing compactc and zkir-v3.
ACC_CONTRACT_DIR Source contract/ (default: this checkout's contract/).
ACC_KEYED_ACCOUNT  Optional fully keyed managed/account directory to reuse.
MIDNIGHT_PP      Host public parameter cache (default: XDG/home Midnight cache).
TMPDIR           Parent directory for temporary builds and private test fixtures.
HELP
}

fail() { echo "$*" >&2; exit 1; }
sizes_only=false
prefixes=false
sharing=false
output=
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --sizes-only) sizes_only=true ;;
    --prefixes) prefixes=true ;;
    --sharing) sharing=true ;;
    --out) [[ $# -ge 2 && -n "$2" ]] || fail "--out needs a directory"; output=$2; shift ;;
    *) usage >&2; fail "Unknown argument: $1" ;;
  esac
  shift
done

bench=$(cd "$(dirname "$0")" && pwd -P)
source_contract=$(cd "${ACC_CONTRACT_DIR:-$bench/../../contract}" && pwd -P)
[[ -f "$source_contract/contracts/account.compact" ]] || fail "Missing account.compact in $source_contract/contracts"

if [[ -z "${COMPACT_DIR:-}" ]]; then
  for candidate in "$HOME"/.compact/versions/0.35.0/*/compactc; do
    if [[ -x "$candidate" ]]; then COMPACT_DIR=$(dirname "$candidate"); break; fi
  done
fi
if [[ -z "${COMPACT_DIR:-}" ]] && command -v compactc >/dev/null; then
  COMPACT_DIR=$(dirname "$(command -v compactc)")
fi
[[ -n "${COMPACT_DIR:-}" ]] || fail "Set COMPACT_DIR to the Compact 0.35.0 toolchain directory."
toolchain=$(cd "$COMPACT_DIR" && pwd -P)
[[ -x "$toolchain/compactc" && -x "$toolchain/zkir-v3" ]] || fail "Missing compactc or zkir-v3 in $toolchain"
version=$("$toolchain/compactc" --version)
[[ "$version" == 0.35.0 || "$version" == '0.35.0 '* ]] || fail "Expected Compact 0.35.0, got $version"

if ! "$sizes_only"; then
  command -v node >/dev/null || fail "Install Node.js 22 or later."
  docker info >/dev/null
fi
if [[ -n "$output" ]]; then
  mkdir "$output"
else
  output=$(mktemp -d "${TMPDIR:-/tmp}/acc-results.XXXXXXXX")
fi
output=$(cd "$output" && pwd -P)
echo "Writing benchmark results to $output"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/acc-work.XXXXXXXX")
scratch=$(cd "$scratch" && pwd -P)
container=
cleanup() {
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null || true; fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

contract="$scratch/contract"
account="$contract/contracts/managed/account"
k1="$scratch/acc-profile-probe-k1"
p256="$scratch/acc-profile-probe-p256"
shared_probe="$scratch/acc-profile-probe-shared"
shared_rotation="$scratch/acc-profile-shared-rotation"
mkdir -p "$contract/contracts/managed"
cp "$source_contract"/contracts/*.compact "$contract/contracts/"
# Ensure the compiler launches the zkir version from the selected release.
export PATH="$toolchain:$PATH"
compile() {
  echo "Compiling $(basename "$1") to $2" >&2
  if "$sizes_only"; then
    "$toolchain/compactc" --feature-zkir-v3 --skip-zk "$1" "$2"
  else
    "$toolchain/compactc" --feature-zkir-v3 "$1" "$2"
  fi
}

if ! "$sizes_only" && [[ -n "${ACC_KEYED_ACCOUNT:-}" ]]; then
  cached=$(cd "$ACC_KEYED_ACCOUNT" && pwd -P)
  "$toolchain/compactc" --feature-zkir-v3 --skip-zk "$contract/contracts/account.compact" "$scratch/source-account"
  # Only reuse keys paired with exactly the current circuit IR and export set.
  diff -q "$scratch/source-account/compiler/contract-info.json" "$cached/compiler/contract-info.json"
  for ir in "$scratch/source-account"/zkir/*.zkir; do
    name=$(basename "$ir" .zkir)
    cmp "$ir" "$cached/zkir/$name.zkir"
    [[ -s "$cached/zkir/$name.bzkir" && -s "$cached/keys/$name.prover" && -s "$cached/keys/$name.verifier" ]] ||
      fail "Missing binary IR or keys for $name in $cached"
  done
  # Keep the keyed executable in the scratch package so Node resolves its
  # runtime imports there, even if the external artifact directory is standalone.
  mkdir "$account"
  cp -R "$cached/contract" "$cached/compiler" "$account/"
  ln -s "$cached/zkir" "$account/zkir"
  ln -s "$cached/keys" "$account/keys"
else
  compile "$contract/contracts/account.compact" "$account"
fi
compile "$bench/primitives/verify-k1.compact" "$k1"
compile "$contract/contracts/probe-p256.compact" "$p256"
models=(--current "$account" "$k1" "$p256")
if "$sharing"; then
  python3 "$bench/profile-sharing/emit.py" "$contract" "$scratch/shared-src"
  compile "$scratch/shared-src/probe-p256.compact" "$shared_probe"
  compile "$scratch/shared-src/account.compact" "$shared_rotation"
  models+=(--shared "$shared_probe" "$shared_rotation")
fi
python3 "$bench/models.py" "$toolchain/zkir-v3" "${models[@]}" > "$output/models.csv"
if "$prefixes"; then
  python3 "$bench/primitives/profile.py" --zkir "$toolchain/zkir-v3" \
    "$k1/zkir/verify_k1.zkir" "$p256/zkir/verify_ecdsa.zkir" \
    "$p256/zkir/verify_webauthn.zkir" "$p256/zkir/verify_webauthn_profiled.zkir" \
    "$account/zkir/rotate_enc_key_with_k256.zkir" "$account/zkir/rotate_enc_key_with_p256.zkir" \
    > "$output/prefix-costs.csv"
fi
if "$sizes_only"; then echo "Circuit measurements are in $output"; exit 0; fi

cp -R "$source_contract/src" "$contract/"
cp "$source_contract"/{package.json,package-lock.json,tsconfig.json} "$contract/"
ln -s "$source_contract/../experiments" "$scratch/experiments"
if [[ -f "$source_contract/node_modules/tsx/dist/loader.mjs" ]]; then
  ln -s "$source_contract/node_modules" "$contract/node_modules"
else
  npm ci --prefix "$contract"
fi
node --import "$contract/node_modules/tsx/dist/loader.mjs" "$bench/fixtures/generate.mjs" "$contract" "$scratch"
if "$sharing"; then
  ln -s "$contract/node_modules" "$scratch/node_modules"
  echo '{"type":"module"}' > "$scratch/package.json"
  node --import "$contract/node_modules/tsx/dist/loader.mjs" "$bench/profile-sharing/check.mjs" \
    "$contract" "$p256" "$shared_probe"
fi

params=${MIDNIGHT_PP:-${XDG_CACHE_HOME:-$HOME/.cache}/midnight/zk-params}
[[ -d "$params" ]] || fail "Missing public parameter cache: $params. Set MIDNIGHT_PP to the cache used for key generation."
params=$(cd "$params" && pwd -P)
while IFS= read -r k; do
  [[ -s "$params/bls_midnight_2p$k" ]] || fail "Missing parameter bls_midnight_2p$k in $params."
done < <(awk -F, 'NR>1 {print $3}' "$output/models.csv" | sort -nu)
image=midnightntwrk/proof-server:9.0.0-rc.8@sha256:2666c7bd7b4517f8ad135565387f98d14347a9ac715c6c466d4a8a852b545ecf
container=$(docker run -d --cap-drop=ALL --security-opt=no-new-privileges \
  -p 127.0.0.1::6300 -v "$params:/params:ro" \
  -e MIDNIGHT_PP=/params -e MIDNIGHT_PROOF_SERVER_NO_FETCH_PARAMS=true "$image")
server="http://$(docker port "$container" 6300/tcp)"
for ((attempt=0; attempt<120; attempt++)); do
  if curl -fsS --max-time 2 "$server/ready" >/dev/null 2>&1; then break; fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]]; then
    docker logs --tail 10 "$container" >&2
    fail "Proof server exited during startup."
  fi
  sleep 1
done
curl -fsS --max-time 3 "$server/ready" >/dev/null || fail "Proof server readiness timed out."

run_series() {
  python3 "$bench/timing/run.py" "$1" "$contract" "$scratch" "$output/$1.jsonl" --server "$server"
}
run_series sweep
run_series raw
run_series rotations
if "$sharing"; then
  run_series profiles
  run_series shared-rotation
fi
python3 "$bench/summarize.py" "$output" > "$output/results.csv"
echo "Benchmark results: $output/results.csv"
