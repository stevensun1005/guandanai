"""Policy probability, clipping, trajectory and artifact checks for local PPO."""

import argparse
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import torch

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT / "ai/danMCai/training"))
from ppo_learning import FEATURES, PPOEngine, initialize_weights, policy_outputs, load_actor  # noqa: E402
from train_ppo import ActorCritic, Rollouts, ppo_loss, train  # noqa: E402


class PPOTests(unittest.TestCase):
    def test_numpy_torch_masked_actor_and_critic_match(self):
        random = np.random.default_rng(14)
        weights = initialize_weights()
        for branch in ("actor", "critic"):
            weights[f"{branch}_w1"] = random.normal(0, 0.02, (64, 1)).astype(np.float32)
        features = random.normal(size=(4, FEATURES)).astype(np.float32)
        reference = np.array([0, -0.2, -1, 500], np.float32)
        mask = np.array([1, 1, 1, 0], bool)
        expected_log, expected_value = policy_outputs(weights, features, reference, mask)
        model = ActorCritic(weights)
        with torch.no_grad():
            actual_log, actual_value = model(
                torch.from_numpy(features[None]),
                torch.from_numpy(reference[None]),
                torch.from_numpy(mask[None]),
            )
        np.testing.assert_allclose(actual_log.numpy()[0], expected_log, atol=2e-6)
        self.assertAlmostEqual(actual_value.item(), expected_value, places=6)
        self.assertEqual(np.exp(expected_log[3]), 0)
        # A large padded feature must not affect either the actor normalization or critic.
        features[3] = 1e5
        changed_log, changed_value = policy_outputs(weights, features, reference, mask)
        np.testing.assert_array_equal(changed_log, expected_log)
        self.assertEqual(changed_value, expected_value)

    def test_clipping_handles_positive_and_negative_advantages(self):
        class FixedPolicy:
            def __call__(self, features, reference, mask):
                return torch.log(torch.tensor([[0.9, 0.1], [0.9, 0.1]])), torch.zeros(2)

        loss, metrics = ppo_loss(
            FixedPolicy(),
            torch.zeros(2, 2, FEATURES),
            torch.zeros(2, 2),
            torch.ones(2, 2, dtype=torch.bool),
            torch.tensor([0, 1]),
            torch.full((2, 2), float(np.log(0.5))),
            torch.zeros(2),
            torch.tensor([1.0, -1.0]),
            torch.ones(2),
            entropy_weight=0,
            reference_kl_weight=0,
        )
        self.assertAlmostEqual(loss.item(), -0.2, places=6)
        self.assertAlmostEqual(metrics["clipFraction"].item(), 1)

    def test_padded_candidates_receive_no_gradient(self):
        features = torch.randn(2, 4, FEATURES, requires_grad=True)
        reference = torch.tensor([[0.0, -0.2, 0, 0], [0.0, -0.1, 0, 0]])
        masks = torch.tensor([[True, True, False, False], [True, True, False, False]])
        model = ActorCritic(initialize_weights())
        old_log, _ = model(features.detach(), reference, masks)
        loss, _ = ppo_loss(
            model,
            features,
            reference,
            masks,
            torch.tensor([0, 1]),
            old_log.detach(),
            torch.tensor([1.2, -1.1]),
            torch.tensor([1.0, -1.0]),
            torch.ones(2),
        )
        loss.backward()
        self.assertTrue(torch.isfinite(loss))
        self.assertEqual(float(features.grad[~masks].abs().sum()), 0)
        self.assertGreater(float(model.actor[-1].weight.grad.abs().sum()), 0)

    def test_complete_trajectories_train_and_reload_with_exact_behavior(self):
        with tempfile.TemporaryDirectory(prefix="guandan-ppo-") as temporary:
            directory = Path(temporary)
            data = directory / "data"
            engine = PPOEngine(ROOT / "ai/danMCai/models/baseline/policy.onnx", k=4)
            random = np.random.default_rng(12)
            features = random.normal(size=(4, FEATURES)).astype(np.float32)
            engine.prepare = lambda state: (
                np.array([4, 1]),
                features.copy(),
                np.array([0, -0.3, 0, 0], np.float32),
                np.array([1, 1, 0, 0], np.float32),
            )
            engine.proposal.score = lambda state: (
                np.array([0, 0.2, 0.9, 0.1, -0.1], np.float32),
                None,
                None,
            )
            engine.initialize({"output": str(data), "seed": 71, "options": {"games": 12}})
            for episode in range(12):
                for seat in (0, 1):
                    reply = engine.decide(
                        {"episode": episode, "seat": seat, "state": {"counts": [27] * 4}}
                    )
                    self.assertIn(reply["index"], [4, 1])
                late = engine.decide(
                    {"episode": episode, "seat": 1, "state": {"counts": [0, 27, 27, 27]}}
                )
                self.assertEqual(late["index"], 2)
                self.assertEqual(int(engine.score({"counts": [0, 27, 27, 27]}).argmax()), 2)
                finished = engine.finish(
                    {"episode": episode, "winner": episode % 2, "points": 1 + episode % 3}
                )
                self.assertEqual(finished["stored"], 2)
            engine.close()
            buffers = Rollouts([data])
            self.assertEqual(buffers.rows, 24)
            # Opposing seats get exactly opposite terminal rewards from the same round.
            np.testing.assert_allclose(buffers.aux[::2, 14], -buffers.aux[1::2, 14])
            buffers.close()
            report = train(
                argparse.Namespace(
                    datasets=[str(data)],
                    output=str(directory / "trained"),
                    epochs=2,
                    batch=8,
                    learning_rate=0.0003,
                    clip=0.2,
                    entropy=0.01,
                    reference_kl=0.01,
                    max_kl=1.0,
                    threads=1,
                    seed=88,
                )
            )
            self.assertLess(report["behaviorAudit"]["maxLogProbabilityError"], 2e-5)
            _, config, metadata = load_actor(directory / "trained/ppo.npz")
            self.assertEqual(config, engine.config)
            self.assertNotEqual(metadata["policySHA256"], engine.policy_hash)
            trained_engine = PPOEngine(directory / "trained/ppo.npz")
            self.assertEqual(trained_engine.policy_hash, metadata["policySHA256"])
            trained_engine.close()


if __name__ == "__main__":
    unittest.main()
