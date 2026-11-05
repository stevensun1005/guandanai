import importlib.util
from pathlib import Path
import unittest
import numpy as np

path=Path(__file__).resolve().parents[1]/'evaluation/summarize_independent.py'
spec=importlib.util.spec_from_file_location('summary',path)
summary=importlib.util.module_from_spec(spec);spec.loader.exec_module(summary)

class IndependentSummaryTests(unittest.TestCase):
    def test_draws_remain_in_win_denominator_and_cooperation_uses_own_denominators(self):
        total=np.array([2,1,0,1,4,1,1,2,1,3])
        m=summary.metrics(total)
        self.assertEqual(m['matchWinRate'],.5)
        self.assertEqual(m['matchScore'],.75)
        self.assertEqual(m['doubleDownRate'],.25)
        self.assertEqual(m['isolatedFirstRate'],.5)
    def test_pair_bootstrap_keeps_two_swapped_matches_together(self):
        rows=[[2,2,0,0,4,1,1,2,1,0],[2,0,2,0,4,1,1,2,1,0]]
        m=summary.estimates(rows,iterations=1000)
        self.assertEqual(m['matchWinRate']['estimate'],.5)
        self.assertEqual(m['matchWinRate']['bootstrap95'],[0.,1.])
        self.assertEqual(m,summary.estimates(rows,iterations=1000))

if __name__=='__main__':unittest.main()
