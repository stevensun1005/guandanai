"""FIFO DMC learner. Each durable optimizer update commits its sample cursor atomically."""
import argparse
import json
import os
from pathlib import Path
import signal
import time
from collections import deque
import numpy as np
import torch
from model import GuanZeroNet, atomic_json, export_onnx, optimizer, update
FEATURES=1647

def load_batch(directory, consumed, size):
    manifests=[]
    for file in Path(directory).glob('*.json'):
        meta=json.loads(file.read_text(encoding='utf-8'))
        manifests.append((meta['createdAt'],file.name,file,meta))
    xs,ys,remaining=[],[],size
    cursor=dict(consumed)
    exhausted=[]
    for _,_,file,meta in sorted(manifests):
        if meta['schema']!=1 or meta['features']!=FEATURES or meta['targets']!=['adp','wp']:
            raise ValueError(f'Invalid GuanZero shard schema: {file}')
        offset=cursor.get(file.name,0)
        if offset==meta['rows']:
            exhausted.append(file); continue
        if not 0<=offset<meta['rows']: raise ValueError('Invalid durable sample cursor')
        x=np.fromfile(file.with_suffix('.x.i8'),dtype=np.int8)
        y=np.fromfile(file.with_suffix('.y.f32'),dtype='<f4')
        if x.size!=meta['rows']*FEATURES or y.size!=meta['rows']*2: raise ValueError(f'Truncated shard {file}')
        take=min(remaining,meta['rows']-offset)
        xs.append(x.reshape(-1,FEATURES)[offset:offset+take].copy())
        ys.append(y.reshape(-1,2)[offset:offset+take].copy())
        cursor[file.name]=offset+take;remaining-=take
        if cursor[file.name]==meta['rows']:exhausted.append(file)
        if remaining==0: return np.concatenate(xs),np.concatenate(ys),cursor,exhausted
    return None

def atomic_checkpoint(file, payload):
    file=Path(file); temporary=file.with_name(file.name+f'.{os.getpid()}.tmp')
    with temporary.open('wb') as stream:
        torch.save(payload,stream);stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,file)

def cleanup(files):
    for file in files:
        for item in [file,file.with_suffix('.x.i8'),file.with_suffix('.y.f32')]:
            item.unlink(missing_ok=True)

def run(args):
    root=Path(args.run).resolve(); config=json.loads((root/'config.json').read_text(encoding='utf-8'))
    device=args.device or config['device']
    torch.set_num_threads(config.get('learnerThreads',1))
    torch.manual_seed(config['seed'])
    model=GuanZeroNet().to(device);optim=optimizer(model)
    state=root/'learner'/'state.pt';status_file=root/'learner'/'status.json'
    step,consumed,used,losses=0,{},0,deque(maxlen=100)
    if state.exists():
        saved=torch.load(state,map_location=device,weights_only=False)
        if saved['objective']!=config['objective']:raise ValueError('Cannot change objective on resume')
        model.load_state_dict(saved['model']);optim.load_state_dict(saved['optimizer'])
        step,consumed,used=saved['step'],saved['consumed'],saved['used']
        losses.extend(saved['losses'])
    def snapshot():
        return {'model':model.state_dict(),'optimizer':optim.state_dict(),'step':step,'used':used,
            'consumed':consumed,'losses':list(losses),'objective':config['objective']}
    stopping=False
    def stop(*_):
        nonlocal stopping
        stopping=True
    signal.signal(signal.SIGINT,stop);signal.signal(signal.SIGTERM,stop)
    started=time.monotonic();initial_step=step;last_export=-float('inf');last_archive=time.monotonic();published=None
    def publish():
        nonlocal last_export,published
        if published!=step:
            file=f'model-{step:012d}.onnx'
            export_onnx(model,root/'models'/file)
            atomic_json(root/'models'/'latest.json',{'file':file,'version':step,'updatedAt':time.time()})
            published=step
            models=sorted((root/'models').glob('model-*.onnx'))
            for old in models[:-5]:
                try: old.unlink()
                except PermissionError:pass
        last_export=time.monotonic()
    def status(error=None):
        result={'step':step,'usedSamples':used,'loss':sum(losses)/len(losses) if losses else None,
            'updatesPerSecond':(step-initial_step)/max(1e-6,time.monotonic()-started),'device':device,
            'deviceName':torch.cuda.get_device_name(0) if device.startswith('cuda') else device,
            'torch':torch.__version__,'precision':'FP32','objective':config['objective'],
            'updatedAt':time.time(),'error':error,'pid':os.getpid()}
        atomic_json(status_file,result)
    if not state.exists():atomic_checkpoint(state,snapshot())
    publish();status()
    if args.init_only:return
    try:
        while not stopping and not (root/'STOP').exists():
            batch=load_batch(root/'shards',consumed,config['batchSize'])
            if batch is None:
                if time.monotonic()-last_export>=60:publish()
                status();time.sleep(1);continue
            x,y,cursor,exhausted=batch
            loss=update(model,optim,x,y[:,0 if config['objective']=='adp' else 1],device)
            step+=1;used+=len(x);consumed=cursor;losses.append(loss)
            # Model, optimizer and cursor are a single recovery transaction. A failed
            # write never advances the durable cursor; a committed update is not replayed.
            atomic_checkpoint(state,snapshot())
            cleanup(exhausted)
            if time.monotonic()-last_export>=60:publish()
            if time.monotonic()-last_archive>=1800:
                atomic_checkpoint(root/'learner'/f'checkpoint-{step:012d}.pt',snapshot())
                last_archive=time.monotonic()
            status()
            if args.max_steps and step>=args.max_steps:break
        publish();status()
    except Exception as error:
        status(str(error));raise

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--run',required=True);parser.add_argument('--device')
    parser.add_argument('--objective',choices=['adp','wp'])
    parser.add_argument('--init-only',action='store_true');parser.add_argument('--max-steps',type=int,default=0)
    args=parser.parse_args()
    if args.objective:
        config_file=Path(args.run)/'config.json'
        if json.loads(config_file.read_text())['objective']!=args.objective:
            parser.error('Objective must match frozen run config; choose it with run.mjs --objective=wp')
    run(args)
