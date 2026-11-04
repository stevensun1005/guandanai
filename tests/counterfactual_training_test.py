"""Synthetic learning, exact return-difference loss and provenance checks."""

import argparse
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from policy_dataset import _sha  # noqa: E402
from train_counterfactual import (  # noqa: E402
    FEATURES,
    K,
    CounterfactualData,
    centered_loss,
    prediction_metrics,
    train,
)


def write_fixture(path, rows=400, first_seed=22000000):
    path.mkdir()
    random = np.random.default_rng(18)
    features = np.zeros((rows, K, FEATURES), np.float32)
    targets = random.choice([-1.0, 1.0], (rows, K)).astype(np.float32)
    targets[::5] = 1
    targets[1::5] = -1
    masks = np.ones((rows, K), np.float32)
    masks[::7, 2:] = 0
    features[:, :, 512 + 18] = 1
    features[:, :, -1] = targets
    features[masks == 0] = 0
    targets[masks == 0] = 0
    features.tofile(path / "features.f32")
    targets.tofile(path / "targets.f32")
    masks.tofile(path / "mask.f32")
    np.zeros((rows, K), np.float32).tofile(path / "proposal-values.f32")
    # Two pivots per actual deal exercise whole-deal grouping.
    seeds = np.arange(rows, dtype="<i8") // 2 + first_seed
    seeds.tofile(path / "seeds.i64")
    games = int(seeds[-1] - first_seed + 1)
    sources = {"src/core/cards.js": _sha(ROOT / "src/core/cards.js")}
    model = ROOT / "ai/policy.onnx"
    metadata = {
        "version": 1,
        "status": "complete",
        "rows": rows,
        "k": K,
        "features": FEATURES,
        "seedRange": [first_seed, first_seed + games - 1],
        "seedSHA256": _sha(path / "seeds.i64"),
        "model": str(model),
        "modelSHA256": _sha(model),
        "basePolicySHA256": _sha(model),
        "extraFeaturesSHA256": _sha(ROOT / "scripts/policy_features.py"),
        "referenceEncoderSHA256": _sha(ROOT / "ai/reference/numpy_engine.py"),
        "sourceSHA256": sources,
        "config": {"seed": first_seed, "games": games, "sourceSHA256": sources},
        "syntheticUnitTest": True,
    }
    rollout = {
        "status": "complete",
        "rows": rows,
        "pivots": rows,
        "games": games,
        "completedGames": games,
        "seed": first_seed,
        "seedRange": metadata["seedRange"],
        "modelSHA256": metadata["modelSHA256"],
        "sourceSHA256": sources,
    }
    (path / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    (path / "rollout.json").write_text(json.dumps(rollout), encoding="utf-8")
    return metadata, rollout


class CounterfactualTests(unittest.TestCase):
    def test_centered_loss_keeps_ties_masks_padding_and_ignores_common_offset(self):
        targets = torch.tensor([[1.0, 1.0, -1.0, 999.0], [1.0, 1.0, 1.0, 1.0]])
        predictions = torch.tensor(
            [[0.2, 0.5, -0.3, 999.0], [0.5, 0.5, -0.5, -0.5]], requires_grad=True
        )
        mask = torch.tensor([[True, True, True, False], [True] * 4])
        loss = centered_loss(predictions, targets, mask, torch.zeros_like(predictions), 0)
        shifted = centered_loss(
            predictions + 17, targets - 5, mask, torch.zeros_like(predictions), 0
        )
        self.assertAlmostEqual(loss.item(), shifted.item(), places=5)
        loss.backward()
        self.assertEqual(predictions.grad[0, 3].item(), 0)
        self.assertGreater(predictions.grad[1].abs().sum().item(), 0)
        stats = prediction_metrics(predictions.detach().numpy(), targets.numpy(), mask.numpy())
        self.assertEqual(stats["pairsIncludingTies"], 9)
        self.assertEqual(stats["informativePivots"], 1)
        self.assertEqual(stats["tiedPairs"], 7)
        self.assertGreater(stats["meanAbsolutePredictedDifferenceOnTies"], 0)

    def test_synthetic_relative_returns_learn_and_export_with_whole_deal_holdout(self):
        with tempfile.TemporaryDirectory(prefix="guandan-counterfactual-") as temporary:
            directory = Path(temporary)
            write_fixture(directory / "data")
            dataset = CounterfactualData([directory / "data"])
            training = set(dataset.seeds[dataset.train_indices])
            validation = set(dataset.seeds[dataset.validation_indices])
            self.assertFalse(training & validation)
            self.assertEqual(len(validation), 20)
            self.assertTrue({seed % 2 for seed in validation} == {0, 1})
            dataset.close()
            with contextlib.redirect_stdout(io.StringIO()):
                report = train(
                    argparse.Namespace(
                        datasets=[str(directory / "data")],
                        output=str(directory / "model"),
                        epochs=16,
                        batch=64,
                        learning_rate=0.03,
                        regularization=0.05,
                        base_scale=0.4,
                        linear=True,
                        threads=1,
                        seed=9,
                    )
                )
            self.assertGreater(report["bestEpoch"], 0)
            self.assertLess(
                report["after"]["centeredReturnMSE"], report["before"]["centeredReturnMSE"] * 0.1
            )
            self.assertGreater(report["after"]["preferenceAccuracyOnUnequalPairs"], 0.95)
            self.assertGreater(report["after"]["tiedPairs"], 0)
            self.assertEqual(report["trainableParameters"], FEATURES + 1)
            self.assertEqual(len(report["models"]), 3)
            self.assertTrue(
                all(model["exportMaxAbsoluteError"] < 2e-4 for model in report["models"])
            )

    def test_corrupt_provenance_and_incomplete_data_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="guandan-counterfactual-") as temporary:
            directory = Path(temporary)
            metadata, rollout = write_fixture(directory / "data", rows=80)
            altered = {**metadata, "extraFeaturesSHA256": "0" * 64}
            (directory / "data/metadata.json").write_text(json.dumps(altered), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "feature hash"):
                CounterfactualData([directory / "data"])
            (directory / "data/metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
            (directory / "data/rollout.json").write_text(
                json.dumps({**rollout, "completedGames": 0}), encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "deal count"):
                CounterfactualData([directory / "data"])
            (directory / "data/rollout.json").write_text(json.dumps(rollout), encoding="utf-8")
            write_fixture(directory / "overlap", rows=80, first_seed=22000010)
            with self.assertRaisesRegex(ValueError, "share deal seeds"):
                CounterfactualData([directory / "data", directory / "overlap"])
            target_path = directory / "data/targets.f32"
            targets = np.fromfile(target_path, dtype="<f4")
            targets[0] = 0.5
            targets.tofile(target_path)
            with self.assertRaisesRegex(ValueError, "branch returns"):
                CounterfactualData([directory / "data"])


if __name__ == "__main__":
    unittest.main()
