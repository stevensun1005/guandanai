import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('grid_summary',Path(__file__).parents[2]/'danMCai/evaluation/summarize-round-pairs.py')
summary=importlib.util.module_from_spec(spec);spec.loader.exec_module(summary)

class GridTest(unittest.TestCase):
    def data(self):
        def rows(points):
            return {i:{'games':[{'signedPoints':v,'dealSHA256':str(i),'level':2,'leader':0}]*2} for i,v in enumerate(points)}
        return {'mix':rows([1,2,3]),'a':rows([0,1,2]),'b':rows([2,3,4])}
    def specification(self):
        return [{'id':'gap','terms':[{'task':'mix','weight':1},{'task':'a','weight':-.5},{'task':'b','weight':-.5}]}]
    def test_common_fluctuation_cancels_in_paired_interaction(self):
        result=summary.cooperation_interactions(self.data(),self.specification())['gap']
        self.assertEqual(result['mean'],0)
        self.assertEqual(result['standardError'],0)
        self.assertEqual(result['familywise99CI'],[0,0])
        self.assertFalse(result['passesResultCondition'])
    def test_missing_or_different_deal_rejected(self):
        data=self.data();del data['a'][0]
        with self.assertRaisesRegex(ValueError,'common deal'):summary.cooperation_interactions(data,self.specification())
        data=self.data();data['b'][0]['games'][0]['dealSHA256']='other'
        with self.assertRaisesRegex(ValueError,'deals differ'):summary.cooperation_interactions(data,self.specification())

if __name__=='__main__':unittest.main()
