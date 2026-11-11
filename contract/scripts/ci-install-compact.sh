#!/usr/bin/env bash
# Install the reviewed Linux release archive; do not use a mutable toolchain channel.
set -euo pipefail
: "${COMPACT_DIR:?Set COMPACT_DIR to a fresh toolchain directory}"
: "${CI_EVIDENCE_DIR:?Set CI_EVIDENCE_DIR to an absolute evidence directory}"
[[ "$COMPACT_DIR" = /* && "$CI_EVIDENCE_DIR" = /* ]]
[[ "$(uname -s)" = Linux && "$(uname -m)" = x86_64 ]]
[[ ! -e "$COMPACT_DIR" ]] || { echo 'COMPACT_DIR must not already exist' >&2; exit 1; }
mkdir -p "$COMPACT_DIR" "$CI_EVIDENCE_DIR"
archive=compactc_v0.35.0_x86_64-unknown-linux-musl.zip
checksum=70f22fb8209cc5a8504b2b3d91796cfdab2d71d88807ceef12fab87fed03bae2
url="https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v0.35.0/$archive"
curl --fail --location --retry 3 --connect-timeout 30 --max-time 300 "$url" -o "$COMPACT_DIR/$archive"
printf '%s  %s\n' "$checksum" "$COMPACT_DIR/$archive" | sha256sum --check -
unzip -q "$COMPACT_DIR/$archive" -d "$COMPACT_DIR"
version="$("$COMPACT_DIR/compactc" --version)"
[[ "$version" = 0.35.0 || "$version" = '0.35.0 '* ]]
printf '%s\n' "$version" > "$CI_EVIDENCE_DIR/compact-version.txt"
printf '%s\n' "$url" > "$CI_EVIDENCE_DIR/compact-release-url.txt"
printf '%s  %s\n' "$checksum" "$archive" > "$CI_EVIDENCE_DIR/compact-archive.sha256"
"$COMPACT_DIR/zkir-v3" --version > "$CI_EVIDENCE_DIR/zkir-version.txt"
if [[ -n "${GITHUB_PATH:-}" ]]; then printf '%s\n' "$COMPACT_DIR" >> "$GITHUB_PATH"; fi
if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'COMPACTC=%s/compactc\nZKIR_BIN=%s/zkir-v3\n' "$COMPACT_DIR" "$COMPACT_DIR" >> "$GITHUB_ENV"
fi
