"""Two temporary synthetic GPU updates and matching Adam restore; not strength evidence."""
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import numpy as np
import onnxruntime as ort
import torch

parser = argparse.ArgumentParser(__doc__)
parser.add_argument('--belief', required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('belief_preflight', Path(__file__).resolve().parents[2]/'danMCai/belief/train.py')
train = importlib.util.module_from_spec(spec)
spec.loader.exec_module(train)
torch.set_num_threads(1)
torch.manual_seed(2026111429)
assert torch.cuda.is_available(), 'Actual CUDA-interface GPU required'
device = torch.device('cuda:0')
net = train.BeliefNet(1238,270,np.zeros(1238),np.ones(1238)).to(device)
initial_sha = train.load_initial_onnx(net,args.belief)
x = np.zeros((32,1238),np.float32)
x[:,270:274] = 27
x[:,54:108] = 1
tensor = torch.from_numpy(x).to(device)
net.eval()
session = ort.InferenceSession(args.belief,providers=['CPUExecutionProvider'])
expected = session.run(None,{'features':x})[0]
with torch.no_grad(): actual = net(tensor).exp().cpu().numpy()
delta = float(np.abs(expected-actual).max())
assert delta < 1e-5, delta
optimizer = torch.optim.AdamW(net.parameters(),lr=3e-5,weight_decay=.01)
y = torch.ones((32,162),device=device)
for _ in range(2):
    loss = train.copy_loss(net(tensor),y)
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    assert all(p.grad is not None and torch.isfinite(p.grad).all() for p in net.parameters())
    optimizer.step()
with tempfile.TemporaryDirectory(dir=args.out.parent) as temporary:
    file = Path(temporary)/'checkpoint.pt'
    torch.save({'state':net.state_dict(),'optimizer':optimizer.state_dict()},file)
    saved = torch.load(file,map_location=device,weights_only=True)
    restored = train.BeliefNet(1238,270,np.zeros(1238),np.ones(1238)).to(device)
    restored.load_state_dict(saved['state'])
    adam = torch.optim.AdamW(restored.parameters(),lr=3e-5,weight_decay=.01)
    adam.load_state_dict(saved['optimizer'])
    assert len(adam.state)==6
    for a,b in zip(net.parameters(),restored.parameters()): torch.testing.assert_close(a,b,atol=0,rtol=0)
    for a,b in zip(optimizer.state.values(),adam.state.values()):
        for key in ['exp_avg','exp_avg_sq','step']: torch.testing.assert_close(a[key],b[key],atol=0,rtol=0)
result = {'passed':True,'backendActuallyTested':'cuda:0','device':torch.cuda.get_device_name(0),
          'torch':torch.__version__,'hip':torch.version.hip,'initialBeliefSHA256':initial_sha,
          'warmStartProbabilityMaxDifference':delta,'syntheticOptimizerSteps':2,'matchingAdamStates':6,
          'newGames':0,'strengthEvidence':False,'syntheticSeed':2026111429}
args.out.write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result))
