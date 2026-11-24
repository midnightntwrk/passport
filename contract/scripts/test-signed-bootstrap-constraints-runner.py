"""Run with python3 -O to ensure witness/archive guards survive optimisation."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("runner", Path(__file__).with_name("run-signed-bootstrap-constraints.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerSafetyTests(unittest.TestCase):
    def test_runtime_and_preimage_integrity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "preimages").mkdir()
            source = root / "account.compact"
            source.write_bytes(b"original source")
            preimage = root / "preimages/activate_initial_passkey.bin"
            preimage.write_bytes(b"original preimage")
            manifest = {"sha256": {source.name: hashlib.sha256(source.read_bytes()).hexdigest()},
                        "preimageSha256": hashlib.sha256(preimage.read_bytes()).hexdigest()}
            (root / "runtime-preimage.json").write_text(json.dumps(manifest))
            self.assertEqual(runner.verify_runtime_evidence(root, root), manifest)
            source.write_bytes(b"changed source")
            with self.assertRaisesRegex(ValueError, "stale runtime evidence"):
                runner.verify_runtime_evidence(root, root)
            source.write_bytes(b"original source")
            preimage.write_bytes(b"changed preimage")
            with self.assertRaisesRegex(ValueError, "stale preimage"):
                runner.verify_runtime_evidence(root, root)

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
