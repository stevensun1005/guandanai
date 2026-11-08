import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec=importlib.util.spec_from_file_location('summary',Path(__file__).resolve().parents[1]/'tools/summarize-match-017.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class MatchSummaryTest(unittest.TestCase):
    def test_truncation_and_winner_mismatch_rejected(self):
        with self.assertRaisesRegex(ValueError,'Truncated'):
            module.score({'history':[{}],'winner':0,'neuralTeam':0})
        with self.assertRaisesRegex(ValueError,'winner mismatch'):
            module.score({'history':[{'win':True,'team':1}],'winner':0,'neuralTeam':0})
        self.assertEqual(module.score({'history':[{'draw':True}],'winner':None,'neuralTeam':0}),0)

    def test_paired_equal_arms_have_exactly_zero_difference_interval(self):
        values=np.array([1.,0.,-.5,1.,-1.])
        self.assertEqual(module.interval(values-values,20261108),[0.,0.])


if __name__=='__main__':unittest.main()
