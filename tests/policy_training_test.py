"""Independent checks for residual export, dataset provenance and real optimization."""

import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import onnx
from onnx import numpy_helper
import onnxruntime as ort
import torch
from torch import nn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from ai.reference.numpy_engine import encode, cards_array  # noqa: E402
from policy_dataset import validate_dataset, validate_seed_ranges  # noqa: E402
from policy_learning import RolloutEngine  # noqa: E402
from train_policy import export_policy  # noqa: E402


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def session(path):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])


def dataset(path, games=80):
    """Synthetic data for plumbing tests, never a playing-strength evaluation."""
    path.mkdir()
    random = np.random.default_rng(844721)
    rows = np.zeros((games, 568), dtype="<f4")
    rows[:, :512] = random.uniform(-0.05, 0.05, (games, 512))
    signs = np.where(np.arange(games) % 2 == 0, 1, -1)
    rows[:, 0] = signs * 0.8
    rows[:, 512 + 18] = 1
    rows[:, 565] = signs * 1.1
    rows[:, 566] = np.arange(games)
    rows[:, 567] = np.arange(games) % 4
    rows.tofile(path / "transitions.f32")
    metadata = {
        "version": 1,
        "features": 565,
        "rowFloats": 568,
        "rows": games,
        "games": games,
        "model": str(ROOT / "ai/policy.onnx"),
        "modelSHA256": sha(ROOT / "ai/policy.onnx"),
        "basePolicySHA256": sha(ROOT / "ai/policy.onnx"),
        "extraFeaturesSHA256": sha(ROOT / "scripts/policy_features.py"),
        "config": {"seed": 844721, "options": {"games": games, "opponent": "self"}},
    }
    rollout = {
        "status": "complete",
        "games": games,
        "completedGames": games,
        "decisions": games,
        "seed": 844721,
        "seedRange": [844721, 844721 + games - 1],
        "modelSHA256": metadata["modelSHA256"],
    }
    (path / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    (path / "rollout.json").write_text(json.dumps(rollout), encoding="utf-8")
    return metadata, rollout


class PolicyTrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)
        cls.base = RolloutEngine(ROOT / "ai/policy.onnx")
        source = json.loads((ROOT / "tests/fixtures/positions.json").read_text(encoding="utf-8"))[0]
        cls.state = copy.deepcopy(source)
        # Exercise a dynamic batch crossing the collector's 128-action boundary.
        cls.state["actions"] = [source["actions"][i % len(source["actions"])] for i in range(129)]
        cls.base_values, cls.hidden, _ = cls.base.score(cls.state)

    def test_export_matches_torch_and_preserves_backbone_and_settled_actions(self):
        torch.manual_seed(844721)
        head = nn.Sequential(nn.Linear(565, 128), nn.Tanh(), nn.Linear(128, 1)).eval()
        weights = [parameter.detach().numpy().copy() for parameter in head.parameters()]
        extras = np.random.default_rng(291).uniform(0, 1, (129, 53)).astype(np.float32)
        extras[:, 18] = np.arange(129) % 2
        inputs = {
            "state": encode(self.state)[None, :],
            "actions": np.array([cards_array(action) for action in self.state["actions"]]),
            "extras": extras,
        }
        with torch.no_grad():
            residual = head(
                torch.from_numpy(np.concatenate((self.hidden, extras), axis=1))
            ).numpy()[:, 0]
        expected = self.base_values + (0.5 / 0.4) * residual * extras[:, 18]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "candidate.onnx"
            export_policy(path, weights, alpha=0.5, base_scale=0.4)
            actual = session(path).run(["values"], inputs)[0][:, 0]
            np.testing.assert_allclose(actual, expected, atol=1e-5, rtol=1e-5)
            np.testing.assert_allclose(
                actual[extras[:, 18] == 0], self.base_values[extras[:, 18] == 0], atol=1e-6
            )
            original = {
                tensor.name: numpy_helper.to_array(tensor)
                for tensor in onnx.load(ROOT / "ai/policy.onnx").graph.initializer
            }
            exported = {
                tensor.name: numpy_helper.to_array(tensor)
                for tensor in onnx.load(path).graph.initializer
            }
            for name, array in original.items():
                np.testing.assert_array_equal(exported[name], array)

    def test_zero_initialized_head_keeps_original_values_and_ranking(self):
        torch.manual_seed(912)
        head = nn.Sequential(nn.Linear(565, 128), nn.Tanh(), nn.Linear(128, 1))
        nn.init.zeros_(head[-1].weight)
        nn.init.zeros_(head[-1].bias)
        weights = [parameter.detach().numpy().copy() for parameter in head.parameters()]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "zero.onnx"
            export_policy(path, weights, alpha=1, base_scale=0.4)
            actual = session(path).run(
                ["values"],
                {
                    "state": encode(self.state)[None, :],
                    "actions": np.array([cards_array(action) for action in self.state["actions"]]),
                    "extras": np.ones((129, 53), dtype=np.float32),
                },
            )[0][:, 0]
            np.testing.assert_allclose(actual, self.base_values, atol=1e-6)
            self.assertEqual(int(actual.argmax()), int(self.base_values.argmax()))

    def test_dataset_rejects_hashes_dimensions_incomplete_data_and_changed_backbone(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "data"
            metadata, rollout = dataset(path)
            rows, _ = validate_dataset(path)
            self.assertEqual(rows.shape, (80, 568))
            del rows
            for key, bad in (
                ("basePolicySHA256", "bad"),
                ("extraFeaturesSHA256", "bad"),
                ("modelSHA256", "bad"),
                ("features", 564),
                ("rowFloats", 567),
                ("rows", 81),
            ):
                changed = {**metadata, key: bad}
                (path / "metadata.json").write_text(json.dumps(changed), encoding="utf-8")
                with self.subTest(key=key), self.assertRaises(ValueError):
                    validate_dataset(path)
            (path / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
            (path / "rollout.json").write_text(
                json.dumps({**rollout, "status": "running"}), encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "Incomplete"):
                validate_dataset(path)
            (path / "rollout.json").write_text(json.dumps(rollout), encoding="utf-8")
            teacher = onnx.load(ROOT / "ai/policy.onnx")
            for tensor in teacher.graph.initializer:
                if tensor.name == "w4":
                    array = numpy_helper.to_array(tensor).copy()
                    array[0, 0] += 0.01
                    tensor.CopyFrom(numpy_helper.from_array(array, "w4"))
            teacher_path = Path(temporary) / "changed.onnx"
            onnx.save(teacher, teacher_path)
            changed = {**metadata, "model": str(teacher_path), "modelSHA256": sha(teacher_path)}
            (path / "metadata.json").write_text(json.dumps(changed), encoding="utf-8")
            (path / "rollout.json").write_text(
                json.dumps({**rollout, "modelSHA256": sha(teacher_path)}), encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "backbone"):
                validate_dataset(path)
            with self.assertRaisesRegex(ValueError, "overlap"):
                validate_seed_ranges([metadata, metadata])

    def test_actual_training_updates_parameters_and_reduces_held_out_synthetic_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "data"
            output = Path(temporary) / "learned"
            dataset(source, games=320)
            subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/train_policy.py"),
                    str(source),
                    "--output",
                    str(output),
                    "--epochs",
                    "10",
                    "--batch",
                    "64",
                    "--learning-rate",
                    "0.003",
                ],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            report = json.loads((output / "training.json").read_text(encoding="utf-8"))
            self.assertLess(report["bestValidationMSE"], report["baseValidationMSE"] * 0.5)
            self.assertEqual(report["trainingRows"], 288)
            self.assertEqual(report["validationRows"], 32)
            with np.load(output / "residual.npz") as weights:
                self.assertGreater(np.count_nonzero(weights["p2"]), 0)
            self.assertEqual(len(report["models"]), 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
