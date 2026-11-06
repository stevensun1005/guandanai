"""Continuous learner: faithful P0 export, replay ring, shard ingestion and an actual update."""

import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import onnxruntime as ort
import torch

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT / 'ai/danMCai/training/continuous'))
from learner import Learner, Replay, target, write_json, learner_device  # noqa: E402
from value_net import FEATURES, ValueNet, export_onnx, load_onnx_weights  # noqa: E402


def write_run(directory, rows=600):
    run = Path(directory)
    (run / "models").mkdir(parents=True)
    (run / "shards").mkdir()
    shutil.copy(ROOT / "ai/danMCai/models/baseline/policy.onnx", run / "models/v000000000.onnx")
    (run / "models/latest.json").write_text(
        json.dumps({"version": "v000000000", "file": "v000000000.onnx", "step": 0})
    )
    config = {
        "learner": {
            "threads": 1,
            "batch": 64,
            "learningRate": 1e-4,
            "gradClip": 1.0,
            "capacity": 1000,
            "minSamples": 100,
            "replayRatio": 4,
            "exportSeconds": 1e9,
            "targetMatchWeight": 0.5,
            "anchorWeight": 0,
            "keepVersions": 3,
            "seed": 1,
        }
    }
    (run / "config.json").write_text(json.dumps(config))
    rng = np.random.default_rng(0)
    x = rng.integers(-1, 3, (rows, FEATURES)).astype(np.int8)
    y = np.stack(
        [
            rng.choice([-3, -2, -1, 1, 2, 3], rows),
            rng.choice([-1, 0, 1], rows),
            np.zeros(rows),
            np.ones(rows),
        ],
        axis=1,
    ).astype(np.float32)
    x.tofile(run / "shards/a00-000000000.x.i8")
    y.tofile(run / "shards/a00-000000000.y.f32")
    (run / "shards/a00-000000000.json").write_text(json.dumps({"rows": rows}))
    return run


