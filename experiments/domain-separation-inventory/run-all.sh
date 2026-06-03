#!/usr/bin/env bash
#
# Domain-Separation Inventory — scanner.
#
# Enumerates every hash / commit primitive call site and every domain-tag
# literal across (1) the Midnight ledger Rust source and (2) the Compact
# standard library, and checks whether those tags are declared in the
# architecture / MIP corpus.
#
# The raw output below is the evidence; INVENTORY.md is the curated, manually
# verified table (tag <-> site association and untagged classification need a
# human read), and FINDINGS.md is the verdict. Source commits are pinned in
# FINDINGS.md. Override paths via env vars.
#
#   LEDGER_DIR=... COMPACT_DIR=... SPEC_DIRS="d1 d2" ./run-all.sh > scan-output.txt
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEDGER_DIR="${LEDGER_DIR:-$HOME/.cargo/git/checkouts/midnight-ledger-b2f9c59d942dfdca/dfb450d}"
COMPACT_DIR="${COMPACT_DIR:-$HOME/work/midnight/compactc}"
SPEC_DIRS="${SPEC_DIRS:-$ROOT/tmp/midnight-architecture $ROOT/tmp/MIPs}"

command -v rg >/dev/null || { echo "ripgrep (rg) is required" >&2; exit 1; }

PRIMS='\b(persistent_hash|transient_hash|persistent_commit|transient_commit|hash_to_field)\s*\('
RTAGS='b"(midnight|mdn):[^"]*"'
CMS='persistentHash|transientHash|persistentCommit|transientCommit|persistent_hash|transient_hash|persistent_commit|degrade_to_transient|upgrade_from_transient'
CTAGS='"(mdn|midnight):[^"]*"|domain_sep'
SPECPAT='mdn:(lh|cc|cn|pk|dust)|midnight:(zswap|derive_token|schnorr|field_hash|hash-intent|hash-output|contract-update|binding-input|entry-point|kernel:nonce|dust:proof|sig-claim|csk|esk|dsk)|ni-pk\[v1\]'

echo "# Domain-separation scan — raw enumeration ($(date +%Y/%m/%d))"
echo "# ledger : $LEDGER_DIR"
echo "# compact: $COMPACT_DIR"
echo "# spec   : $SPEC_DIRS"
echo

echo "## [RUST] primitive call sites (src only)"
rg -n --type rust -g '**/src/**' -e "$PRIMS" "$LEDGER_DIR" | sed "s#$LEDGER_DIR/##" | sort

echo; echo "## [RUST] domain-tag byte literals (src only)"
rg -n --type rust -g '**/src/**' -e "$RTAGS" "$LEDGER_DIR" | sed "s#$LEDGER_DIR/##" | sort

echo; echo "## [COMPACT] stdlib primitives + tags"
rg -n -e "$CMS" -e "$CTAGS" "$COMPACT_DIR/compiler/standard-library.compact" | sed "s#$COMPACT_DIR/##"

echo; echo "## [S5] code tag strings found in the spec / MIP corpus (expect: none)"
rg -rni --no-heading -e "$SPECPAT" $SPEC_DIRS 2>/dev/null | sort || true
