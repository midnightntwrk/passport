#!/usr/bin/env bash
# Determinism of key generation: repeated runs of one zkir binary, and the
# same ZKIR keyed by different zkir-v3 builds. The .prover file is a tagged,
# length-prefixed prover key; ledger-8 builds gzip-compressed it. The file
# bytes and the decompressed key (when compressed) are compared separately.
#
# Usage: ./determinism.sh <managed-contract-dir> <out-dir> <circuit>... -- <label=zkir-binary>...
# The first binary listed is run three times; the others once.
set -euo pipefail
MANAGED="$1"; OUT="$2"; shift 2
CIRCUITS=(); while [ "$1" != "--" ]; do CIRCUITS+=("$1"); shift; done; shift
BINS=("$@")
mkdir -p "$OUT"
inner_sha() { python3 - "$1" <<'PY'
import sys,zlib,hashlib
# ledger-9 zkir-v3 writes the prover key uncompressed (tag, length, key);
# ledger-8 gzip-compressed it. Report the decompressed digest when gzip is
# present, otherwise 'raw' (the file digest is then the key digest).
b=open(sys.argv[1],'rb').read(); i=b.find(b'\x1f\x8b\x08')
try:
    print(hashlib.sha256(zlib.decompress(b[i:],47)).hexdigest()[:16] if i>=0 else 'raw')
except Exception:
    print('raw')
PY
}
printf '%-40s %-16s %-3s %-16s %-16s %-6s %-6s %-7s %s\n' circuit build run file_sha inner_sha file inner vk time_s
for c in "${CIRCUITS[@]}"; do
  ref="$MANAGED/keys/$c.prover"
  rf=$(shasum -a 256 "$ref" | cut -c1-16); ri=$(inner_sha "$ref")
  printf '%-40s %-16s %-3s %-16s %-16s %-6s %-6s %-7s %s\n' "$c" compactc ref "$rf" "$ri" - - - -
  for spec in "${BINS[@]}"; do
    label="${spec%%=*}"; bin="${spec#*=}"
    runs=1; [ "$spec" = "${BINS[0]}" ] && runs=3
    for r in $(seq 1 $runs); do
      p="$OUT/$c.$label.$r.prover"; v="$OUT/$c.$label.$r.verifier"
      t0=$(python3 -c 'import time;print(time.time())')
      "$bin" compile "$MANAGED/zkir/$c.zkir" "$p" "$v" >/dev/null 2>&1
      t=$(python3 -c "import time;print(round(time.time()-$t0,2))")
      f=$(shasum -a 256 "$p" | cut -c1-16); i=$(inner_sha "$p")
      fe=$([ "$f" = "$rf" ] && echo same || echo DIFF); ie=$([ "$i" = "$ri" ] && echo same || echo DIFF)
      cmp -s "$MANAGED/keys/$c.verifier" "$v" && ve=same || ve=DIFF
      printf '%-40s %-16s %-3s %-16s %-16s %-6s %-6s %-7s %s\n' "$c" "$label" "$r" "$f" "$i" "$fe" "$ie" "$ve" "$t"
    done
  done
done
