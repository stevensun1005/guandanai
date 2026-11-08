import importlib.util
from pathlib import Path
import unittest
import json
import subprocess
import sys
import tempfile
import numpy as np
spec=importlib.util.spec_from_file_location('deviation',Path(__file__).resolve().parents[1]/'tools/summarize-deviation-pairs.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class DeviationSummaryTest(unittest.TestCase):
    def test_weighted_slope_recovers_known_effect_and_paired_cluster_bootstrap(self):
        x=np.array([.1,.2,.4,.8]);w=np.array([3.,1/3,1.,2.]);r=module.weighted_fit(x,2*x,w,20261108,200)
        self.assertAlmostEqual(r['slope'],2);np.testing.assert_allclose(r['ci95'],[2,2])
        self.assertIsNone(module.weighted_fit(np.zeros(2),np.ones(2),np.ones(2),1,200)['slope'])

    def test_summary_cli_stop_prevents_data_reads_and_output(self):
        with tempfile.TemporaryDirectory() as folder:
            run=Path(folder);protocol=run/'protocol.json';protocol.write_text(json.dumps({'evaluationDeadlineUTC':'2026-11-11T16:45:00Z'}));(run/'STOP').touch()
            result=subprocess.run([sys.executable,'-X','utf8',str(Path(module.__file__)),'--protocol',str(protocol),'--results',str(run),'--output',str(run/'summary.json')],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0);self.assertIn('STOP or fixed deadline',result.stderr);self.assertFalse((run/'summary.json').exists())


if __name__=='__main__':unittest.main()
