import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('trace_summary',Path(__file__).resolve().parents[1]/'tools/summarize-decision-trace.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class GapSummaryTest(unittest.TestCase):
    def test_quantiles_and_display_layer_count_are_descriptive_not_probabilities(self):
        d=module.describe([0,.05,.1,1,2])
        self.assertEqual(d['n'],5);self.assertEqual(d['quantiles']['p50'],.1)
        self.assertEqual(d['fractionAtLeastPoint1'],.6)
        self.assertEqual(d['fractionPoint05Through1'],.6)
        self.assertEqual(module.describe([]),{'n':0})


if __name__=='__main__':unittest.main()
