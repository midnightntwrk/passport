#!/usr/bin/env python3
"""Test compiled Passport inputs inside an isolated copy of its exact ZKIR dependency.

Usage: python3 scripts/run-ecc-constraints.py /path/to/midnight-zkir
The supplied repository must contain the pinned commit. Its branch is not changed.
Run npm run compile:ecc and npm run test:ecc first. Uses the upstream Cargo.lock.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

SHA = "e82d81d25aabcc5f5092e2bd559083487f577914"
ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("zkir_repo", type=Path)
parser.add_argument("--offline", action="store_true")
parser.add_argument("--full-proofs", action="store_true", help="generate/verify device signature proofs with local test-only KZG parameters")
parser.add_argument("--witness-only", action="store_true", help="run unchecked witness injection checks instead of the original input suite")
args = parser.parse_args()
runtime_path = ROOT / "evidence/ecc-validation/runtime.json"
assert runtime_path.exists(), "run npm run test:ecc first"
runtime = json.loads(runtime_path.read_text())
assert runtime["completed"], "runtime suite did not finish; run npm run test:ecc"
expected_files = {
    **{ROOT / "contracts" / name: digest for name, digest in runtime["sourceSha256"].items()},
    ROOT / "contracts/managed/account/contract/index.js": runtime["generatedSha256"],
    ROOT / "package-lock.json": runtime["lockfileSha256"],
    ROOT / "src/tests/ecc-validation.ts": runtime["testSourceSha256"],
    **{ROOT / "src" / name: digest for name, digest in runtime["clientSourceSha256"].items()},
    **{ROOT / "contracts/managed/account/zkir" / f"{name}.zkir": digest for name, digest in runtime["zkirSha256"].items()},
}
for path, expected in expected_files.items():
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, f"stale runtime evidence for {path}; recompile and rerun"
archive = subprocess.check_output(["git", "-C", str(args.zkir_repo), "archive", SHA])
with tempfile.TemporaryDirectory(prefix="passport-ecc-zkir-") as tmp:
    work = Path(tmp)
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        source.extractall(work, filter="data")
    # The release commit bumps these two manifests without refreshing its lock.
    # Correct ONLY workspace package metadata; retain every dependency pin.
    lock = work / "Cargo.lock"
    text = lock.read_text()
    for name, old in [("midnight-zkir", "3.1.0"), ("midnight-zkir-wasm", "3.0.0-rc.2")]:
        before = f'name = "{name}"\nversion = "{old}"'
        assert text.count(before) == 1, f"unexpected upstream lock metadata for {name}"
        text = text.replace(before, f'name = "{name}"\nversion = "3.1.0-rc.1"')
    lock.write_text(text)
    lib = work / "zkir/src/lib.rs"
    test_source = (ROOT / "src/tests/ecc-constraints.rs").read_text()
    lib.write_text(lib.read_text() + "\n#[cfg(test)]\nmod passport_ecc_tests {\n" + test_source + "\n}\n")
    witness_source = (ROOT / "src/tests/ecc-malicious-witnesses.rs").read_text()
    lib.write_text(lib.read_text() + "\n#[cfg(test)]\nmod passport_witness_tests {\n" + witness_source + "\n}\n")
    command = ["cargo", "+1.95", "test", "--locked", "--manifest-path", str(work / "Cargo.toml"),
               "--target-dir", str(Path(tempfile.gettempdir()) / "passport-ecc-zkir-target"),
               "-p", "midnight-zkir", "--lib"]
    if args.offline:
        command.append("--offline")
    test = "passport_witness_tests::passport_malicious_witnesses" if args.witness_only else "passport_ecc_tests::passport_compiled_contract_inputs"
    command += [test, "--", "--nocapture"]
    environment = dict(os.environ, PASSPORT_CONTRACT_ROOT=str(ROOT), PASSPORT_ECC_FULL_PROOFS="1" if args.full_proofs else "0")
    exit_code = subprocess.call(command, env=environment)
    if exit_code == 0:
        filename = "malicious-witnesses.json" if args.witness_only else "constraints.json"
        destination = ROOT / "evidence/ecc-validation" / filename
        result = json.loads(destination.read_text())
        source = witness_source if args.witness_only else test_source
        result["testSourceSha256"] = hashlib.sha256(source.encode()).hexdigest()
        result["runnerSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        result["runtimeEvidenceSha256"] = hashlib.sha256(runtime_path.read_bytes()).hexdigest()
        result["zkirSha256"] = runtime["zkirSha256"]
        destination.write_text(json.dumps(result, indent=2) + "\n")
    raise SystemExit(exit_code)
