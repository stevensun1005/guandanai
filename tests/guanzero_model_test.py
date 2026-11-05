import json, pathlib, subprocess, sys, tempfile, unittest
import numpy as np
import torch
import onnxruntime as ort
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/guanzero'))
(ROOT/'work/guanzero').mkdir(parents=True,exist_ok=True)
from model import GuanZeroNet, export_onnx, replace_atomic
from unittest.mock import patch
class ModelTest(unittest.TestCase):
    def test_atomic_replace_retries_only_transient_failures(self):
        with patch('model.os.replace',side_effect=[PermissionError('busy'),PermissionError('busy'),None]) as rename, patch('model.time.sleep'):
            replace_atomic('temporary','target')
            self.assertEqual(rename.call_count,3)
        with patch('model.os.replace',side_effect=PermissionError('permanent')) as rename, patch('model.time.sleep'):
            with self.assertRaises(PermissionError):replace_atomic('temporary','target')
            self.assertEqual(rename.call_count,20)
        with patch('model.os.replace',side_effect=FileNotFoundError('missing')) as rename:
            with self.assertRaises(FileNotFoundError):replace_atomic('temporary','target')
            self.assertEqual(rename.call_count,1)

    def test_export_python_and_node(self):
        torch.set_num_threads(1); torch.manual_seed(61)
        model=GuanZeroNet().eval()
        self.assertEqual(sum(p.numel() for p in model.parameters()),1584641)
        rng=np.random.default_rng(61)
        with tempfile.TemporaryDirectory(dir=ROOT/'work/guanzero') as folder:
            file=pathlib.Path(folder)/'model.onnx'; export_onnx(model,file)
            session=ort.InferenceSession(str(file),providers=['CPUExecutionProvider'])
            for count in [1,7,43]:
                data={'state':rng.integers(-1,3,(1,513)).astype('float32'),
                    'history':rng.integers(-1,3,(1,5,216)).astype('float32'),
                    'actions':rng.integers(0,3,(count,54)).astype('float32')}
                with torch.no_grad(): expected=model(*(torch.from_numpy(data[k]) for k in ['state','history','actions'])).numpy()
                actual=session.run(None,data)[0]
                self.assertLess(float(np.max(np.abs(expected-actual))),1e-5)
                payload=pathlib.Path(folder)/'input.json'
                payload.write_text(json.dumps({k:{'data':v.flatten().tolist(),'dims':list(v.shape)} for k,v in data.items()}))
                code="import * as ort from 'onnxruntime-node';import{readFileSync}from'node:fs';const d=JSON.parse(readFileSync(process.argv[2]));const s=await ort.InferenceSession.create(process.argv[1],{intraOpNumThreads:1});const r=await s.run(Object.fromEntries(Object.entries(d).map(([k,v])=>[k,new ort.Tensor('float32',Float32Array.from(v.data),v.dims)])));console.log(JSON.stringify(Array.from(r.values.data)));await s.release();"
                node=json.loads(subprocess.check_output(['node','--input-type=module','-e',code,str(file),str(payload)],cwd=ROOT))
                self.assertLess(float(np.max(np.abs(expected.flatten()-node))),1e-5)
if __name__=='__main__':unittest.main()
