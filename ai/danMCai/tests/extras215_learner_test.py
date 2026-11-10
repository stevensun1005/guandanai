"""215-wide extras (53 public + 162 belief marginals): export width and a one-step CPU learner smoke."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import onnxruntime as ort
import torch

HERE = Path(__file__).resolve().parents[1] / "training/continuous"
sys.path.insert(0, str(HERE))
from value_net import ValueNet, ValueNetExtras, export_onnx_extras, load_onnx_weights  # noqa: E402

spec = importlib.util.spec_from_file_location("extras215_continuous_learner", HERE / "learner.py")
learner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(learner)

ROWS = 64


def make_run(directory, mode="public-belief", width=215, **settings):
    run = Path(directory)
    for name in ("models", "shards"):
        (run / name).mkdir(parents=True)
    torch.manual_seed(20261110)
    weights = ValueNet().weights()
    export_onnx_extras(weights, run / "models/v000000000.onnx", None, width)
    (run / "models/latest.json").write_text(json.dumps({"version": "v000000000", "file": "v000000000.onnx"}))
    config = {
        "extrasMode": mode,
        "learner": {
            "device": "cpu", "threads": 1, "batch": 16, "learningRate": 1e-5,
            "extrasLearningRate": 1e-4, "gradClip": 1.0, "capacity": 1000, "minSamples": ROWS,
            "replayRatio": 4, "exportSeconds": 1e9, "targetMatchWeight": 0, "anchorWeight": 0,
            "seed": 20261110, **settings,
        },
    }
    (run / "config.json").write_text(json.dumps(config))
    rng = np.random.default_rng(7)
    rng.integers(0, 3, (ROWS, 567)).astype(np.int8).tofile(run / "shards/a00-000000000.x.i8")
    y = np.zeros((ROWS, 4), np.float32)
    y[:, 0] = rng.choice([-3, -2, -1, 1, 2, 3], ROWS)
    y.tofile(run / "shards/a00-000000000.y.f32")
    rng.random((ROWS, width), dtype=np.float32).tofile(run / "shards/a00-000000000.e.f32")
    (run / "shards/a00-000000000.json").write_text(json.dumps({"rows": ROWS, "extraFeatures": width}))
    return run


class Extras215Test(unittest.TestCase):
    def test_zero_215_projection_matches_base_and_exports_width(self):
        torch.manual_seed(1)
        weights = ValueNet().weights()
        base, student = ValueNet(weights), ValueNetExtras(weights, 215)
        self.assertEqual(tuple(student.extra_weight.shape), (215, 512))
        x = torch.rand(9, 567)
        with torch.no_grad():
            np.testing.assert_array_equal(base(x).numpy(), student(x, torch.rand(9, 215)).numpy())
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "w.onnx"
            export_onnx_extras(weights, path, None, 215)
            session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
            extras = next(i for i in session.get_inputs() if i.name == "extras")
            self.assertEqual(extras.shape[1], 215)
            for a, b in zip(load_onnx_weights(path), weights):
                np.testing.assert_array_equal(a, b)
        with self.assertRaises(ValueError):
            ValueNetExtras(weights, 100)
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                export_onnx_extras(weights, Path(d) / "bad.onnx", np.zeros((53, 512)), 215)

    def test_one_step_learner_on_cpu_with_a_215_wide_shard(self):
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as d:
            run = make_run(d)
            trainer = learner.Learner(run)
            self.assertEqual(trainer.extra_width, 215)
            self.assertEqual([g["lr"] for g in trainer.optimizer.param_groups], [1e-5, 1e-4])
            trunk = [w.copy() for w in trainer.net.weights()]
            trainer.loop(max_steps=1)
            self.assertEqual(trainer.step, 1)
            self.assertGreater(torch.count_nonzero(trainer.net.extra_weight).item(), 0)
            latest = json.loads((run / "models/latest.json").read_text())
            self.assertEqual(latest["version"], "v000000001")
            session = ort.InferenceSession(str(run / "models" / latest["file"]), providers=["CPUExecutionProvider"])
            values = session.run(["values"], {
                "state": np.zeros((1, 513), np.float32),
                "actions": np.zeros((3, 54), np.float32),
                "extras": np.ones((3, 215), np.float32),
            })[0]
            self.assertEqual(values.shape, (3, 1))
            self.assertTrue(np.isfinite(values).all())
            self.assertTrue(any(not np.array_equal(a, b) for a, b in zip(trunk, trainer.net.weights())))
            # Resume from the checkpoint keeps the two parameter groups.
            resumed = learner.Learner(run)
            self.assertEqual(resumed.step, 1)
            self.assertEqual(len(resumed.optimizer.param_groups), 2)

    def test_trunk_frozen_moves_only_the_projection(self):
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as d:
            trainer = learner.Learner(make_run(d, trunkFrozen=True))
            trunk = [w.copy() for w in trainer.net.weights()]
            trainer.loop(max_steps=2)
            for a, b in zip(trunk, trainer.net.weights()):
                np.testing.assert_array_equal(a, b)
            self.assertGreater(torch.count_nonzero(trainer.net.extra_weight).item(), 0)

    def test_a_53_wide_shard_is_refused_in_public_belief_mode(self):
        with tempfile.TemporaryDirectory() as d:
            run = make_run(d)
            (run / "shards/a00-000000000.json").write_text(json.dumps({"rows": ROWS, "extraFeatures": 53}))
            with self.assertRaises(ValueError):
                learner.Learner(run).ingest()


if __name__ == "__main__":
    unittest.main()
