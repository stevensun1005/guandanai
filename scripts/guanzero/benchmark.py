"""Thirty updates on the same real actor samples; not a playing-strength evaluation."""
import argparse,copy,json,time
from pathlib import Path
import numpy as np
import torch
from model import GuanZeroNet,optimizer,update
from learner import load_batch
parser=argparse.ArgumentParser();parser.add_argument('--shards',required=True);parser.add_argument('--output',required=True)
args=parser.parse_args();torch.set_num_threads(1);torch.manual_seed(20261104)
x,y,_,_=load_batch(Path(args.shards),{},3200)
base=GuanZeroNet();results={};models={}
a=torch.from_numpy(x[:16].astype('float32'))
with torch.no_grad():
    cpu=base(a[:,:513],a[:,513:1593].reshape(-1,5,216),a[:,1593:])
    gpu=copy.deepcopy(base).cuda()(a[:,:513].cuda(),a[:,513:1593].reshape(-1,5,216).cuda(),a[:,1593:].cuda()).cpu()
    results['maxInitialForwardError']=float((cpu-gpu).abs().max())
for device in ['cpu','cuda']:
    model=copy.deepcopy(base).to(device);optim=optimizer(model)
    # Warm up a separate model so measured devices have identical initial weights.
    warm=copy.deepcopy(model);update(warm,optimizer(warm),x,y[:,0],device);del warm
    if device=='cuda':torch.cuda.synchronize();torch.cuda.reset_peak_memory_stats()
    start=time.perf_counter()
    for _ in range(30): loss=update(model,optim,x,y[:,0],device)
    if device=='cuda':torch.cuda.synchronize()
    elapsed=time.perf_counter()-start
    results[device]={'seconds':elapsed,'updatesPerSecond':30/elapsed,'loss':loss,'threads':1,
        'peakBytes':torch.cuda.max_memory_allocated() if device=='cuda' else None}
    models[device]=model.cpu()
results['maxParameterErrorAfter30Updates']=max(float((models['cpu'].state_dict()[k]-v).abs().max()) for k,v in models['cuda'].state_dict().items())
with torch.no_grad():
    a=torch.from_numpy(x[:16].astype('float32'))
    inputs=(a[:,:513],a[:,513:1593].reshape(-1,5,216),a[:,1593:])
    results['maxValueErrorAfter30Updates']=float((models['cpu'](*inputs)-models['cuda'](*inputs)).abs().max())
results.update({'steps':30,'batchSize':3200,'torch':torch.__version__,'device':torch.cuda.get_device_name(0),'precision':'FP32','purpose':'compute-only, repeated fixed batch, not training data consumption'})
Path(args.output).write_text(json.dumps(results,indent=2));print(json.dumps(results))
