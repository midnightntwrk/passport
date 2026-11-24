"""Run with python3 -O to ensure witness/archive guards survive optimisation."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("runner", Path(__file__).with_name("run-signed-bootstrap-constraints.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerSafetyTests(unittest.TestCase):
    @staticmethod
    def capture(root):
        for name in runner.REQUIRED_CAPTURE_INPUTS:
            source = root / name
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(b"original source")
        preimage = root / "preimages/activate_initial_passkey.bin"
        preimage.parent.mkdir(parents=True, exist_ok=True)
        preimage.write_bytes(b"original preimage")
        manifest = {"sha256": {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                               for name in runner.REQUIRED_CAPTURE_INPUTS},
                    "preimageSha256": hashlib.sha256(preimage.read_bytes()).hexdigest(),
                    "responseScalar": "7"}
        (root / "runtime-preimage.json").write_text(json.dumps(manifest))
        return manifest

    def test_runtime_and_preimage_integrity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = self.capture(root)
            source = root / "contracts/account.compact"
            preimage = root / "preimages/activate_initial_passkey.bin"
            self.assertEqual(runner.verify_runtime_evidence(root, root), manifest)
            source.write_bytes(b"changed source")
            with self.assertRaisesRegex(ValueError, "stale runtime evidence"):
                runner.verify_runtime_evidence(root, root)
            source.write_bytes(b"original source")
            preimage.write_bytes(b"changed preimage")
            with self.assertRaisesRegex(ValueError, "stale preimage"):
                runner.verify_runtime_evidence(root, root)

    def test_incomplete_capture_requires_recapture(self):
        mutations = [
            lambda m: m.pop("sha256"),
            lambda m: m["sha256"].pop("contracts/webauthn.compact"),
            lambda m: m["sha256"].update({"contracts/account.compact": "not available"}),
            lambda m: m["sha256"].update({"../unrelated": "a" * 64}),
            lambda m: m.update({"preimageSha256": "bad hash"}),
            lambda m: m.pop("responseScalar"),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                manifest = self.capture(root)
                mutate(manifest)
                (root / "runtime-preimage.json").write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, "recapture with WRITE_EVIDENCE=1"):
                    runner.verify_runtime_evidence(root, root)

    def test_missing_and_empty_inputs_require_recapture(self):
        for name in ["contracts/webauthn.compact", runner.REQUIRED_CAPTURE_INPUTS[-1],
                     "preimages/activate_initial_passkey.bin"]:
            for empty in [False, True]:
                with self.subTest(name=name, empty=empty), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    self.capture(root)
                    if empty:
                        (root / name).write_bytes(b"")
                    else:
                        (root / name).unlink()
                    with self.assertRaisesRegex(ValueError, "recapture with WRITE_EVIDENCE=1"):
                        runner.verify_runtime_evidence(root, root)

    def test_cli_refuses_incomplete_capture_without_traceback_under_optimisation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "runtime-preimage.json").write_text('{"sha256": {}}')
            result = subprocess.run([sys.executable, "-B", "-O", runner.__file__, "unused-zkir-repo",
                                     "--evidence-dir", str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("contracts/webauthn.compact", result.stderr)
            self.assertIn("recapture with WRITE_EVIDENCE=1", result.stderr)
            self.assertNotIn("Traceback", result.stderr)

    @staticmethod
    def archive(name, kind=tarfile.REGTYPE):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w") as archive:
            valid = tarfile.TarInfo("safe/file.txt")
            valid.size = 4
            archive.addfile(valid, io.BytesIO(b"safe"))
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = "../outside"
            archive.addfile(member)
        return data.getvalue()

    def test_unsafe_archive_rejected_before_any_extraction(self):
        for name, kind in [("../escape", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
                           ("link", tarfile.SYMTYPE), ("hardlink", tarfile.LNKTYPE),
                           ("device", tarfile.CHRTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                work = Path(tmp)
                with self.assertRaises(ValueError):
                    runner.extract_safe_archive(self.archive(name, kind), work)
                self.assertEqual(list(work.iterdir()), [])

    def test_regular_archive_extracts(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            runner.extract_safe_archive(self.archive("empty.txt"), work)
            self.assertEqual((work / "safe/file.txt").read_bytes(), b"safe")
            self.assertEqual((work / "empty.txt").read_bytes(), b"")

    def test_metadata_rewrite_requires_exactly_one_match(self):
        valid = 'name = "midnight-zkir"\nversion = "3.1.0"\nname = "midnight-zkir-wasm"\nversion = "3.0.0-rc.2"'
        self.assertEqual(runner.patch_lockfile_metadata(valid).count('version = "3.1.0-rc.1"'), 2)
        for invalid in ["", valid + valid]:
            with self.assertRaisesRegex(ValueError, "unexpected upstream metadata"):
                runner.patch_lockfile_metadata(invalid)


if __name__ == "__main__":
    unittest.main()
