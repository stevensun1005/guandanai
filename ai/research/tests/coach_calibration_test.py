import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import numpy as np

spec=importlib.util.spec_from_file_location('calibration',Path(__file__).resolve().parents[1]/'tools/fit-coach-calibration.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class CoachCalibrationTest(unittest.TestCase):
    def test_weighted_pava_preserves_negative_values_and_duplicate_x(self):
        mapping=module.pava(np.array([.1,.2,.3,.3]),np.array([1.,-3.,2.,4.]),np.array([1.,3.,1.,1.]))
        self.assertEqual(mapping['values'],[-2.,3.]);self.assertEqual(module.predict(mapping,.2),-2.)
        self.assertIsNone(module.predict(mapping,.05));self.assertIsNone(module.predict(mapping,.4))

    def test_clint_and_other_opponent_targets_never_enter_self_fit(self):
        own=[{'task':'self','choice':{'predictedGap':x,'ownHandCount':27,'weight':1},'realizedDelta':y} for x,y in [(.1,-1),(.5,1)] for _ in range(50)]
        other=[{'task':name,'choice':{'predictedGap':.2,'ownHandCount':27,'weight':-999},'realizedDelta':1e99} for name in ['clint','mixed','p0']]
        self.assertEqual(module.fit_self(own+other),module.fit_self(own))
        self.assertIsNone(module.fit_self(own)['stages']['9..1'])

    def test_paired_error_intervals_retain_common_root_covariance(self):
        errors=np.arange(1,21,dtype=float)[:,None]*np.array([[4,1,6,1]])
        result=module.paired_metrics(errors,np.ones(20),20261108,200)
        self.assertEqual(result['point'][2],0);self.assertEqual(result['ci95'][2],[0,0]);self.assertGreater(result['ci95'][0][0],0)

    def test_registered_fit_actual_stop_before_data_or_output(self):
        with tempfile.TemporaryDirectory() as folder:
            run=Path(folder);protocol=run/'protocol.json';protocol.write_text(json.dumps({'evaluationDeadlineUTC':'2026-11-11T16:45:00Z'}));(run/'campaign-task.json').write_text(json.dumps({'protocolSHA256':hashlib.sha256(protocol.read_bytes()).hexdigest(),'window':{'deadlineUTC':'2026-11-11T16:45:00Z'}}));(run/'STOP').touch()
            r=subprocess.run([sys.executable,'-X','utf8',module.__file__,'--fit-run',str(run)],capture_output=True,text=True)
            self.assertNotEqual(r.returncode,0);self.assertIn('STOP or fixed deadline',r.stderr);self.assertFalse((run/'calibration.offline.json').exists());self.assertFalse((run/'calibration-fit.lock').exists())


if __name__=='__main__':unittest.main()
