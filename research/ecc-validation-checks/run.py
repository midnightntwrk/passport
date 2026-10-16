#!/usr/bin/env python3
"""Run pinned consumer-backend or Ledger API checks in an isolated temporary project."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
LEDGER_SHA = '67f9f97246339539af0091c4d8c6bc5ab236a191'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('mode', choices=['consumer', 'ledger'])
parser.add_argument('ledger_root', nargs='?')
# Split Cargo arguments explicitly, so --nocapture goes to the test binary.
argv = sys.argv[1:]
if '--' in argv:
    split = argv.index('--')
    cargo_args = argv[split + 1:]
    argv = argv[:split]
else:
    cargo_args = []
args = parser.parse_args(argv)
with tempfile.TemporaryDirectory(prefix='ecc-validation-') as temp:
    root = Path(temp)
    (root / 'src').mkdir()
    if args.mode == 'consumer':
        if args.ledger_root:
            parser.error('consumer mode takes no Ledger checkout')
        manifest = (HERE / 'Cargo.toml').read_text().replace('=0.8.3', '=0.8.2')
        source = HERE / 'src/lib.rs'
        lock = HERE / 'Cargo.consumer.lock'
        cargo = ['cargo']
    else:
        if not args.ledger_root:
            parser.error('ledger mode requires a clean checkout of ' + LEDGER_SHA)
        ledger = Path(args.ledger_root).resolve()
        sha = subprocess.check_output(['git', '-C', str(ledger), 'rev-parse', 'HEAD'], text=True).strip()
        dirty = subprocess.check_output(['git', '-C', str(ledger), 'status', '--porcelain', '--untracked-files=no'], text=True)
        if sha != LEDGER_SHA or dirty:
            parser.error('Ledger checkout must be clean and at ' + LEDGER_SHA)
        # JSON strings are also valid TOML basic strings for these absolute paths.
        manifest = '''[package]
name = "ecc-ledger-checks"
version = "0.1.0"
edition = "2024"
[dependencies]
transient-crypto = { package = "midnight-transient-crypto", path = PATH_CRYPTO }
serialize = { package = "midnight-serialize", path = PATH_SERIALIZE }
midnight-circuits = "=7.2.4"
midnight-curves = "=0.3.1"
midnight-proofs = "=0.8.2"
midnight-zk-stdlib = "=2.3.5"
group = "0.13"
ff = "0.13"
rand = "0.8"
'''.replace('PATH_CRYPTO', json.dumps(str(ledger / 'transient-crypto'))).replace('PATH_SERIALIZE', json.dumps(str(ledger / 'serialize')))
        source = HERE / 'ledger-api.rs'
        lock = HERE / 'Cargo.ledger.lock'
        cargo = ['cargo', '+1.95']
    (root / 'Cargo.toml').write_text(manifest)
    shutil.copyfile(source, root / 'src/lib.rs')
    shutil.copyfile(lock, root / 'Cargo.lock')
    # A target directory outside the temporary project permits reuse between runs.
    target = Path(tempfile.gettempdir()) / ('ecc-validation-target-' + args.mode)
    cmd = cargo + ['test', '--locked', '--manifest-path', str(root / 'Cargo.toml'), '--target-dir', str(target)]
    if cargo_args:
        cmd += ['--'] + cargo_args
    result = subprocess.run(cmd)
    sys.exit(result.returncode)
