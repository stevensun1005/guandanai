"""The endgame learner starts as an exact champion copy and exports a web-compatible student."""

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training" / "continuous"))
sys.path.insert(0, str(ROOT / "endgame"))
from learner import ORACLE, Learner, OracleValueNet, keep_probability, labels_valid  # noqa: E402
from value_net import FEATURES, ValueNet, export_onnx, load_onnx_weights  # noqa: E402

BASELINE = ROOT / "models" / "baseline" / "policy.onnx"


class EndgameLearnerTest(unittest.TestCase):
    def test_keep_schedule(self):
        self.assertEqual(keep_probability(0, 100), 1.0)
        self.assertAlmostEqual(keep_probability(50, 100), 0.5)
        self.assertEqual(keep_probability(100, 100), 0.0)
        self.assertEqual(keep_probability(500, 100), 0.0)

    def test_label_kinds(self):
        points = np.array([-3, -1, 2, 3], np.float32)
        averaged = np.array([-2.75, 0.0, 1.125, 3.0], np.float32)
        self.assertTrue(labels_valid(points))
        self.assertFalse(labels_valid(averaged))
        self.assertTrue(labels_valid(averaged, "pimc-mean"))
        self.assertFalse(labels_valid(np.array([3.5], np.float32), "pimc-mean"))
        self.assertFalse(labels_valid(np.array([np.nan], np.float32), "pimc-mean"))
        with self.assertRaises(ValueError):
            labels_valid(points, "unknown")

    def test_initial_network_ignores_oracle_and_equals_champion(self):
        weights = load_onnx_weights(BASELINE)
        base, oracle_net = ValueNet(weights), OracleValueNet(weights)
        x = torch.from_numpy(np.random.default_rng(1).integers(-1, 3, (64, FEATURES)).astype(np.float32))
        o = torch.from_numpy(np.random.default_rng(2).integers(0, 3, (64, ORACLE)).astype(np.float32))
        with torch.no_grad():
            self.assertTrue(torch.equal(base(x), oracle_net(x, o)))
            self.assertTrue(torch.equal(oracle_net(x, o), oracle_net(x, torch.zeros_like(o))))

    def test_student_export_is_the_trunk(self):
        weights = load_onnx_weights(BASELINE)
        net = OracleValueNet(weights)
        with torch.no_grad():
            net.oracle_weight.add_(0.5)
            net.layers[0].bias.add_(0.01)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "student.onnx"
            export_onnx(net.weights(), path)
            exported = load_onnx_weights(path)
        for a, b in zip(exported, net.weights()):
            np.testing.assert_array_equal(a, b)

    def test_prune_keeps_newest_ingested_rows_and_metadata(self):
        import json
        import os

        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / "shards").mkdir()
            (run / "models").mkdir()
            config = {
                "deadline": "2099-01-01T00:00:00Z",
                "champion": {"file": str(BASELINE)},
                "learner": {"device": "cpu", "threads": 1, "seed": 1, "learningRate": 1e-5,
                            "batch": 8, "capacity": 100, "minSamples": 1, "replayRatio": 4,
                            "oracleDecaySteps": 10, "exportSeconds": 600, "keepShardRows": 25},
            }
            (run / "config.json").write_text(json.dumps(config))
            for i in range(4):
                base = run / "shards" / f"s0-{i:06d}"
                np.zeros((10, FEATURES), np.int8).tofile(f"{base}.x.i8")
                np.zeros((10, ORACLE), np.int8).tofile(f"{base}.o.i8")
                np.ones(10, np.float32).tofile(f"{base}.y.f32")
                Path(f"{base}.json").write_text(json.dumps({"rows": 10}))
                os.utime(f"{base}.json", (1000 + i, 1000 + i))
            learner = Learner(run)
            self.assertEqual(learner.ingest(), 40)
            learner.prune()
            remaining = sorted(p.name for p in (run / "shards").glob("*.y.f32"))
            self.assertEqual(remaining, ["s0-000002.y.f32", "s0-000003.y.f32"])
            self.assertEqual(len(list((run / "shards").glob("*.json"))), 4)
            self.assertEqual(learner.pruned_rows, 20)
            learner.save()
            resumed = Learner(run)  # refill must skip pruned shards without failing
            self.assertEqual(resumed.replay.size, 20)


if __name__ == "__main__":
    unittest.main()
