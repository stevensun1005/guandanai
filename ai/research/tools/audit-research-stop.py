"""Read-only audit of a stopped campaign task. Never imports or starts a training loop."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
read = lambda p: json.loads(Path(p).read_text(encoding='utf-8'))


def sha(p):
    with Path(p).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def alive(pid):
    # Python os.kill(pid, 0) is not a harmless probe on Windows. Use Node's documented probe.
    probe = subprocess.run(['node', '-e', 'try{process.kill(Number(process.argv[1]),0)}catch(e){process.exit(e.code==="ESRCH"?1:2)}', str(pid)], capture_output=True)
    if probe.returncode not in [0, 1]:
        raise RuntimeError('Unable to verify process exit')
    return probe.returncode == 0


def audit(run, frozen):
    import torch
    torch.set_num_threads(1)
    sys.path.insert(0, str(frozen / 'ai/danMCai/training/continuous'))
    from value_net import ValueNet, load_onnx_weights
    state, learner, config = (read(run/p) for p in ['status.json','learner/status.json','config.json'])
    task=read(run/'campaign-task.json')
    assert state.get('stoppedAt') and not state.get('running') and learner['state']=='stopped'
    assert not alive(state['pid']) and not alive(learner['pid'])
    assert sha(Path(task['protocol']))==task['protocolSHA256']
    assert not task['window']['restartExtendsDeadline']
    parse=lambda s:datetime.fromisoformat(s.replace('Z','+00:00'))
    assert parse(state['stoppedAt'])>=parse(task['window']['deadlineUTC'])
    for name,digest in config['sourceSHA256'].items():
        assert hashlib.sha256((frozen/name).read_bytes().replace(b'\r\n',b'\n')).hexdigest()==digest,name
    latest=read(run/'models/latest.json')
    assert sha(run/'models'/latest['file'])==latest['sha256']
    saved=torch.load(run/'learner/checkpoint.pt',weights_only=True,map_location='cpu')
    assert saved['step']==learner['step']==latest['step']
    for field in ['trainedRows','ingestedRows']:
        assert saved[field]==learner[field]==latest[field]
    net=ValueNet(load_onnx_weights(run/'models'/latest['file']))
    assert all(torch.equal(v,saved['model'][k]) for k,v in net.state_dict().items())
    assert len(saved['optimizer']['state'])==len(list(net.parameters()))==12
    assert all(int(s['step'])==saved['step'] and all(torch.isfinite(v).all() for v in s.values())
               for s in saved['optimizer']['state'].values())
    spec=importlib.util.spec_from_file_location('stop_audit',ROOT/'ai/research/tools/audit-continuous-stop.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    shards=module.audit_shards(run/'shards',saved['countedShards'])
    actors=module.audit_actor_logs(run/'actors',config['actorSeedOffset'])
    assert not any(alive(a['pid']) for a in actors)
    assert sum(a['matches'] for a in actors)==state['totals']['matches']
    assert sum(a['decisions'] for a in actors)==state['totals']['decisions']==state['totals']['rows']
    return {'schema':1,'kind':'stopped-campaign-integrity-not-strength','passed':True,
       'observedAtUTC':datetime.now(timezone.utc).isoformat(),'run':str(run),
       'task':task,'stoppedAtUTC':state['stoppedAt'],
       'exitDelaySeconds':(parse(state['stoppedAt'])-parse(task['window']['deadlineUTC'])).total_seconds(),
       'latest':latest,'checkpointSHA256':sha(run/'learner/checkpoint.pt'),
       'matchingNetworkAndAdam':True,'adamStates':12,'adamStep':saved['step'],
       'parent':config['parent'],'sourceSHA256':config['sourceSHA256'],
       'actors':actors,'replay':shards,'totals':state['totals'],
       'tailRowsNotInCheckpoint':shards['pendingRows'],'optimizerUpdatesDuringAudit':0,
       'preservedHistory':True,'webChampionChanged':False,
       'limitations':'Retained replay only; evicted samples, original in-memory ring/RNG not recovered.'}


if __name__=='__main__':
    p=argparse.ArgumentParser(__doc__)
    p.add_argument('--run',type=Path,required=True);p.add_argument('--frozen-source',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    assert not args.output.resolve().is_relative_to(args.run.resolve())
    result=audit(args.run,args.frozen_source)
    args.output.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'passed':True,'version':result['latest']['version'],'step':result['latest']['step'],
                     'retainedRows':result['replay']['retainedRows'],'pendingRows':result['replay']['pendingRows']}))
