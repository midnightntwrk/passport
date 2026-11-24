#!/usr/bin/env python3
"""Check signed-bootstrap witnesses in an isolated copy of the pinned ZKIR crate.

Run test:signed-bootstrap first. Supply a midnight-zkir Git checkout containing
the pinned revision; neither that checkout nor its library logic is modified.
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
args = parser.parse_args()
evidence = ROOT / "evidence/signed-bootstrap"
manifest_path = evidence / "runtime-preimage.json"
manifest = json.loads(manifest_path.read_text())
for name, expected in manifest["sha256"].items():
    assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == expected, f"stale runtime evidence: {name}"
preimage = evidence / "preimages/activate_initial_passkey.bin"
assert hashlib.sha256(preimage.read_bytes()).hexdigest() == manifest["preimageSha256"], "stale preimage"
archive = subprocess.check_output(["git", "-C", str(args.zkir_repo), "archive", SHA])
source = (ROOT / "src/tests/signed-bootstrap-constraints.rs").read_text()
with tempfile.TemporaryDirectory(prefix="passport-bootstrap-zkir-") as tmp:
    work = Path(tmp)
    with tarfile.open(fileobj=io.BytesIO(archive)) as upstream:
        # Python 3.9 on macOS lacks tarfile's newer extraction filters. Copy
        # only regular files/directories and reject links or escaping paths.
        members = upstream.getmembers()
        for member in members:
            path = Path(member.name)
            assert not path.is_absolute() and ".." not in path.parts, "unsafe archive path"
            assert member.isfile() or member.isdir(), "archive links/devices are not supported"
        for member in members:
            destination = work / member.name
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(upstream.extractfile(member).read())
                destination.chmod(member.mode & 0o777)
    # The upstream release changes package versions without updating these
    # two lockfile workspace labels. Every dependency pin remains unchanged.
    lock = work / "Cargo.lock"
    locked = lock.read_text()
    for name, old in [("midnight-zkir", "3.1.0"), ("midnight-zkir-wasm", "3.0.0-rc.2")]:
        before = f'name = "{name}"\nversion = "{old}"'
        assert locked.count(before) == 1, f"unexpected upstream metadata: {name}"
        locked = locked.replace(before, f'name = "{name}"\nversion = "3.1.0-rc.1"')
    lock.write_text(locked)
    lib = work / "zkir/src/lib.rs"
    lib.write_text(lib.read_text() + "\n#[cfg(test)]\nmod passport_bootstrap_tests {\n" + source + "\n}\n")
    command = ["cargo", "+1.95.0", "test", "--locked", "--manifest-path", str(work / "Cargo.toml"),
               "--target-dir", str(Path(tempfile.gettempdir()) / "passport-ecc-zkir-target"),
               "-p", "midnight-zkir", "--lib"]
    if args.offline:
        command.append("--offline")
    command += ["passport_bootstrap_tests::passport_signed_bootstrap_constraints", "--", "--nocapture"]
    env = dict(os.environ, PASSPORT_CONTRACT_ROOT=str(ROOT), RAYON_NUM_THREADS="2", CARGO_BUILD_JOBS="2")
    result = subprocess.call(command, env=env)
    if result == 0:
        destination = evidence / "constraints.json"
        report = json.loads(destination.read_text())
        report.update({
            "runtimeEvidenceSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            "testSourceSha256": hashlib.sha256(source.encode()).hexdigest(),
            "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "compiledFilesSha256": manifest["sha256"],
        })
        destination.write_text(json.dumps(report, indent=2) + "\n")
    raise SystemExit(result)
