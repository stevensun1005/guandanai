"""Version-pinned FP32 microbatched inference over loopback TCP."""
import argparse,asyncio,json,os,signal,struct,time
from collections import OrderedDict
from pathlib import Path
import numpy as np
import torch
from model import GuanZeroNet,atomic_json
MAX_ACTIONS=16384

def decode_request(payload):
    if len(payload)<8:raise ValueError('Short inference request')
    version,count=struct.unpack_from('<II',payload)
    if not 1<=count<=MAX_ACTIONS or len(payload)!=8+1593+54*count:raise ValueError('Invalid inference request shape')
    x=np.frombuffer(payload,offset=8,dtype=np.int8).astype(np.float32)
    return version,{'state':x[:513],'history':x[513:1593].reshape(5,216),'actions':x[1593:].reshape(count,54)}

@torch.inference_mode()
def infer_batch(model,requests,device):
    counts=[len(r['actions']) for r in requests]
    states=torch.from_numpy(np.stack([r['state'] for r in requests])).to(device)
    histories=torch.from_numpy(np.stack([r['history'] for r in requests])).to(device)
    actions=torch.from_numpy(np.concatenate([r['actions'] for r in requests])).to(device)
    indices=torch.from_numpy(np.repeat(np.arange(len(requests),dtype=np.int64),counts)).to(device)
    hidden=model.lstm(histories)[0][:,-1,:]
    values=model.dense(torch.cat((hidden[indices],states[indices],actions),dim=-1)).cpu().numpy().reshape(-1)
    if not np.isfinite(values).all():raise FloatingPointError('Non-finite inference values')
    return np.split(values,np.cumsum(counts)[:-1])

async def serve(root,port,device,max_batch=32,wait_ms=2):
    root=Path(root);folder=root/'inference';folder.mkdir(exist_ok=True)
    writers=set();queue=asyncio.Queue(maxsize=256);models=OrderedDict();started=time.monotonic()
    stats={'pid':os.getpid(),'device':device,'requests':0,'batches':0,'maxBatch':0,'error':None,'batchWaitMilliseconds':0.,'computeMilliseconds':0.}
    def status(ready=True):
        stats.update(ready=ready,updatedAt=time.time(),averageBatch=stats['requests']/max(1,stats['batches']),requestsPerSecond=stats['requests']/max(.001,time.monotonic()-started))
        atomic_json(folder/'status.json',stats)
    def model(version):
        if version not in models:
            file=root/'models'/f'model-{version:012d}.weights.pt'
            net=GuanZeroNet();net.load_state_dict(torch.load(file,map_location='cpu',weights_only=True));net.to(device).eval()
            models[version]=net
            while len(models)>16:models.popitem(last=False)
        models.move_to_end(version);return models[version]
    async def connection(reader,writer):
        writers.add(writer)
        try:
            while True:
                size=struct.unpack('<I',await reader.readexactly(4))[0]
                if size>8+1593+54*MAX_ACTIONS:raise ValueError('Inference frame too large')
                version,data=decode_request(await reader.readexactly(size))
                future=asyncio.get_running_loop().create_future()
                await queue.put((version,data,future))
                try:body=struct.pack('<I',0)+(await future).astype('<f4').tobytes()
                except Exception as error:body=struct.pack('<I',1)+str(error).encode('utf-8')[:4096]
                writer.write(struct.pack('<I',len(body))+body);await writer.drain()
        except (asyncio.IncompleteReadError,ConnectionError):pass
        except Exception:pass # Malformed clients cannot terminate the service.
        finally:
            writers.discard(writer)
            writer.close()
            try:await writer.wait_closed()
            except ConnectionError:pass
    async def worker():
        while True:
            items=[await queue.get()]
            if queue.qsize()<max_batch-1 and wait_ms:
                before=time.perf_counter()
                # Windows asyncio timers rounded a measured 2ms wait to ~15.5ms.
                # Python's sleep uses a high-resolution waitable timer; a worker keeps
                # the event loop free to collect requests without busy-waiting.
                if os.name=='nt':await asyncio.to_thread(time.sleep,wait_ms/1000)
                else:await asyncio.sleep(wait_ms/1000)
                stats['batchWaitMilliseconds']+=1000*(time.perf_counter()-before)
            while len(items)<max_batch and not queue.empty():items.append(queue.get_nowait())
            groups={}
            for item in items:groups.setdefault(item[0],[]).append(item)
            for version,group in groups.items():
                try:
                    before=time.perf_counter()
                    outputs=infer_batch(model(version),[g[1] for g in group],device)
                    stats['computeMilliseconds']+=1000*(time.perf_counter()-before)
                    for item,values in zip(group,outputs):
                        if not item[2].done():item[2].set_result(values)
                    stats['requests']+=len(group);stats['batches']+=1;stats['maxBatch']=max(stats['maxBatch'],len(group));stats['error']=None
                except Exception as error:
                    stats['error']=str(error)
                    for item in group:
                        if not item[2].done():item[2].set_exception(error)
    server=await asyncio.start_server(connection,'127.0.0.1',port,limit=1024*1024)
    task=asyncio.create_task(worker());status()
    try:
        async with server:
            while not (root/'STOP').exists():status();await asyncio.sleep(1)
    finally:
        server.close()
        for writer in list(writers):writer.close()
        task.cancel();await server.wait_closed();status(False)
        try:await task
        except asyncio.CancelledError:pass

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--run',required=True);p.add_argument('--port',type=int,default=8771);p.add_argument('--device',default='cuda');p.add_argument('--batch',type=int,default=32);p.add_argument('--wait-ms',type=float,default=2)
    args=p.parse_args();torch.set_num_threads(1)
    if not 1<=args.batch<=256 or not 0<=args.wait_ms<=50:p.error('Invalid batch configuration')
    asyncio.run(serve(args.run,args.port,args.device,args.batch,args.wait_ms))
