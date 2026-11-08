import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('audit',Path(__file__).parents[1]/'tools/audit-research-seeds.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)

class RangeAudit(unittest.TestCase):
    def test_probe_seed_domain_above_billion_and_uint32_boundary(self):
        self.assertEqual(audit.candidate_seeds(1_800_000_000).start,1_800_000_000)
        self.assertEqual(list(audit.candidate_seeds(2**32-2)),[2**32-2,2**32-1])
        with self.assertRaises(ValueError):audit.candidate_seeds(2**32)
    def test_literal_and_wrapped_derived_overlap(self):
        root=2**32-1
        deal=(root*1009+3)%(2**32)
        self.assertTrue(audit.range_conflicts({deal},[[root,root+1]],[]))
        alias=(root+pow(1009,-1,2**32))%(2**32)
        self.assertTrue(audit.range_conflicts({root},[[alias,alias+1]],[]))

    def test_intervals_match_brute_force_derived_intersection(self):
        for other in [103,1800000000,(100+pow(1009,-1,2**32))%(2**32)]:
            proposed=[[100,103],[other,other+3]]
            sets=[{(n*1009+r)%(2**32) for n in range(lo,hi) for r in range(200)} for lo,hi in proposed]
            flagged=any(x['kind']=='new-range-derived' for x in audit.range_conflicts(set(),proposed,[]))
            self.assertEqual(flagged,bool(sets[0]&sets[1]))

    def test_unused_reservations_and_fresh_interval(self):
        self.assertTrue(audit.range_conflicts(set(),[[100,110]],[[105,106]]))
        self.assertEqual(audit.range_conflicts({1},[[100,110]],[]),[])

if __name__=='__main__':unittest.main()
