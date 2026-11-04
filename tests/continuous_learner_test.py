"""Continuous learner: faithful P0 export, replay ring, shard ingestion and an actual update."""

import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

import numpy as np
import onnxruntime as ort
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "continuous"))
from learner import Learner, Replay, target  # noqa: E402
from value_net import FEATURES, ValueNet, export_onnx, load_onnx_weights  # noqa: E402


def write_run(directory, rows=600):
    run = Path(directory)
    (run / "models").mkdir(parents=True)
    (run / "shards").mkdir()
    shutil.copy(ROOT / "ai/policy.onnx", run / "models/v000000000.onnx")
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
    def test_export_reproduces_deployed_policy(self):
        weights = load_onnx_weights(ROOT / "ai/policy.onnx")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "copy.onnx"
            export_onnx(ValueNet(weights).weights(), path)
            rng = np.random.default_rng(1)
            feed = {
                "state": rng.integers(-1, 3, (1, 513)).astype(np.float32),
                "actions": rng.integers(0, 3, (29, 54)).astype(np.float32),
            }
            original = ort.InferenceSession(str(ROOT / "ai/policy.onnx")).run(None, feed)[0]
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
