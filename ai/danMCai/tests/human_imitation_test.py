import importlib.util
from pathlib import Path
import unittest
import torch

spec=importlib.util.spec_from_file_location('human_imitation',Path(__file__).parents[1]/'training/human_imitation.py')
learner=importlib.util.module_from_spec(spec);spec.loader.exec_module(learner)

class HumanImitationTests(unittest.TestCase):
    def test_ragged_choice_loss_and_gradient_match_independent_cross_entropy(self):
        x=torch.tensor([.2,-.1,.8,.7,-.2],dtype=torch.float64,requires_grad=True)
        groups=torch.tensor([0,0,1,1,1]);targets=torch.tensor([1,3])
        actual=learner.grouped_loss(x,groups,targets,2)
        expected=(torch.nn.functional.cross_entropy(x[:2][None],torch.tensor([1]))+
                  torch.nn.functional.cross_entropy(x[2:][None],torch.tensor([1])))/2
        self.assertTrue(torch.allclose(actual,expected,atol=1e-12))
        ga=torch.autograd.grad(actual,x,retain_graph=True)[0];gb=torch.autograd.grad(expected,x)[0]
        self.assertTrue(torch.allclose(ga,gb,atol=1e-12))
        self.assertEqual(learner.argmax_groups(x.detach(),groups,2).tolist(),[0,2])
        self.assertAlmostEqual(float(learner.grouped_loss(x.detach()+100,groups,targets,2)),float(actual.detach()),places=12)

    def test_batches_bound_decisions_and_rows_without_dropping_or_repeating(self):
        rows=[{'length':3},{'length':5},{'length':2},{'length':12}]
        batches=list(learner.batches([0,1,2,3],rows,batch_size=2,row_cap=7))
        self.assertEqual(batches,[[0],[1,2],[3]])

if __name__=='__main__':unittest.main()
