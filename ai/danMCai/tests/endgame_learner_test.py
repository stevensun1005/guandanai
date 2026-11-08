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
from learner import ORACLE, OracleValueNet, keep_probability  # noqa: E402
from value_net import FEATURES, ValueNet, export_onnx, load_onnx_weights  # noqa: E402

BASELINE = ROOT / "models" / "baseline" / "policy.onnx"


class EndgameLearnerTest(unittest.TestCase):
    def test_keep_schedule(self):
        self.assertEqual(keep_probability(0, 100), 1.0)
        self.assertAlmostEqual(keep_probability(50, 100), 0.5)
        self.assertEqual(keep_probability(100, 100), 0.0)
        self.assertEqual(keep_probability(500, 100), 0.0)

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


if __name__ == "__main__":
    unittest.main()
