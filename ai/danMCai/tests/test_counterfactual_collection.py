"""The rollout writer retains paired labels, padding and independent deal identities."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT / "ai/danMCai/training"))
from counterfactual_learning import CounterfactualWriter, FEATURES


class StubEngine:
    def __init__(self, path):
        self.path = path

    def score(self, state):
        return (
            np.arange(len(state["actions"]), dtype=np.float32),
            np.ones((len(state["actions"]), 512), dtype=np.float32),
            np.ones((len(state["actions"]), 53), dtype=np.float32),
        )


class CounterfactualCollectionTests(unittest.TestCase):
    def test_shapes_padding_returns_and_seed_identity(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("counterfactual_learning.RolloutEngine", StubEngine),
        ):
            writer = CounterfactualWriter(
                {
                    "model": str(ROOT / "ai/danMCai/models/baseline/policy.onnx"),
                    "output": directory,
                    "seed": 21590104,
                    "games": 3,
                }
            )
            try:
                state = {"actions": [[0], [1], []], "counts": [27, 27, 27, 27]}
                writer.record(
                    {
                        "seed": 21590104,
                        "episode": 0,
                        "state": state,
                        "indices": [1, 0],
                        "returns": [1, -1],
                    }
                )
                with self.assertRaisesRegex(ValueError, "Invalid counterfactual"):
                    writer.record(
                        {"seed": 21590104, "state": state, "indices": [1, 0], "returns": [1, -1]}
                    )
                writer.finalize("complete")
                path = Path(directory)
                features = np.fromfile(path / "features.f32", "<f4").reshape(1, 4, FEATURES)
                np.testing.assert_array_equal(features[0, :2], 1)
                np.testing.assert_array_equal(features[0, 2:], 0)
                np.testing.assert_array_equal(
                    np.fromfile(path / "targets.f32", "<f4"), [1, -1, 0, 0]
                )
                np.testing.assert_array_equal(np.fromfile(path / "mask.f32", "<f4"), [1, 1, 0, 0])
                np.testing.assert_array_equal(
                    np.fromfile(path / "proposal-values.f32", "<f4"), [1, 0, 0, 0]
                )
                np.testing.assert_array_equal(np.fromfile(path / "seeds.i64", "<i8"), [21590104])
                metadata = json.loads((path / "metadata.json").read_text())
                self.assertEqual(metadata["status"], "complete")
                self.assertEqual(metadata["rows"], 1)
                with self.assertRaisesRegex(ValueError, "finalized"):
                    writer.record({})
            finally:
                writer.close()

    def test_rejects_nonpaired_labels_and_post_firstout_states(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("counterfactual_learning.RolloutEngine", StubEngine),
        ):
            writer = CounterfactualWriter(
                {
                    "model": str(ROOT / "ai/danMCai/models/baseline/policy.onnx"),
                    "output": directory,
                    "seed": 21590104,
                    "games": 2,
                }
            )
            try:
                record = {
                    "seed": 21590104,
                    "state": {"actions": [[0], [1]], "counts": [2, 3, 4, 5]},
                    "indices": [0, 1],
                    "returns": [1, 0],
                }
                with self.assertRaisesRegex(ValueError, "Invalid counterfactual"):
                    writer.record(record)
                record["returns"] = [1, -1]
                record["state"]["counts"][2] = 0
                with self.assertRaisesRegex(ValueError, "precede first-out"):
                    writer.record(record)
            finally:
                writer.close()


if __name__ == "__main__":
    unittest.main()
