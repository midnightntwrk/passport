"""Report the Compact cost model for every proof-bearing export in each build."""
import argparse
import csv
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("zkir", type=Path)
parser.add_argument("--current", required=True, nargs="+", type=Path)
parser.add_argument("--shared", nargs="+", type=Path, default=[])
args = parser.parse_args()
writer = csv.writer(sys.stdout, lineterminator="\n")
writer.writerow(["variant", "circuit", "k", "rows", "table_rows", "unusable_rows", "zkir_sha256"])
for variant, builds in (("current", args.current), ("shared", args.shared)):
    for build in builds:
        info = json.loads((build / "compiler/contract-info.json").read_text())
        expected = {c["name"] for c in info["circuits"] if c["proof"]}
        files = sorted((build / "zkir").glob("*.zkir"))
        if not expected or expected != {p.stem for p in files}:
            raise SystemExit(f"Emitted IR differs from the proof-bearing export list in {build}")
        for ir in files:
            output = subprocess.check_output(
                [str(args.zkir), "mock-compile", "-v", str(ir)],
                stderr=subprocess.STDOUT, text=True,
            )
            model = re.search(r"CircuitModel \{ k: (\d+), rows: (\d+), table_rows: (\d+), nb_unusable_rows: (\d+)", output)
            if not model:
                raise SystemExit(f"No verbose cost model for {ir}: {output}")
            writer.writerow([variant, ir.stem, *model.groups(), hashlib.sha256(ir.read_bytes()).hexdigest()])
