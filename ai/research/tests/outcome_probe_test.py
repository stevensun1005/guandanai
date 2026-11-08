import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import numpy as np

TOOL = Path(__file__).resolve().parents[1]/'tools/probe-outcome-residual.py'
spec = importlib.util.spec_from_file_location('outcome_probe',TOOL)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class OutcomeProbeTest(unittest.TestCase):
    def test_complete_deal_split_is_deterministic_and_not_row_based(self):
        splits = [probe.split_deal(s,'new-statistical-seed') for s in range(1000)]
        self.assertEqual(splits,[probe.split_deal(s,'new-statistical-seed') for s in range(1000)])
        self.assertEqual(set(splits),{0,1,2})
        self.assertNotEqual(splits,[probe.split_deal(s,'other-seed') for s in range(1000)])

    def test_weighted_ridge_intercept_scaling_and_constant_column(self):
        rng = np.random.default_rng(192603)
        x = np.column_stack((rng.normal(size=500),100*rng.normal(size=500),np.ones(500)))
        y, w = 2+3*x[:,0]-.1*x[:,1],rng.uniform(.1,2,500)
        moment = [w.sum(),w@x,w@y,x.T@(w[:,None]*x),x.T@(w*y)]
        beta, intercept = probe.ridge(moment,np.arange(3),1e-9)
        np.testing.assert_allclose(x@beta+intercept,y,atol=1e-6)

    def test_paired_bootstrap_preserves_covariance_and_negative_r2(self):
        errors = np.arange(1,21,dtype=float)[:,None]*np.array([[1,2,3,3,4,4]])
        result = probe.paired_intervals(errors,234923,200)
        self.assertEqual(result['point'][0],-1)
        np.testing.assert_allclose(result['ci95'][-2:],[[0,0],[0,0]])

    def test_real_cli_stop_before_missing_data_model_or_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run/'campaign-task.json').write_text(json.dumps({'window':{'deadlineUTC':'2026-11-11T16:45:00Z'}}))
            (run/'protocol.json').write_text(json.dumps({'deadlineUTC':'2026-11-11T16:45:00Z'}))
            (run/'STOP').touch()
            result = subprocess.run([sys.executable,'-X','utf8',str(TOOL),'--run',directory],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('STOP or fixed deadline',result.stderr)
            self.assertFalse((run/'probe.lock').exists())
            self.assertFalse((run/'status.json').exists())


if __name__ == '__main__':
    unittest.main()
