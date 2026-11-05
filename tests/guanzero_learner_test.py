import json, pathlib, subprocess, sys, tempfile, unittest
import numpy as np
import torch
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/guanzero'))
(ROOT/'work/guanzero').mkdir(parents=True,exist_ok=True)
from model import GuanZeroNet,optimizer,update
from learner import load_batch,atomic_checkpoint
class LearnerTest(unittest.TestCase):
    def test_update_changes_every_parameter_and_rejects_nan(self):
        torch.set_num_threads(1);torch.manual_seed(15)
        model=GuanZeroNet();optim=optimizer(model)
        before={k:v.clone() for k,v in model.state_dict().items()}
        x=np.random.default_rng(15).integers(-1,3,(16,1647),dtype=np.int8)
        self.assertTrue(np.isfinite(update(model,optim,x,np.ones(16),'cpu')))
        for k,v in model.state_dict().items():self.assertFalse(torch.equal(v,before[k]),k)
        with self.assertRaises(FloatingPointError):update(model,optim,x,np.full(16,np.nan),'cpu')
    def test_fifo_atomic_resume_exactly_once(self):
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory(dir=ROOT/'work/guanzero') as folder:
            root=pathlib.Path(folder)
            for sub in ['models','shards','learner']: (root/sub).mkdir()
            (root/'config.json').write_text(json.dumps({'seed':5,'device':'cpu','learnerThreads':1,'objective':'adp','batchSize':4}))
            rng=np.random.default_rng(17)
            all_x=rng.integers(-1,3,(10,1647),dtype=np.int8)
            y=np.array([[i%3+1,1] for i in range(10)],dtype='<f4')
            # Deliberately reverse filename order; FIFO follows publication time.
            for name,created,start,end in [('z','2026-01-01',0,5),('a','2026-01-02',5,10)]:
                (root/'shards'/f'{name}.json').write_text(json.dumps({'schema':1,'features':1647,'targets':['adp','wp'],'rows':end-start,'createdAt':created}))
                all_x[start:end].tofile(root/'shards'/f'{name}.x.i8');y[start:end].tofile(root/'shards'/f'{name}.y.f32')
            first=load_batch(root/'shards',{},4)
            np.testing.assert_array_equal(first[0],all_x[:4])
            # An uncommitted read can be retried; only the checkpoint commits use.
            np.testing.assert_array_equal(load_batch(root/'shards',{},4)[0],first[0])
            command=[sys.executable,str(ROOT/'scripts/guanzero/learner.py'),'--run',str(root)]
            subprocess.run(command+['--max-steps=1'],check=True,capture_output=True)
            saved=torch.load(root/'learner/state.pt',weights_only=False)
            self.assertEqual(saved['used'],4);self.assertEqual(saved['consumed'],{'z.json':4})
            np.testing.assert_array_equal(load_batch(root/'shards',saved['consumed'],4)[0],all_x[4:8])
            subprocess.run(command+['--max-steps=2'],check=True,capture_output=True)
            resumed=torch.load(root/'learner/state.pt',weights_only=False)
            self.assertEqual(resumed['used'],8);self.assertEqual(resumed['step'],2)
            self.assertEqual(resumed['consumed'],{'z.json':5,'a.json':3})
            self.assertIsNone(load_batch(root/'shards',resumed['consumed'],4))
            self.assertFalse((root/'shards/z.json').exists())
            self.assertTrue((root/'models/model-000000000002.onnx').exists())
            portable=GuanZeroNet();portable.load_state_dict(resumed['model'])
            if torch.cuda.is_available():
                portable.cuda();portable.cpu()
            self.assertEqual(len(resumed['optimizer']['state']),len(list(portable.parameters())))
if __name__=='__main__':unittest.main()
