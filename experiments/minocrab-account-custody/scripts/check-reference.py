#!/usr/bin/env python3
"""Fail if the pinned oracle sources or freshly compiled circuits have drifted."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "reference"
manifest = json.loads((ROOT / "provenance.json").read_text())
for name, expected in manifest["source_sha256"].items():
    actual = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"reference source changed: {name}")
zkir = ROOT / "contracts/managed/account/zkir"
actual = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in zkir.glob("*.zkir")}
if actual != manifest["zkir_sha256"]:
    raise SystemExit("reference circuit hashes differ; use the pinned source and compiler")
print(f"Pinned reference verified: {len(actual)} circuits")
