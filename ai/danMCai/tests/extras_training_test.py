"""Replay alignment and zero-control gradient semantics for opt-in extras training."""
from pathlib import Path
import sys
import unittest
import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'training/continuous'))
import importlib.util
spec=importlib.util.spec_from_file_location('extras_continuous_learner',Path(__file__).resolve().parents[1]/'training/continuous/learner.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
Replay=module.Replay
from value_net import ValueNetExtras


class ExtrasTrainingTest(unittest.TestCase):
    def test_replay_wrap_preserves_feature_target_extras_alignment(self):
        r = Replay(5, 202611081, 53)
        x = np.repeat(np.arange(9, dtype=np.int8)[:, None], 567, axis=1)
        y = np.repeat(np.arange(9, dtype=np.float32)[:, None], 4, axis=1)
        e = np.repeat(np.arange(9, dtype=np.float32)[:, None], 53, axis=1)
        r.add(x, y, e)
        a, b, c = r.batch(100)
        np.testing.assert_array_equal(a[:, 0], b[:, 0])
        np.testing.assert_array_equal(a[:, 0], c[:, 0])
        self.assertGreaterEqual(int(a[:, 0].min()), 4)

    def test_zero_control_has_zero_projection_gradient_public_input_has_signal(self):
        torch.set_num_threads(1)
        torch.manual_seed(202611082)
        net = ValueNetExtras()
        x = torch.ones(3, 567)
        net(x, torch.zeros(3, 53)).sum().backward()
        self.assertEqual(torch.count_nonzero(net.extra_weight.grad).item(), 0)
        net.zero_grad(set_to_none=True)
        net(x, torch.ones(3, 53)).sum().backward()
        self.assertGreater(torch.count_nonzero(net.extra_weight.grad).item(), 0)
        self.assertEqual(len(list(net.parameters())), 13)


if __name__ == '__main__': unittest.main()
