"""Privileged information is restricted to the critic in collection and optimization."""

import importlib.util
from pathlib import Path
import sys
import unittest

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from full_model import initial_parameters  # noqa: E402
from team_model import critic_state, initialize_critic, critic_value, log_probs  # noqa: E402
from train_team import Buffer, Critic, distributions  # noqa: E402
from train_full_policy import CompleteNetwork  # noqa: E402

spec = importlib.util.spec_from_file_location("team_runner", ROOT / "scripts/run-team-study.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class TeamTrainingTests(unittest.TestCase):
    def test_critic_reads_current_private_hands_while_public_control_is_zero_padded(self):
        hands = [list(range(i * 27, (i + 1) * 27)) for i in range(4)]
        state = {
            "p": 0,
            "hand": hands[0],
            "counts": [27] * 4,
            "log": [],
            "level": 2,
            "selfLevel": 2,
            "opponentLevel": 2,
            "match": {
                "levels": [2, 2],
                "aFails": [0, 0],
                "lvlTeam": 0,
                "round": 1,
                "previousOrder": None,
            },
        }
        first = critic_state(state, {"hands": hands}, True)
        changed = [h.copy() for h in hands]
        changed[1][0], changed[2][0] = changed[2][0], changed[1][0]
        second = critic_state(state, {"hands": changed}, True)
        np.testing.assert_array_equal(first[:521], second[:521])
        self.assertTrue(np.any(first[521:] != second[521:]))
        public = critic_state(state, {"hands": hands}, False)
        self.assertTrue(np.all(public[521:] == 0))
        changed[1][0] = changed[2][0]
        with self.assertRaisesRegex(ValueError, "conservation"):
            critic_state(state, {"hands": changed}, True)
        weights = initialize_critic()
        self.assertEqual(critic_value(weights, first), 0)
        torch.set_num_threads(1)
        self.assertEqual(float(Critic(weights)(torch.from_numpy(first)).detach()), 0)

    def test_training_actor_cannot_receive_the_critic_private_feature_columns(self):
        buffer = object.__new__(Buffer)
        rng = np.random.default_rng(61)
        buffer.states = rng.standard_normal((1, 683)).astype(np.float32)
        buffer.actions = np.zeros((3, 109), np.float32)
        buffer.actions[:, :107] = rng.standard_normal((3, 107)) * 0.1
        buffer.records = [{"offset": 0, "count": 3, "chosen": 1}]
        raw, critic, *_ = buffer.batch([0])
        buffer.states[:, 521:] += 100
        changed, critic_changed, *_ = buffer.batch([0])
        torch.testing.assert_close(raw, changed, rtol=0, atol=0)
        self.assertFalse(torch.equal(critic, critic_changed))

    def test_full_actor_gradients_reach_all_layers_and_distributions_match_numpy(self):
        torch.set_num_threads(1)
        model = CompleteNetwork(initial_parameters())
        model.unfreeze("full")
        x = torch.from_numpy(
            np.random.default_rng(12).standard_normal((8, 628)).astype(np.float32) * 0.2
        )
        probabilities = distributions(model, x, [3, 5], 0.03)
        with torch.no_grad():
            expected = log_probs(model(x[:3]).numpy().reshape(-1), 0.03)
        np.testing.assert_allclose(probabilities[0].detach().numpy(), expected, atol=2e-5)
        loss = -probabilities[0][1] - probabilities[1][2]
        loss.backward()
        for layer in [model.first, *model.hidden, model.value]:
            self.assertGreater(float(layer.weight.grad.abs().sum()), 0)
        self.assertGreater(float(model.extras.weight.grad.abs().sum()), 0)
        self.assertEqual(sum(p.numel() for p in model.parameters() if p.requires_grad), 1373185)

    def test_review_preserves_the_problem_and_team_but_refreshes_continuation_and_excludes_self(
        self,
    ):
        history = [
            {"opponent": "rule", "winner": 1, "neuralTeam": 0, "problemSeed": 100},
            {"opponent": "self", "winner": 1, "neuralTeam": 0, "problemSeed": 101},
        ]
        plan = runner.collection_plan(61000104, 1, 16, True, history)
        reviews = [p for p in plan if p["review"]]
        self.assertEqual(len(reviews), 8)
        self.assertTrue(
            all(p["problemSeed"] == 100 and p["team"] == 0 and p["mode"] == "rule" for p in reviews)
        )
        self.assertEqual(len({p["continuationSeed"] for p in plan}), len(plan))
        self.assertTrue(
            all(not p["review"] for p in runner.collection_plan(61000104, 1, 16, False, history))
        )


if __name__ == "__main__":
    unittest.main()
