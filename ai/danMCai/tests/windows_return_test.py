"""Windows return preparation must preserve learner state and isolate new seeds/protocol."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
TOOLS = ROOT / "ai/danMCai/training/continuous"
sys.path.insert(0, str(TOOLS))
from transfer import pack, unpack, digest  # noqa: E402

spec = importlib.util.spec_from_file_location("windows_return", TOOLS / "prepare-windows-return.py")
WINDOWS = importlib.util.module_from_spec(spec)
spec.loader.exec_module(WINDOWS)


def fixture(root, next_seed=3100000):
    run, code, project = root / "mac", root / "code", root / "project"
    for name in ["models", "champion", "learner", "shards", "league", "actors"]:
        (run / name).mkdir(parents=True)
    code.mkdir(); (code / "test.py").write_bytes(b"# frozen\n")
    for name in ["models/v1.onnx", "models/anchor.onnx", "champion/champion.onnx"]:
        (run / name).write_bytes(b"fixture model")
    metadata = {"file": "v1.onnx", "step": 1, "version": "v000000001", "sha256": digest(run / "models/v1.onnx")}
    for name in ["models/latest.json", "champion/champion.json"]:
        (run / name).write_text(json.dumps(metadata))
    (run / "config.json").write_text(json.dumps({"learner": {}, "sourceSHA256": {"test.py": digest(code / "test.py")}}))
    (run / "status.json").write_text('{"stoppedAt":"done","gateIndex":344,"anchorIndex":307}')
    (run / "schedule.json").write_text('{"expired":true}')
    (run / "STOP").write_text("expired")
    (run / "learner/status.json").write_text('{"state":"stopped"}')
    (run / "learner/checkpoint.pt").write_bytes(b"matched model and Adam")
    (run / "actors/actor-0.json").write_text(json.dumps({"nextSeed": next_seed}))
    (run / "league/league.json").write_text('{"models":[]}')
    (run / "shards/a00-000004100.json").write_text('{"rows":1}')
    policy = project / "ai/danMCai/models/baseline/policy.onnx"
    policy.parent.mkdir(parents=True); policy.write_bytes(b"fixture model")
    archive = root / "mac.zip"
    pack(run, code, archive, "mac-20261105")
    unpack(archive, root / "snapshot")
    return root / "snapshot", project


class WindowsReturnTests(unittest.TestCase):
    @patch.object(WINDOWS.subprocess, "check_output", return_value='{"new-source":"hash"}')
    def test_fork_preserves_checkpoint_and_replay_without_starting_or_reusing_window(self, _):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot, project = fixture(Path(tmp))
            destination = project / "ai/danMCai/runs/windows-return"
            result = WINDOWS.prepare(snapshot, project, destination)
            self.assertEqual(result["checkpointSHA256"], result["sourceCheckpointSHA256"])
            self.assertFalse(result["started"])
            self.assertEqual(result["optimizerUpdatesExecuted"], 0)
            self.assertFalse((destination / "schedule.json").exists())
            self.assertFalse((destination / "STOP").exists())
            self.assertEqual(json.loads((destination / "config.json").read_text())["learner"]["device"], "cuda:0")
            actor = json.loads((destination / "actors/actor-0.json").read_text())
            self.assertEqual(actor["nextSeed"], 6000000)
            self.assertEqual(actor["shardSequence"], 4101)
            with self.assertRaises(FileExistsError):
                WINDOWS.prepare(snapshot, project, destination)

    def test_outside_project_and_invalid_concurrency_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); snapshot, project = fixture(root)
            with self.assertRaises(ValueError):
                WINDOWS.prepare(snapshot, project, root / "old-windows-run")
            with self.assertRaises(ValueError):
                WINDOWS.prepare(snapshot, project, project / "ai/danMCai/runs/new", actors=9)

    @patch.object(WINDOWS.subprocess, "check_output", return_value='{"new-source":"hash"}')
    def test_used_seed_block_is_rejected_before_destination_creation(self, _):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot, project = fixture(Path(tmp), next_seed=6000001)
            destination = project / "ai/danMCai/runs/new"
            with self.assertRaisesRegex(ValueError, "not fresh"):
                WINDOWS.prepare(snapshot, project, destination)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
