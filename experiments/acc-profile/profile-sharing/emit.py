"""Emit the experimental WebAuthn probe and P-256 account rotation in a new directory."""

import argparse
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("contract", type=Path, help="Passport contract directory")
    parser.add_argument("output", type=Path, help="New directory for the experimental Compact sources")
    args = parser.parse_args()
    source = args.contract.resolve() / "contracts"
    output = args.output.resolve()
    if output.exists():
        parser.error(f"Output already exists: {output}")

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as temp:
        work = Path(temp) / "shared"
        work.mkdir()
        shutil.copyfile(source / "webauthn.compact", work / "webauthn.compact")
        patch = Path(__file__).with_name("share-encoding.patch").resolve()
        subprocess.run(["patch", "-s", "-F", "0", "-i", patch, "webauthn.compact"], cwd=work, check=True)
        shutil.copyfile(source / "probe-p256.compact", work / "probe-p256.compact")
        # Restrict proof-bearing exports to avoid building 51 unrelated proving keys.
        # This produces the same rotation IR as the full experimental account.
        for name in ("account.compact", "account-p256.compact"):
            compact = (source / name).read_text()
            compact = re.sub(r"^export circuit (?!rotate_enc_key_with_p256\b)", "circuit ", compact, flags=re.M)
            (work / name).write_text(compact)
        work.rename(output)


if __name__ == "__main__":
    main()
