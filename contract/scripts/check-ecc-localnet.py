#!/usr/bin/env python3
"""Check local integration prerequisites; never send a transaction or read keys."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
from datetime import datetime, timezone

root = Path(__file__).resolve().parent.parent
services = []
for service, port in (("node", 9944), ("indexer", 8088), ("proof-server", 6300)):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            services.append({"service": service, "port": port, "reachable": True})
    except OSError as error:
        services.append({"service": service, "port": port, "reachable": False,
                         "error": str(error)})

result = {
    "runAt": datetime.now(timezone.utc).isoformat(),
    "probeSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    "composeSha256": hashlib.sha256((root / "infra/docker-compose.yml").read_bytes()).hexdigest(),
    "scope": "Local TCP availability only; reachability does not establish service health or transaction acceptance",
    "services": services,
    "containerCommands": {name: shutil.which(name) for name in ("docker", "podman")},
    "containerSockets": {path: Path(path).exists() for path in (
        "/var/run/docker.sock", f"/run/user/{os.getuid()}/docker.sock", "/run/podman/podman.sock")},
    "nodeSubmission": "not attempted",
    "status": "ports reachable; live transaction test still required" if all(
        service["reachable"] for service in services) else "blocked: local integration services unavailable",
}
destination = root / "evidence/ecc-validation/localnet.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
