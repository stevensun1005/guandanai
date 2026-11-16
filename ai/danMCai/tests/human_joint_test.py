"""Joint loss isolation, schedule, checkpoint integration and no heldout-label leakage."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import torch

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'ai/danMCai/training/continuous'))
sys.path.insert(0,str(Path(__file__).parent))
from continuous_learner_test import write_run
from learner import Learner
from human_joint import HumanRegularizer, filtered_choice_terms
from human_imitation import grouped_loss,pack


def fixture(root):
    data=root/'human';data.mkdir()
    x=np.random.default_rng(5).integers(-1,3,(8,567),dtype=np.int8);x.tofile(data/'features.i8')
    rows=[{'start':2*i,'length':2,'target':i%2,'split':s,'match':m}
          for i,(s,m)in enumerate([('train','a'),('train','b'),('validation','c'),('test','d')])]
    (data/'decisions.json').write_text(json.dumps(rows),encoding='utf-8')
    sha=lambda f:hashlib.sha256((data/f).read_bytes()).hexdigest()
    (data/'manifest.json').write_text(json.dumps({'candidateRows':8,'features':567,
       'featureSHA256':sha('features.i8'),'decisionSHA256':sha('decisions.json')}),encoding='utf-8')
    return {'data':str(data),'dataSHA256':{f:sha(f)for f in ['features.i8','decisions.json','manifest.json']},
            'everyUpdates':4,'batchDecisions':2,'choiceWeight':.2,'candidateAnchorWeight':.1,
            'maxPasses':2,'seed':71}


class JointTests(unittest.TestCase):
    def test_actual_update_uses_terminal_loss_and_isolated_human_schedule(self):
        with tempfile.TemporaryDirectory()as d:
            root=write_run(d);cfg=json.loads((root/'config.json').read_text());cfg['humanImitation']=fixture(root)
            cfg['learner'].update(targetMatchWeight=0,anchorWeight=.1)
            shutil.copyfile(root/'models/v000000000.onnx',root/'models/anchor.onnx')
            (root/'config.json').write_text(json.dumps(cfg),encoding='utf-8')
            learner=Learner(root);h=learner.human
            ids=h.ids;x,groups,targets,_=pack(ids,h.decisions,h.features,learner.device)
            expected=.2*grouped_loss(learner.net(x),groups,targets,len(ids))
            actual=h.loss(learner.net,learner.anchor,0)
            self.assertTrue(torch.allclose(actual,expected,atol=1e-7))
            self.assertIsNone(h.loss(learner.net,learner.anchor,1))
            self.assertIsNone(h.loss(learner.net,learner.anchor,8))
            self.assertEqual([h.rows_used(i)for i in [0,1,4,5,8,100]],[0,2,2,4,4,4])
            before=[v.detach().clone()for v in learner.net.parameters()]
            learner.ingest();learner.train_step();learner.step_count=1;learner.publish();learner.status('training')
            self.assertTrue(any(not torch.equal(a,b)for a,b in zip(before,learner.net.parameters())))
            self.assertTrue(all(not p.requires_grad and p.grad is None for p in learner.anchor.parameters()))
            self.assertEqual(json.loads((root/'learner/status.json').read_text())['humanRowsUsed'],2)
            resumed=Learner(root)
            self.assertEqual(resumed.step,1);self.assertEqual(resumed.human.rows_used(resumed.step),2)
            self.assertIsNone(resumed.human.loss(resumed.net,resumed.anchor,resumed.step))

    def test_heldout_labels_never_change_loss_and_overlap_or_modified_bytes_fail(self):
        with tempfile.TemporaryDirectory()as d:
            root=Path(d);cfg=fixture(root);h=HumanRegularizer(cfg,torch.device('cpu'))
            net=torch.nn.Linear(567,1);reference=torch.nn.Linear(567,1);reference.load_state_dict(net.state_dict());reference.requires_grad_(False)
            forward=lambda model:lambda x:model(x).flatten()
            a=h.loss(forward(net),forward(reference),0)
            data=Path(cfg['data']);rows=json.loads((data/'decisions.json').read_text());rows[2]['target']=1-rows[2]['target'];rows[3]['target']=1-rows[3]['target']
            (data/'decisions.json').write_text(json.dumps(rows),encoding='utf-8')
            with self.assertRaisesRegex(ValueError,'fingerprint'):HumanRegularizer(cfg,torch.device('cpu'))
            sha=lambda f:hashlib.sha256((data/f).read_bytes()).hexdigest()
            mf=json.loads((data/'manifest.json').read_text());mf['decisionSHA256']=sha('decisions.json');(data/'manifest.json').write_text(json.dumps(mf),encoding='utf-8');cfg['dataSHA256']={f:sha(f)for f in cfg['dataSHA256']}
            other=HumanRegularizer(cfg,torch.device('cpu'));b=other.loss(forward(net),forward(reference),0)
            self.assertTrue(torch.equal(a,b))
            self.assertTrue(torch.equal(torch.autograd.grad(a,net.weight)[0],torch.autograd.grad(b,net.weight)[0]))
            rows[3]['match']='a';(data/'decisions.json').write_text(json.dumps(rows),encoding='utf-8');mf['decisionSHA256']=sha('decisions.json');(data/'manifest.json').write_text(json.dumps(mf),encoding='utf-8');cfg['dataSHA256']={f:sha(f)for f in cfg['dataSHA256']}
            with self.assertRaisesRegex(ValueError,'split overlap'):HumanRegularizer(cfg,torch.device('cpu'))

class FilteredJointTests(unittest.TestCase):
    def test_rejected_choice_has_zero_imitation_gradient_and_no_weight_amplification(self):
        q=torch.tensor([0.,1.,2.,0.,1.,2.],requires_grad=True)
        groups=torch.tensor([0,0,0,1,1,1]);targets=torch.tensor([0,5])
        ce,anchor,keep=filtered_choice_terms(q,q.detach(),groups,targets,2,2)
        expected=torch.nn.functional.cross_entropy(q[3:][None],torch.tensor([2]))/2
        self.assertEqual(keep.tolist(),[False,True]);self.assertTrue(torch.allclose(ce,expected))
        grad=torch.autograd.grad(ce,q)[0];self.assertTrue(torch.equal(grad[:3],torch.zeros(3)));self.assertEqual(float(anchor.detach()),0)

    def test_warmup_has_no_human_gradient_and_acceptance_counters_restore(self):
        with tempfile.TemporaryDirectory()as d:
            root=Path(d);cfg=fixture(root);cfg.update(gateTopK=2,enableAfterUTC='2030-01-01T00:00:00Z')
            h=HumanRegularizer(cfg,torch.device('cpu'));net=torch.nn.Linear(567,1);reference=torch.nn.Linear(567,1);reference.load_state_dict(net.state_dict());reference.requires_grad_(False)
            f=lambda model:lambda x:model(x).flatten()
            with patch('human_joint.time.time',return_value=0):
                self.assertIsNone(h.loss(f(net),f(reference),0));self.assertEqual(h.rows_used(1000),0);self.assertIsNone(h.features)
            with patch('human_joint.time.time',return_value=2_000_000_000):
                self.assertIsNotNone(h.loss(f(net),f(reference),4))
            self.assertEqual(h.state_dict(),{'attempted':2,'accepted':2,'rejected':0})
            other=HumanRegularizer(cfg,torch.device('cpu'));other.load_state_dict(h.state_dict());self.assertEqual(other.rows_used(100),2)
            with self.assertRaisesRegex(ValueError,'accounting'):other.load_state_dict({'attempted':1,'accepted':2,'rejected':0})


if __name__=='__main__':unittest.main()
