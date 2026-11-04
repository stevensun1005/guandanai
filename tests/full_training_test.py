"""Verify actual backbone gradients, progressive freezing, and complete-model export."""

import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import onnxruntime as ort
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from full_model import initial_parameters, export_model, raw_features, WIDTH, source_hashes, sha  # noqa: E402
from train_full_policy import CompleteNetwork, load_data  # noqa: E402
from run_full_training import retain_candidate  # noqa: E402
from ai.reference.numpy_engine import PolicyNetwork  # noqa: E402


class CompleteTrainingTests(unittest.TestCase):
    def test_arena_regression_rolls_back_training_parent(self):
        for rule, historical, expected in [
            (-0.7, -0.5, False),
            (0.1, -0.01, False),
            (0, 0, False),
            (0.02, 0, True),
        ]:
            self.assertEqual(
                retain_candidate(
                    {
                        "rule": {"championGain": rule},
                        "snapshot": {"championGain": historical},
                    }
                ),
                expected,
            )

    def test_incomplete_corrupted_and_overlapping_match_buffers_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            model = path / "policy.onnx"
            export_model(model, initial_parameters())
            rows = np.zeros((20, WIDTH + 3), dtype="<f4")
            rows[:, WIDTH] = np.where(np.arange(20) % 2, 1, -1)
            rows[:, WIDTH + 1] = np.arange(20)
            rows.tofile(path / "raw.f32")
            metadata = {
                "kind": "complete-match-raw",
                "status": "complete",
                "rows": 20,
                "games": 20,
                "features": WIDTH,
                "rowFloats": WIDTH + 3,
                "model": str(model),
                "modelSHA256": sha(model),
                "sourceSHA256": source_hashes(),
                "collection": {"seed": 1000, "options": {"games": 20}},
            }
            (path / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
            (path / "rollout.json").write_text(
                json.dumps({"status": "complete", "completedGames": 20}), encoding="utf-8"
            )
            data, validation, _ = load_data([path])
            self.assertEqual(len(data), 20)
            self.assertEqual(int(validation.sum()), 2)
            with self.assertRaisesRegex(ValueError, "Overlapping"):
                load_data([path, path])
            rows[2, WIDTH] = 0.5
            rows.tofile(path / "raw.f32")
            with self.assertRaisesRegex(ValueError, "targets"):
                load_data([path])
            (path / "raw.f32").write_bytes(b"bad")
            with self.assertRaisesRegex(ValueError, "length"):
                load_data([path])

    def test_progressive_stages_update_the_backbone_only_when_unfrozen(self):
        torch.set_num_threads(1)
        torch.manual_seed(845)
        original = initial_parameters()
        inputs = torch.randn(24, 628) * 0.3
        targets = torch.linspace(-1, 1, 24)[:, None]
        for stage, first_trainable in [("tail", 4), ("middle", 2), ("full", 0)]:
            model = CompleteNetwork(original)
            model.unfreeze(stage)
            optimizer = torch.optim.Adam(
                [p for p in model.parameters() if p.requires_grad], lr=0.0001
            )
            loss = ((model(inputs) - targets) ** 2).mean()
            loss.backward()
            optimizer.step()
            result = model.export()
            for layer in range(6):
                old = original[f"w{layer}"][:567] if layer == 0 else original[f"w{layer}"]
                new = result[f"w{layer}"][:567] if layer == 0 else result[f"w{layer}"]
                if layer < first_trainable:
                    np.testing.assert_array_equal(new, old)
                else:
                    self.assertGreater(np.count_nonzero(new != old), 0)
            self.assertGreater(np.count_nonzero(result["w0"][567:]), 0)
            if stage == "full":
                self.assertEqual(
                    sum(p.numel() for p in model.parameters() if p.requires_grad), 1373185
                )

    def test_export_matches_original_warm_start_and_trainable_model(self):
        weights = initial_parameters()
        model = CompleteNetwork(weights).eval()
        fixtures = json.loads((ROOT / "tests/fixtures/response-positions.json").read_text())
        state = fixtures[0]["state"]
        state["actions"] = state["actions"][:257]
        state["actionShapes"] = state["actionShapes"][:257]
        state["trick"] = state["context"]["trick"]
        state["match"] = {
            "levels": [state["level"], state["level"]],
            "lvlTeam": 0,
            "aFails": [0, 0],
            "round": 2,
            "previousOrder": [0, 2, 1, 3],
        }
        features = raw_features(state)
        with torch.no_grad():
            expected = model(torch.from_numpy(features)).numpy().reshape(-1)
        reference = PolicyNetwork().values(features[:, :567]) / 3
        np.testing.assert_allclose(expected, reference, atol=3e-5, rtol=2e-5)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "full.onnx"
            export_model(path, weights)
            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            engine = ort.InferenceSession(
                str(path), sess_options=options, providers=["CPUExecutionProvider"]
            )
            output = engine.run(
                ["values"],
                {
                    "state": features[:1, :513],
                    "actions": features[:, 513:567],
                    "extras": features[:, 567:],
                },
            )[0].reshape(-1)
            np.testing.assert_allclose(output, expected, atol=3e-5, rtol=2e-5)


if __name__ == "__main__":
    unittest.main()
