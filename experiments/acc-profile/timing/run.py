"""Run a serial proof-time experiment against a local Midnight proof server."""
import argparse
import json
from pathlib import Path
import subprocess
from urllib.parse import urlsplit


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("mode", choices=("sweep", "raw", "rotations", "profiles", "shared-rotation"))
parser.add_argument("contract", type=Path, help="Reference contract, including node_modules and keyed account")
parser.add_argument("work", type=Path, help="Compiled probes and captured preimages")
parser.add_argument("output", type=Path, help="New JSONL file")
parser.add_argument("--server", default="http://127.0.0.1:16319")
args = parser.parse_args()
url = urlsplit(args.server)
if url.scheme != "http" or url.hostname not in {"127.0.0.1", "localhost", "::1"}:
    parser.error("The proof server must be a local HTTP endpoint")
if url.path not in ("", "/") or url.username or url.password or url.query or url.fragment:
    parser.error("Supply the proof server origin without a path or credentials")

contract = args.contract.resolve()
work = args.work.resolve()
account = contract / "contracts/managed/account"
k1 = work / "acc-profile-probe-k1"
p256 = work / "acc-profile-probe-p256"
rotation = "rotate_enc_key_with_"
profiled = "verify_webauthn_profiled"

# A group of three sweep observations reuses one Node process. Each member
# of an alternating pair is a separate request with its own fixture check.
if args.mode == "sweep":
    info = json.loads((account / "compiler/contract-info.json").read_text())
    names = sorted(c["name"] for c in info["circuits"] if c["proof"])
    rotations = [rotation + arm for arm in ("jubjub", "k256", "p256")]
    if not set(rotations).issubset(names):
        parser.error("Compiled reference account is missing rotation circuits")
    plan = [(k1, "verify_k1", "", 3)]
    plan += [(p256, name, "", 3) for name in ("verify_ecdsa", "verify_webauthn", profiled)]
    plan += [(account, name, "", 3) for name in rotations]
    plan += [(account, name, "", 1) for _ in range(2) for name in names if name not in rotations]
else:
    pairs = {
        "raw": [(k1, "verify_k1", "", 1), (p256, "verify_ecdsa", "", 1)],
        "rotations": [(account, rotation + arm, "", 1) for arm in ("k256", "p256")],
        "profiles": [(p256, profiled, "current", 1), (work / "acc-profile-probe-shared", profiled, "shared", 1)],
        "shared-rotation": [(account, rotation + "p256", "current", 1),
                            (work / "acc-profile-shared-rotation", rotation + "p256", "shared", 1)],
    }
    plan = pairs[args.mode] * 3

for artifact, name, _, _ in set(plan):
    paths = [artifact / "keys" / (name + ".prover"), artifact / "keys" / (name + ".verifier"),
             artifact / "zkir" / (name + ".bzkir"), work / "preimages" / (name + ".bin")]
    for file in paths:
        if not file.is_file() or not file.stat().st_size:
            parser.error(f"Missing or empty fixture or compiled artifact: {file}")

client = Path(__file__).with_name("request.mjs").resolve()
loader = contract / "node_modules/tsx/dist/loader.mjs"
args.output.touch(exist_ok=False)
completed = {}
for artifact, name, variant, count in plan:
    first = completed.get((name, variant), 0) + 1
    subprocess.run(["node", "--import", str(loader), str(client), str(contract), str(artifact),
                    str(work / "preimages"), str(args.output), args.server, name, variant,
                    str(first), str(count)], check=True)
    completed[name, variant] = first + count - 1
