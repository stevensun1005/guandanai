"""Registered synthetic GPU gradient/export/Adam check, never chess-strength evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from datetime import datetime, timezone


def main(run):
    read = lambda p: json.loads(p.read_bytes())
    plan, task = read(run/'protocol.json'), read(run/'campaign-task.json')
    if hashlib.sha256((run/'protocol.json').read_bytes()).hexdigest() != task['protocolSHA256']:
        raise ValueError('Unregistered preflight')
    def checkpoint():
        if (run/'STOP').exists() or datetime.now(timezone.utc) >= datetime.fromisoformat(task['window']['deadlineUTC'].replace('Z','+00:00')):
            raise RuntimeError('Preflight stopped')
    checkpoint()
    if (run/'results.json').exists(): raise ValueError('Preflight already completed')
    source=Path(plan['sourceRoot'])
    for f,h in plan['sourceSHA256'].items():
        assert hashlib.sha256((source/f).read_bytes()).hexdigest()==h, f
    import numpy as np
    import torch
    sys.path.insert(0,str(source/'ai/danMCai/training/continuous'))
    from value_net import ValueNetExtras,load_onnx_weights,export_onnx_extras
    assert torch.cuda.is_available()
    torch.set_num_threads(1);torch.manual_seed(plan['optimizerSeed'])
    weights=load_onnx_weights(plan['teacher'])
    initial=run/'initial-zero-extras.onnx'
    export_onnx_extras(weights,initial)
    observations=[]
    for mode in ['zero','public']:
        checkpoint()
        net=ValueNetExtras(weights).to('cuda:0');opt=torch.optim.Adam(net.parameters(),lr=1e-5)
        x=torch.randn(64,567,device='cuda:0')
        e=torch.zeros(64,53,device='cuda:0') if mode=='zero' else torch.rand(64,53,device='cuda:0')
        y=torch.tensor([1,-1,2,-2,3,-3,1,-1]*8,device='cuda:0',dtype=torch.float32)
        opt.zero_grad(set_to_none=True);loss=((net(x,e)-y)**2).mean();loss.backward()
        assert all(p.grad is not None and torch.isfinite(p.grad).all() for p in net.parameters())
        extra_gradient=int(torch.count_nonzero(net.extra_weight.grad))
        assert (extra_gradient==0)==(mode=='zero')
        torch.nn.utils.clip_grad_norm_(net.parameters(),1);opt.step()
        assert len(opt.state)==13
        with tempfile.TemporaryDirectory(dir=run) as d:
            p=Path(d)/'check.pt';torch.save({'model':net.state_dict(),'optimizer':opt.state_dict()},p)
            saved=torch.load(p,weights_only=True,map_location='cpu')
            restored=ValueNetExtras(weights);restored.load_state_dict(saved['model'])
            ropt=torch.optim.Adam(restored.parameters(),lr=1e-5);ropt.load_state_dict(saved['optimizer'])
            assert all(torch.equal(v.cpu(),restored.state_dict()[k]) for k,v in net.state_dict().items())
            assert len(ropt.state)==13
        exported=run/f'{mode}-updated.onnx'
        export_onnx_extras(net.weights(),exported,net.extra_weight.detach().cpu().numpy())
        observations.append({'mode':mode,'loss':float(loss.detach()),'extraGradientNonzero':extra_gradient,'adamStates':13,'matchingRestoredAdam':True})
    checkpoint()
    result={'schema':1,'purpose':plan['purpose'],'device':torch.cuda.get_device_name(0),'torch':torch.__version__,'hip':torch.version.hip,
        'optimizerUpdates':2,'syntheticOnly':True,'newGames':0,'strengthEvidence':False,'checks':observations,
        'initialSHA256':hashlib.sha256(initial.read_bytes()).hexdigest(),'stoppedAtUTC':datetime.now(timezone.utc).isoformat()}
    (run/'results.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--run',type=Path,required=True);main(p.parse_args().run)
