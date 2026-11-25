"""Measure synthesis of ordered prefixes of unmodified Compact 0.35 verifier IR.

Usage: python3 profile.py --zkir /path/to/zkir-v3 PATH.zkir [PATH.zkir ...]
Only runs the mock cost model. CSV output includes cumulative and marginal rows.
"""

import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

# Prefix lengths count original instructions. The file digest guards the labels
# against changes in compiler lowering or source. A standalone verifier keeps
# the three transcript operations for its public write at every step. A rotation keeps its ordered
# transcript through the cut, because later ledger writes depend on earlier work.
RAW_K1 = [
    (0, "input and write baseline"),
    (4, "constrain digest and convert zero to scalar"),
    (5, "compute zero times G"),
    (8, "compare public key to identity"),
    (73, "convert big-endian digest to scalar"),
    (76, "inverse and two scalar multiplications"),
    (77, "compute u1 times G"),
    (78, "compute u2 times public key"),
    (79, "add resulting points"),
    (86, "extract x, reduce and compare"),
]
RAW_P256 = [(0, RAW_K1[0][1]), (12, "constrain digest and check nonzero r and s")] + [
    (index + 10, "convert zero to scalar" if index == 4 else stage)
    for index, stage in RAW_K1[1:]
]
PROBES = {
    "verify_k1": ("a6b50ae2deeb34742b907cf205c3e3f08008e491ff614e7bd9f97c16d0bedbad", RAW_K1),
    "verify_ecdsa": ("09a5d54614db8f7db71b36d8a3ec89635ab127639342a0fa3d6f6e7ec78bbb19", RAW_P256),
    "verify_webauthn": ("bfd2ea3be6fb13ec7d242d27cf4def5bac7b0671933bc6c7b46e34912dc09dad", [
        (0, "input and write baseline"),
        (2846, "RP and flag checks, origin validation and encode challenge"),
        (2847, "hash 134-byte clientDataJSON"),
        (2850, "hash signed 69-byte message and unpack"),
        (2944, "verify P-256"),
    ]),
    "verify_webauthn_profiled": ("dd92909e3cb4a1cb59b215ec7cd286aeb3c6e64ae14d6270a03ab9cb16366d11", [
        (0, "input and write baseline"),
        (4785, "RP and flag checks, prepare 243-byte JSON path"),
        (4786, "hash 243-byte clientDataJSON"),
        (9262, "prepare 134-byte JSON path"),
        (9263, "hash 134-byte clientDataJSON"),
        (9268, "select digest, hash signed 69-byte message and unpack"),
        (9362, "verify P-256"),
    ]),
    "rotate_enc_key_with_k256": ("7f22b917111f9de789a5da7d7b2c1182c8c5578b9d06bb7c11b5339ac829052f", [
        (0, "input baseline"),
        (23, "construct rotation challenge"),
        (94, "validate key, update device entry and check envelope id"),
        (101, "compute and select envelope hashes"),
        (185, "verify k1"),
        (214, "finish state update"),
    ]),
    "rotate_enc_key_with_p256": ("83e512fd2f42b399a038901b907714320b3cd6bd95207578c7c148edb407a118", [
        (0, "input baseline"),
        (28, "construct rotation challenge"),
        (52, "derive and check device entry"),
        (9312, "compute profiled WebAuthn digest"),
        (9406, "verify P-256"),
        (9464, "finish rolling entry and state update"),
    ]),
}


def profile(path, executable, writer, work):
    digest, stages = PROBES[path.stem]
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise ValueError(f"IR differs from the measured revision: {path}")
    ir = json.loads(path.read_text())
    instructions = ir["instructions"]
    suffix = instructions[-3:] if path.stem.startswith("verify_") else []
    assert all(op["op"] == "impact" for op in suffix)
    assert stages[-1][0] + len(suffix) == len(instructions)
    previous = 0
    for count, label in stages:
        ir["instructions"] = instructions[:count] + suffix
        work.write_text(json.dumps(ir))
        result = subprocess.run(
            [executable, "mock-compile", "-v", str(work)],
            check=True, capture_output=True, text=True,
            env={**os.environ, "RAYON_NUM_THREADS": "1"},
        )
        match = re.search(
            r"CircuitModel \{ k: (\d+), rows: (\d+), table_rows: (\d+), nb_unusable_rows: (\d+)",
            result.stdout + result.stderr,
        )
        if not match:
            raise ValueError(f"Could not read ZKIR cost model for {path}, stage {label}")
        k, rows, tables, unusable = map(int, match.groups())
        writer.writerow([path.stem, count, label, k, rows, rows - previous, tables, unusable])
        sys.stdout.flush()
        previous = rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zkir", required=True, type=Path)
    parser.add_argument("circuits", nargs="+", type=Path)
    args = parser.parse_args()
    writer = csv.writer(sys.stdout, lineterminator="\n")
    writer.writerow(["circuit", "prefix_length", "stage", "k", "rows", "delta_rows",
                     "table_rows", "unusable_rows"])
    with tempfile.TemporaryDirectory() as directory:
        for circuit in args.circuits:
            profile(circuit, args.zkir, writer, Path(directory) / "slice.zkir")


if __name__ == "__main__":
    main()
