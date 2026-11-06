"""Portable archive checks, including corruption and extraction-boundary rejection."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT / "ai/danMCai/training/continuous"))
from transfer import pack, unpack, verify, digest  # noqa: E402


class TransferTests(unittest.TestCase):
    def fixture(self, root):
        run, source = root / "run", root / "source"
        for d in ["models", "champion", "learner", "shards"]:
            (run / d).mkdir(parents=True)
        source.mkdir()
        (source / "code.py").write_bytes(b"# frozen\r\n")
        import hashlib

        sha = hashlib.sha256(b"# frozen\n").hexdigest()
        (run / "config.json").write_text(json.dumps({"sourceSHA256": {"code.py": sha}}))
        (run / "status.json").write_text(json.dumps({"stoppedAt": "done", "running": []}))
        (run / "learner/status.json").write_text('{"state":"stopped"}')
        (run / "learner/checkpoint.pt").write_bytes(b"test checkpoint")
        (run / "shards/a00-000001000.x.i8").write_bytes(b"replay rows")
        for directory, file in [("models", "v000000001.onnx"), ("champion", "champion.onnx")]:
            path = run / directory / file
            path.write_bytes(b"fixture model")
            (
                run / directory / ("latest.json" if directory == "models" else "champion.json")
            ).write_text(
                json.dumps({"file": file, "version": "v000000001", "sha256": digest(path)})
            )
        return run, source

    def test_roundtrip_keeps_every_byte_and_mtime_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run, source = self.fixture(root)
            original = {p.relative_to(run): p.read_bytes() for p in run.rglob("*") if p.is_file()}
            archive = root / "transfer.zip"
            result = pack(run, source, archive)
            unpack(archive, root / "import")
            manifest = verify(root / "import")
            self.assertEqual(result["files"], len(manifest["files"]))
            for name, data in original.items():
                copied = root / "import/windows-gpu-main" / name
                self.assertEqual(copied.read_bytes(), data)
                self.assertAlmostEqual(
                    copied.stat().st_mtime, (run / name).stat().st_mtime, places=3
                )
                self.assertEqual((run / name).read_bytes(), data)
            with self.assertRaises(FileExistsError):
                pack(run, source, archive)
            with self.assertRaises(FileExistsError):
                unpack(archive, root / "import")
            (root / "import/windows-gpu-main/learner/checkpoint.pt").write_bytes(b"tampered")
            with self.assertRaises(ValueError):
                verify(root / "import")

    def test_active_source_and_corrupt_archive_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run, source = self.fixture(root)
            (run / "status.json").write_text("{}")
            with self.assertRaises(ValueError):
                pack(run, source, root / "active.zip")
            (run / "status.json").write_text('{"stoppedAt":"done"}')
            archive = root / "transfer.zip"
            pack(run, source, archive)
            with archive.open("ab") as stream:
                stream.write(b"corrupted")
            with self.assertRaises(ValueError):
                unpack(archive, root / "import")

    def test_path_traversal_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "unsafe.zip"
            with zipfile.ZipFile(archive, "w") as stream:
                stream.writestr("manifest.json", json.dumps({"files": {"../escape": {}}}))
                stream.writestr("../escape", "bad")
            archive.with_suffix(".zip.sha256").write_text(digest(archive))
            with self.assertRaises(ValueError):
                unpack(archive, root / "import")
            self.assertFalse((root / "escape").exists())

    def test_mac_archive_uses_its_actual_run_name_and_keeps_source_fingerprints(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run, source = self.fixture(root)
            archive = root / "mac-final.zip"
            result = pack(run, source, archive, source_run="mac-20261105")
            unpack(archive, root / "restored")
            manifest = verify(root / "restored")
            self.assertEqual(result["sourceRun"], "mac-20261105")
            self.assertEqual(manifest["sourceRun"], "mac-20261105")
            self.assertEqual(
                (root / "restored/mac-20261105/learner/checkpoint.pt").read_bytes(),
                (run / "learner/checkpoint.pt").read_bytes(),
            )
            self.assertIn("frozen-source/code.py", manifest["files"])
            self.assertFalse(any(n.startswith("windows-gpu-main/") for n in manifest["files"]))
            for label in ["../escape", "/absolute", "nested/run", "frozen-source", "bad:name"]:
                with self.assertRaises(ValueError):
                    pack(run, source, root / "invalid.zip", source_run=label)
            self.assertFalse((root / "invalid.zip").exists())


if __name__ == "__main__":
    unittest.main()
