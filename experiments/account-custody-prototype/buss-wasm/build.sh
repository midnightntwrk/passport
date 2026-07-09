#!/usr/bin/env bash
# Build the passport-buss-wasm package for Node consumers (tests + demo CLIs).
#
# blst (pulled in via midnight-curves) needs a wasm-capable C compiler.
# Apple's clang is not one, so on macOS we default to Homebrew LLVM
# (brew install llvm). Linux clang handles wasm32 out of the box.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ "$(uname -s)" == "Darwin" ]]; then
  export CC="${CC:-/opt/homebrew/opt/llvm/bin/clang}"
  export AR="${AR:-/opt/homebrew/opt/llvm/bin/llvm-ar}"
  [[ -x "$CC" ]] || { echo "ERROR: $CC not found — brew install llvm"; exit 1; }
fi

command -v wasm-pack >/dev/null 2>&1 || { echo "ERROR: wasm-pack not found — cargo install wasm-pack"; exit 1; }

wasm-pack build --target nodejs --out-dir pkg-node --release
wasm-pack build --target bundler --out-dir pkg-bundler --release
echo "pkg-node/ and pkg-bundler/ ready"
