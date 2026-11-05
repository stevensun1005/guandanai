import asyncio,json,pathlib,struct,subprocess,sys,tempfile,time,unittest
import numpy as np
import torch
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/guanzero'))
from model import GuanZeroNet,export_onnx
from inference import decode_request,infer_batch
(ROOT/'work/guanzero').mkdir(parents=True,exist_ok=True)
class InferenceTest(unittest.TestCase):
    def test_variable_candidate_batch_and_cuda_parity(self):
        torch.set_num_threads(1);torch.manual_seed(81);net=GuanZeroNet().eval();rng=np.random.default_rng(81)
        requests=[{'state':rng.integers(-1,3,513).astype('float32'),'history':rng.integers(-1,3,(5,216)).astype('float32'),'actions':rng.integers(0,3,(n,54)).astype('float32')} for n in [1,7,31]]
        expected=[net(torch.from_numpy(r['state'][None]),torch.from_numpy(r['history'][None]),torch.from_numpy(r['actions'])).detach().numpy().reshape(-1) for r in requests]
        for device in ['cpu']+(['cuda'] if torch.cuda.is_available() else []):
            net=net.to(device)
            actual=infer_batch(net,requests,device)
            for a,b in zip(actual,expected):self.assertLess(float(np.max(np.abs(a-b))),1e-5)
    def test_protocol_rejects_truncation_and_invalid_sizes(self):
        for body in [b'',struct.pack('<II',0,0),struct.pack('<II',0,1),struct.pack('<II',0,16385)]:
            with self.assertRaises(ValueError):decode_request(body)
        payload=struct.pack('<II',99,2)+np.full(1593+108,-1,dtype=np.int8).tobytes()
        version,r=decode_request(payload);self.assertEqual(version,99);self.assertEqual(r['actions'].shape,(2,54));self.assertEqual(float(r['state'][0]),-1)
    def test_live_versioned_service_node_client_and_complete_matches(self):
        torch.set_num_threads(1);torch.manual_seed(81)
        with tempfile.TemporaryDirectory(dir=ROOT/'work/guanzero') as folder:
            root=pathlib.Path(folder);(root/'models').mkdir()
            for version in [0,1]:
                net=GuanZeroNet();torch.save(net.state_dict(),root/'models'/f'model-{version:012d}.weights.pt');export_onnx(net,root/'models'/f'model-{version:012d}.onnx')
            import socket
            with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            device='cuda' if torch.cuda.is_available() else 'cpu'
            process=subprocess.Popen([sys.executable,str(ROOT/'scripts/guanzero/inference.py'),'--run',str(root),'--port',str(port),'--device',device],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            try:
                for _ in range(200):
                    if (root/'inference/status.json').exists():break
                    if process.poll() is not None:self.fail(process.stderr.read().decode())
                    time.sleep(.05)
                script=ROOT/'tests/guanzero-inference-probe.mjs'
                result=subprocess.run(['node',str(script),str(root),str(port)],cwd=ROOT,capture_output=True,text=True,timeout=180)
                self.assertEqual(result.returncode,0,result.stderr)
                report=json.loads(result.stdout);self.assertEqual(report['actionMismatches'],0);self.assertEqual(report['matches'],4)
                self.assertLess(report['maxError'],1e-5)
                (root/'STOP').write_text('test complete');process.wait(timeout=10)
                self.assertEqual(process.returncode,0)
            finally:
                if process.poll() is None:process.kill();process.wait()
                process.stderr.close()
if __name__=='__main__':unittest.main()
