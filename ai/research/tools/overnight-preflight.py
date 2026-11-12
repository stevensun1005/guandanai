"""Disposable ordinary-017 ROCm update/Adam roundtrip; never playing-strength evidence."""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import sys

parser = argparse.ArgumentParser(__doc__)
parser.add_argument('--campaign', type=Path, required=True)
args = parser.parse_args()
root = args.campaign
plan = json.loads((root/'plan.json').read_bytes())
run = root/'experiments/preflight'
task = json.loads((run/'campaign-task.json').read_bytes())
assert not (root/'STOP').exists() and not (run/'STOP').exists()
assert datetime.now(timezone.utc) < datetime.fromisoformat(task['window']['deadlineUTC'].replace('Z','+00:00'))
assert hashlib.sha256(Path(task['protocol']).read_bytes()).hexdigest() == task['protocolSHA256']
network = Path(plan['teacher'])
assert hashlib.sha256(network.read_bytes()).hexdigest() == plan['teacherSHA256']
sys.path.insert(0, str(Path(plan['sourceRoot'])/'ai/danMCai/training/continuous'))
import torch
from value_net import ValueNet, load_onnx_weights
torch.set_num_threads(1)
torch.manual_seed(202611120)
assert torch.cuda.is_available()
model = ValueNet(load_onnx_weights(network)).to('cuda:0')
optimizer = torch.optim.Adam(model.parameters(), lr=3e-6)
x = torch.randn(64,567,device='cuda:0')
y = torch.tensor([1,-1,2,-2,3,-3,1,-1]*8,device='cuda:0',dtype=torch.float32)
loss = ((model(x)-y)**2).mean()
loss.backward()
assert len(list(model.parameters())) == 12
assert all(p.grad is not None and torch.isfinite(p.grad).all() for p in model.parameters())
optimizer.step()
buffer = io.BytesIO()
torch.save({'model': model.state_dict(), 'optimizer': optimizer.state_dict()}, buffer)
buffer.seek(0)
saved = torch.load(buffer, weights_only=True, map_location='cpu')
copy = ValueNet(load_onnx_weights(network))
copy.load_state_dict(saved['model'])
restored = torch.optim.Adam(copy.parameters(), lr=3e-6)
restored.load_state_dict(saved['optimizer'])
assert len(restored.state) == 12
assert all(int(s['step']) == 1 for s in restored.state.values())
assert hashlib.sha256(network.read_bytes()).hexdigest() == plan['teacherSHA256']
result = {'passed': True, 'device': torch.cuda.get_device_name(), 'torch': torch.__version__, 'hip': torch.version.hip, 'gradientParameterGroups': 12, 'adamStates': 12, 'syntheticOptimizerUpdates': 1, 'realRunUpdates': 0, 'strengthGames': 0, 'teacherSHA256': plan['teacherSHA256'], 'loss': float(loss.detach()), 'atUTC': datetime.now(timezone.utc).isoformat()}
(run/'results.json').write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(result))