class ContinuousLearnerTests(unittest.TestCase):
    def test_publish_retains_exports_held_by_inflight_actors(self):
        with tempfile.TemporaryDirectory() as directory:
            run = write_run(directory)
            learner = Learner(run)
            held = run / "models/v000000000.onnx"
            original = held.read_bytes()
            for step in range(1, 6):
                learner.step = step  # Synthetic publication versions, no optimizer update.
                learner.publish()
            self.assertEqual(held.read_bytes(), original)
            self.assertEqual(len(list((run / "models").glob("v*.onnx"))), 6)

    def test_requested_mps_never_silently_becomes_cpu(self):
        with patch('torch.backends.mps.is_available', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'refusing silent CPU fallback'):
                learner_device('mps')
        with self.assertRaises(ValueError):
            learner_device('meta')

    @unittest.skipUnless(torch.backends.mps.is_available(), 'Apple MPS hardware required')
    def test_mps_updates_and_restores_adam_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            run = write_run(directory)
            config = json.loads((run / 'config.json').read_text())
            config['learner']['device'] = 'mps'
            (run / 'config.json').write_text(json.dumps(config))
            learner = Learner(run)
            learner.loop(max_steps=5)
            resumed = Learner(run)
            self.assertEqual(resumed.step, 5)
            self.assertTrue(resumed.optimizer.state)
            resumed.ingest()
            resumed.train_step()
            self.assertEqual(resumed.step, 6)
            self.assertTrue(all(np.isfinite(w).all() for w in resumed.net.weights()))

    def test_atomic_status_write_retries_a_short_sharing_lock(self):
        import os
        original = os.replace
        attempts = []
        def replace(*args):
            attempts.append(args)
            if len(attempts) < 3:
                raise PermissionError("temporary sharing lock")
            return original(*args)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "status.json"
            with patch("learner.os.replace", side_effect=replace):
                write_json(path, {"step": 123})
            self.assertEqual(len(attempts), 3)
            self.assertEqual(json.loads(path.read_text())["step"], 123)
            with patch("learner.os.replace", side_effect=PermissionError("persistent lock")):
                with self.assertRaises(PermissionError):
                    write_json(path, {})

    def test_unsupported_device_fails_instead_of_silently_using_cpu(self):
        with tempfile.TemporaryDirectory() as directory:
            run = write_run(directory)
            config = json.loads((run / "config.json").read_text())
            config["learner"]["device"] = "meta"
            (run / "config.json").write_text(json.dumps(config))
            with self.assertRaisesRegex(ValueError, "Supported learner devices"):
                Learner(run)

    @unittest.skipUnless(torch.cuda.is_available(), "Requires actual CUDA or AMD ROCm GPU")
    def test_gpu_updates_all_layers_exports_and_resumes_optimizer(self):
        with tempfile.TemporaryDirectory() as directory:
            run = write_run(directory)
            config = json.loads((run / "config.json").read_text())
            config["learner"].update(device="cuda:0", anchorWeight=0.1)
            (run / "config.json").write_text(json.dumps(config))
            shutil.copy(ROOT / "ai/danMCai/models/baseline/policy.onnx", run / "models/anchor.onnx")
            learner = Learner(run)
            self.assertEqual(next(learner.net.parameters()).device.type, "cuda")
            self.assertEqual(next(learner.anchor.parameters()).device.type, "cuda")
            before = learner.net.weights()
            learner.loop(max_steps=5)
            self.assertTrue(all(not np.array_equal(a, b) for a, b in zip(before[::2], learner.net.weights()[::2])))
            resumed = Learner(run)
            self.assertEqual(resumed.step, 5)
            resumed.ingest()
            resumed.train_step()
            resumed.publish()
            self.assertEqual(resumed.step, 6)
            self.assertEqual(resumed.ingested_rows, 600)
            latest = json.loads((run / "models/latest.json").read_text())
            exported = load_onnx_weights(run / "models" / latest["file"])
            for expected, actual in zip(resumed.net.weights(), exported):
                np.testing.assert_array_equal(expected, actual)
            state = json.loads((run / "learner/status.json").read_text())
            self.assertEqual(state["device"], "cuda:0")
            self.assertIn("deviceName", state)

    def test_export_reproduces_deployed_policy(self):
        weights = load_onnx_weights(ROOT / "ai/danMCai/models/baseline/policy.onnx")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "copy.onnx"
            export_onnx(ValueNet(weights).weights(), path)
            rng = np.random.default_rng(1)
            feed = {
                "state": rng.integers(-1, 3, (1, 513)).astype(np.float32),
                "actions": rng.integers(0, 3, (29, 54)).astype(np.float32),
            }
            original = ort.InferenceSession(str(ROOT / "ai/danMCai/models/baseline/policy.onnx")).run(None, feed)[0]
            copy = ort.InferenceSession(str(path)).run(None, feed)[0]
            np.testing.assert_array_equal(original, copy)

    def test_replay_ring_keeps_newest_rows(self):
        replay = Replay(5, 0)
        replay.add(
            np.arange(7 * FEATURES).reshape(7, FEATURES).astype(np.int8),
            np.arange(28, dtype=np.float32).reshape(7, 4),
        )
        self.assertEqual(replay.size, 5)
        self.assertEqual(sorted(replay.y[:, 0].tolist()), [8.0, 12.0, 16.0, 20.0, 24.0])

    def test_target_blends_round_points_and_match_result(self):
        raw = np.array([[2, 1, 0, 9], [-3, -1, 0, 9], [1, 0, 0, 9]], np.float32)
        np.testing.assert_allclose(target(raw, 0), [2, -3, 1])
        np.testing.assert_allclose(target(raw, 0.5), [2.5, -3, 0.5])

    def test_learner_ingests_trains_and_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            run = write_run(directory)
            learner = Learner(run)
            before = [w.copy() for w in learner.net.weights()]
            learner.loop(max_steps=5)
            self.assertEqual(learner.replay.size, 600)
            self.assertEqual(learner.step, 5)
            latest = json.loads((run / "models/latest.json").read_text())
            self.assertEqual(latest["version"], "v000000005")
            after = load_onnx_weights(run / "models" / latest["file"])
            self.assertTrue(all(not np.array_equal(a, b) for a, b in zip(before[::2], after[::2])))
            resumed = Learner(run)
            self.assertEqual(resumed.step, 5)
            resumed.ingest()
            self.assertEqual(
                resumed.ingested_rows, 600, "re-ingesting after resume must not recount"
            )
            torch.testing.assert_close(
                resumed.net.layers[0].weight, torch.from_numpy(after[0].T.copy())
            )


if __name__ == "__main__":
    unittest.main()
