"""Package the exact evaluated search composition locally; never publish or include trajectories."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile
import importlib.util
import tempfile
import numpy as np
import torch

parser = argparse.ArgumentParser(__doc__)
parser.add_argument('--run', type=Path, required=True)
args = parser.parse_args()
root = args.run
plan = json.loads((root/'protocol.json').read_text(encoding='utf-8'))
result = json.loads((root/'results.json').read_text(encoding='utf-8'))
final = json.loads((root/'final-model.json').read_text(encoding='utf-8'))
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
files = {'champion.onnx': Path(plan['models']['champion']['localFile']),
         'belief.onnx': root/'model/belief.onnx'}
assert sha(files['champion.onnx']) == final['championSHA256']
assert sha(files['belief.onnx']) == final['beliefSHA256']
spec = importlib.util.spec_from_file_location('belief_package_audit',Path(__file__).resolve().parents[2]/'danMCai/belief/train.py')
train = importlib.util.module_from_spec(spec)
spec.loader.exec_module(train)
checkpoint = torch.load(root/'model/checkpoint.pt',map_location='cpu',weights_only=True)
assert checkpoint['step'] == final['steps']
assert len(checkpoint['optimizer']['state']) == 6
assert all(int(s['step']) == final['steps'] for s in checkpoint['optimizer']['state'].values())
net = train.BeliefNet(1238,270,np.zeros(1238),np.ones(1238),hidden=checkpoint['hidden'])
net.load_state_dict(checkpoint['state'],strict=True)
with tempfile.TemporaryDirectory(dir=root) as temporary:
    assert train.export_onnx(net,Path(temporary)/'audit.onnx') == final['beliefSHA256']
(root/'stop-audit.json').write_text(json.dumps({'passed':True,'networkMatchesCheckpoint':True,
    'matchingAdamStates':6,'step':checkpoint['step'],'checkpointSHA256':sha(root/'model/checkpoint.pt'),
    'RNGorReplayExactResumptionClaimed':False},indent=2),encoding='utf-8')
manifest = {'kind':'029-reason research composition', 'models':final, 'search':plan['search'],
            'accepted':result['accept'], 'deploymentAuthorized':False,
            'sourceCommit':plan['sourceCommit'], 'protocolSHA256':sha(root/'protocol.json'),
            'note':'Both ONNX files plus the pinned repository search engine are required. Not a standalone fused policy.'}
(root/'package-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
with zipfile.ZipFile(root/'reason-029-research.zip','x',zipfile.ZIP_DEFLATED) as archive:
    for name,file in files.items(): archive.write(file,name)
    for name in ['package-manifest.json','results.json','protocol.json','final-model.json','stop-audit.json']:
        archive.write(root/name,name)
print(json.dumps({'package':str(root/'reason-029-research.zip'),'sha256':sha(root/'reason-029-research.zip'),'accepted':result['accept']}))
