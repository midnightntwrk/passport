#!/usr/bin/env python3
"""Sequential, resumable paired benchmark. Run after compare --mutations."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "target/release/project-custody-measure"


def input_hashes():
    paths = list((ROOT / "artifacts/minocrab").glob("*.zkir"))
    paths += list((ROOT / "artifacts/preimages").glob("*/*.preimage"))
    paths += list((ROOT / "reference/contracts/managed/account/zkir").glob("*.zkir"))
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if args.iterations < 1:
        parser.error("iterations must be positive")
    evidence = ROOT / "evidence"
    evidence.mkdir(exist_ok=True)
    gate = json.loads((evidence / "equivalence.json").read_text())
    assert gate["input_and_witness_mutations"] > 0, "run compare --mutations first"
    assert gate["binary_sha256"] == hashlib.sha256(BIN.read_bytes()).hexdigest(), "binary changed; rerun compare --mutations"
    costs = json.loads(subprocess.check_output([BIN, "costs"], text=True))
    (evidence / "costs.json").write_text(json.dumps(costs, indent=2) + "\n")
    assert input_hashes() == gate["input_sha256"], "circuit or preimage changed; rerun compare --mutations"
    # Outputs serialize as type strings, unlike the named input objects.
    # Compare the complete type arrays independently of the Rust ABI gate.
    for native in (ROOT / "artifacts/minocrab").glob("*.zkir"):
        candidate = json.loads(native.read_text())
        reference = json.loads((ROOT / "reference/contracts/managed/account/zkir" / native.name).read_text())
        assert candidate["outputs"] == reference["outputs"], f"output ABI mismatch: {native.name}"
    priority = "withdraw_unshielded_with_grant_k256"
    names = sorted({row["circuit"] for row in costs}, key=lambda name: (name != priority, name))
    provenance = {
        "platform": platform.platform(), "machine": platform.machine(),
        "cpu": subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip() if platform.system() == "Darwin" else platform.processor(),
        "rayon_threads": os.environ.get("RAYON_NUM_THREADS", "default"),
        "iterations": args.iterations, "warmup_proofs": 1,
        "binary_sha256": hashlib.sha256(BIN.read_bytes()).hexdigest(),
        "cargo_lock_sha256": hashlib.sha256((ROOT / "Cargo.lock").read_bytes()).hexdigest(),
        "input_sha256": input_hashes(),
        "equivalence_sha256": hashlib.sha256((evidence / "equivalence.json").read_bytes()).hexdigest(),
    }
    output = evidence / "benchmark.json"
    previous = json.loads(output.read_text()) if args.resume and output.exists() else None
    if previous:
        assert previous["configuration"] == provenance, "configuration changed; start a fresh benchmark"
    report = previous or {"configuration": provenance, "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "measurements": []}
    done = {(r["circuit"], r["side"]) for r in report["measurements"]}
    for i, name in enumerate(names):
        # Alternate which compiler goes first; no competing proof jobs.
        for side in (["compactc", "minocrab"] if i % 2 == 0 else ["minocrab", "compactc"]):
            if (name, side) in done:
                continue
            print(f"{i + 1}/{len(names)} {name} {side}", flush=True)
            row = json.loads(subprocess.check_output([BIN, "measure", name, side, str(args.iterations)], text=True))
            assert input_hashes() == provenance["input_sha256"], "circuit or preimage changed during measurement"
            report["measurements"].append(row)
            output.write_text(json.dumps(report, indent=2) + "\n")
    report["completed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    output.write_text(json.dumps(report, indent=2) + "\n")
    table = ["# Account custody: Compact / Minocrab", "", "Release build, one warm-up proof, median of measured samples. Verification is cryptographic proof verification, excluding ledger replay and transaction validation.", "", "Complete funded transaction bytes have not been measured. Proof bytes below must not be interpreted as transaction size.", "", "| Circuit | k C/M | Rows C/M | Prove s C/M | Verify ms C/M | Proof bytes C/M |", "|---|---|---|---|---|---|"]
    by_key = {(r["circuit"], r["side"]): r for r in report["measurements"]}
    for name in names:
        a, b = (by_key[(name, side)] for side in ["compactc", "minocrab"])
        table.append(f"| {name} | {a['k']}/{b['k']} | {a['rows']}/{b['rows']} | {statistics.median(a['prove_s']):.3f}/{statistics.median(b['prove_s']):.3f} | {1000 * statistics.median(a['verify_s']):.2f}/{1000 * statistics.median(b['verify_s']):.2f} | {a['proof_bytes']}/{b['proof_bytes']} |")
    (evidence / "report.md").write_text("\n".join(table) + "\n")


if __name__ == "__main__":
    main()
