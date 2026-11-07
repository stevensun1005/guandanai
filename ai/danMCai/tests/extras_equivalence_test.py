"""Zero-projection architecture and export tests; no optimizer or training loop."""
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import onnxruntime as ort
import torch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'ai/danMCai/training/continuous'))
from value_net import ValueNet, ValueNetExtras, export_onnx_extras, load_onnx_weights


class ExtrasEquivalenceTest(unittest.TestCase):
    def test_zero_projection_matches_base_torch_and_native_for_arbitrary_extras(self):
        torch.set_num_threads(1)
        weights = load_onnx_weights(ROOT / 'ai/danMCai/models/baseline/policy.onnx')
        base, student = ValueNet(weights), ValueNetExtras(weights)
        self.assertEqual(tuple(student.extra_weight.shape), (53, 512))
        self.assertEqual(torch.count_nonzero(student.extra_weight).item(), 0)
        rng = np.random.default_rng(11)
        features = rng.integers(0, 3, (17, 567)).astype(np.float32)
        extras = rng.normal(size=(17, 53)).astype(np.float32)
        with torch.no_grad():
            expected = base(torch.from_numpy(features)).numpy()
            actual = student(torch.from_numpy(features), torch.from_numpy(extras)).numpy()
        np.testing.assert_array_equal(expected, actual)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'student.onnx'
            export_onnx_extras(weights, path)
            options = ort.SessionOptions(); options.intra_op_num_threads = 1
            session = ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])
            self.assertEqual(set(i.name for i in session.get_inputs()), {'state','actions','extras'})
            # One public state shared by all candidate rows, matching the browser ABI.
            same = features.copy(); same[:, :513] = features[0, :513]
            with torch.no_grad():
                expected = base(torch.from_numpy(same)).numpy()
            values = session.run(['values'], {'state':same[:1,:513], 'actions':same[:,513:], 'extras':extras})[0].reshape(-1)
            np.testing.assert_allclose(values, expected, atol=1e-4, rtol=1e-4)
            for a,b in zip(load_onnx_weights(path),weights): np.testing.assert_array_equal(a,b)

    def test_invalid_extra_shape_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                export_onnx_extras([], Path(d)/'bad.onnx', np.zeros((52,512)))


if __name__ == '__main__':
    unittest.main()
