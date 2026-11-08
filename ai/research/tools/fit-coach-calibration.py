"""Offline self-only monotone G-delta fit and fresh-root evaluation; never imported by UI."""
import argparse
from datetime import datetime,timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
import numpy as np

ROOT=Path(__file__).resolve().parents[3]
read=lambda p:json.loads(Path(p).read_bytes())
now=lambda:datetime.now(timezone.utc).isoformat()


def sha(path):
    with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def write(path,value):
    temp=Path(str(path)+'.tmp');temp.write_text(json.dumps(value,indent=2,allow_nan=False)+'\n',encoding='utf-8',newline='\n');os.replace(temp,path)


def stage(hand):
    return '27..20' if 20<=hand<=27 else '19..10' if 10<=hand<=19 else '9..1' if 1<=hand<=9 else None


def pava(x,y,w):
    blocks=[]
    for i in np.argsort(x,kind='stable'):
        block={'lo':float(x[i]),'hi':float(x[i]),'weight':float(w[i]),'weightedY':float(w[i]*y[i])}
        blocks.append(block)
        while len(blocks)>1 and (blocks[-2]['hi']==blocks[-1]['lo'] or blocks[-2]['weightedY']/blocks[-2]['weight']>=blocks[-1]['weightedY']/blocks[-1]['weight']):
            b=blocks.pop();a=blocks.pop();blocks.append({'lo':a['lo'],'hi':b['hi'],'weight':a['weight']+b['weight'],'weightedY':a['weightedY']+b['weightedY']})
    return {'n':len(x),'minX':float(min(x)),'maxX':float(max(x)),'thresholds':[b['lo'] for b in blocks],'values':[b['weightedY']/b['weight'] for b in blocks],'trainingWeightedMean':float(np.sum(w*y)/np.sum(w))}


def predict(mapping,x):
    if not mapping or x<mapping['minX'] or x>mapping['maxX']:return None
    return mapping['values'][int(np.searchsorted(mapping['thresholds'],x,side='right'))-1]


def fit_self(rows,min_cases=50):
    groups={k:[] for k in ['27..20','19..10','9..1']};roots=0
    for row in rows:
        if row['task']!='self':continue  # Never use Clint/mixed/P0 labels for fitting.
        roots+=1;c=row['choice']
        if c is None or not .05<=c['predictedGap']<=1:continue
        k=stage(c['ownHandCount']);y=row['realizedDelta'];w=c['weight']
        if k is None or not -6<=y<=6 or not np.isfinite(w) or w<=0:raise ValueError('Invalid final-round fitting row')
        groups[k].append((c['predictedGap'],y,w))
    maps={}
    for k,values in groups.items():
        if len(values)<min_cases:maps[k]=None;continue
        a=np.array(values);maps[k]=pava(a[:,0],a[:,1],a[:,2])
    return {'schema':1,'trainingTask':'self','selfRoots':roots,'displayCases':sum(map(len,groups.values())),'gapRange':[.05,1],'stages':maps,'interpolation':'left-constant PAVA step; outside empirical stage support returns unavailable','lossTarget':'Final-round baseline own-team signed upgrade minus one-forced-action upgrade','negativePredictionsPreserved':True,'scope':'Offline research artifact only; no policy/neural training, Clint fitting, calibrated UI, D1, probability or recommendation export.'}


def guard(run,plan):
    task=read(run/'campaign-task.json')
    if sha(run/'protocol.json')!=task['protocolSHA256']:raise ValueError('Registered protocol changed')
    deadline=min(datetime.fromisoformat(v.replace('Z','+00:00')) for v in [plan['evaluationDeadlineUTC'],task['window']['deadlineUTC']])
    def stop():return (run/'STOP').exists() or (run.parent.parent/'STOP').exists() or datetime.now(timezone.utc)>=deadline
    if stop():raise RuntimeError('STOP or fixed deadline')
    spec=importlib.util.spec_from_file_location('research_memory',Path(__file__).with_name('probe-outcome-residual.py'));memory=importlib.util.module_from_spec(spec);spec.loader.exec_module(memory)
    paused=False
    def check():
        nonlocal paused
        if stop():raise RuntimeError('STOP or fixed deadline')
        while memory.available_gib()<(5 if paused else 4):
            paused=True;time.sleep(1)
            if stop():raise RuntimeError('STOP or fixed deadline')
        paused=False
    check();return check


def fit_registered(run):
    plan=read(run/'protocol.json');check=guard(run,plan)
    if (run/'status.json').exists():raise ValueError('Existing fit; no repeated model selection')
    with (run/'calibration-fit.lock').open('x',encoding='utf-8') as stream:json.dump({'pid':os.getpid()},stream)
    state={'pid':os.getpid(),'phase':'analysis','startedAtUTC':now(),'optimizerUpdates':0,'strengthGames':0,'completedPositions':0,'plannedPositions':2500,'positionUnit':'个已有自博弈根（离线统计拟合）'}
    try:
        write(run/'status.json',state)
        if subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip()!=plan['sourceSHA']:raise ValueError('Frozen source HEAD changed')
        for name,digest in plan['sourceSHA256'].items():
            check()
            if sha(ROOT/name)!=digest:raise ValueError('Frozen source changed')
        rows=[]
        for name,digest in plan['dataFiles'].items():
            check();file=Path(plan['dataRun'])/name
            if sha(file)!=digest:raise ValueError('Fitting data changed')
            rows.extend(json.loads(line) for line in file.read_text(encoding='utf-8').splitlines())
        artifact=fit_self(rows);artifact.update(teacherSHA256=plan['teacherSHA256'],sourceSHA=plan['sourceSHA'],sourceDataProtocolSHA256=plan['dataProtocolSHA256'])
        if artifact['selfRoots']!=2500 or artifact['displayCases']!=1906:raise ValueError('Unexpected frozen self cohort')
        check();encoded=json.dumps(artifact,indent=2,allow_nan=False).encode()
        if len(encoded)>50000:raise ValueError('Offline map exceeds preregistered50KB')
        write(run/'calibration.offline.json',artifact)
        result={'schema':1,'phase':'complete','completedAtUTC':now(),'sourceSHA':plan['sourceSHA'],'selfRoots':artifact['selfRoots'],'displayCases':artifact['displayCases'],'stageCases':{k:v['n'] if v else 0 for k,v in artifact['stages'].items()},'mapBytes':(run/'calibration.offline.json').stat().st_size,'mapSHA256':sha(run/'calibration.offline.json'),'opponentLabelsUsedForFit':False,'optimizerUpdates':0,'scope':'Deterministic development fit only. No independent predictive validation or calibrated UI authorization.'}
        write(run/'results.json',result);state.update(phase='complete',completedPositions=2500,completedAtUTC=result['completedAtUTC']);write(run/'status.json',state)
    except Exception as e:state.update(phase='failed',error=str(e),updatedAtUTC=now());write(run/'status.json',state);raise
    finally:(run/'calibration-fit.lock').unlink(missing_ok=True)


def paired_metrics(errors,w,seed,replicates=4000,check=lambda:None):
    def values(i):
        means=np.sum(errors[i]*w[i,None],axis=-2)/np.sum(w[i],axis=-1)[...,None]
        return np.stack([means[...,0]-means[...,1],means[...,2]-means[...,1],means[...,3]-means[...,1]],axis=-1)
    point=values(np.arange(len(w)));rng=np.random.default_rng(seed);draws=[]
    for start in range(0,replicates,100):
        check();i=rng.integers(len(w),size=(min(100,replicates-start),len(w)));draws.extend(values(i))
    a=np.array(draws)
    return {'names':['rawMinusCalibratedMSE','zeroMinusCalibratedMSE','selfStageMeanMinusCalibratedMSE'],'point':point.tolist(),'ci95':np.quantile(a,[.025,.975],axis=0).T.tolist(),'ci99':np.quantile(a,[.005,.995],axis=0).T.tolist(),'simultaneous95PrimaryTwoGroups':np.quantile(a,[.0125,.9875],axis=0).T.tolist()}


def validate(protocol,run):
    plan=read(protocol);check=guard(run,plan)
    if sha(plan['calibrationFile'])!=plan['calibrationSHA256']:raise ValueError('Frozen offline map changed')
    artifact=read(plan['calibrationFile'])
    if artifact['teacherSHA256']!=plan['models']['champion']['sha256'] or artifact['trainingTask']!='self':raise ValueError('Wrong calibration lineage')
    spec=importlib.util.spec_from_file_location('deviation_summary',Path(__file__).with_name('summarize-deviation-pairs.py'));legacy=importlib.util.module_from_spec(spec);spec.loader.exec_module(legacy)
    diagnostics=legacy.summarize(protocol,run);rows={}
    for file in run.glob('worker-*.jsonl'):
        for line in file.read_text(encoding='utf-8').splitlines():
            r=json.loads(line);rows[(r['task'],r['seed'])]=r
    results={}
    for index,task in enumerate(plan['tasks']):
        errors=[];weights=[];display=0;weight_all=0
        for seed in task['seeds']:
            r=rows[(task['id'],seed)];c=r['choice']
            if c is None or not .05<=c['predictedGap']<=1:continue
            display+=1;weight_all+=c['weight'];mapping=artifact['stages'][stage(c['ownHandCount'])];q=predict(mapping,c['predictedGap'])
            if q is None:continue
            y=r['realizedDelta'];errors.append([(y-c['predictedGap'])**2,(y-q)**2,y*y,(y-mapping['trainingWeightedMean'])**2]);weights.append(c['weight'])
        if len(errors)<2:raise ValueError('Insufficient supported calibration cases; no fallback')
        err,w=np.array(errors),np.array(weights);metrics=paired_metrics(err,w,plan['bootstrapSeed']+1000+index,plan['bootstrapReplicates'],check)
        results[task['id']]={'newRoots':len(task['seeds']),'displayCases':display,'supportedCases':len(w),'coverageCount':len(w)/display,'coverageWeight':float(w.sum()/weight_all),'mseOrder':['rawGap','offlinePava','zero','frozenSelfStageMean'],'weightedMSE':(np.sum(err*w[:,None],axis=0)/w.sum()).tolist(),'pairedMSEDifferences':metrics}
    supported=all(results[k]['coverageCount']>=.95 and results[k]['coverageWeight']>=.95 for k in ['self','clint'])
    lower=all(results[k]['pairedMSEDifferences']['simultaneous95PrimaryTwoGroups'][0][0]>0 for k in ['self','clint'])
    return {'schema':1,'phase':'complete','completedAtUTC':now(),'calibrationSHA256':plan['calibrationSHA256'],'tasks':results,'offlinePrimaryRawMSECondition':bool(supported and lower),'rawDeviationDiagnostics':diagnostics,'optimizerUpdates':0,'strengthGames':0,'scope':'Fresh-root numerical forecast validation only; common supported display layer, no calibrated UI, policy update, probability, strength acceptance or promotion. Clint/mixed/P0 were evaluation-only, never map fitting.'}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--fit-run',type=Path);parser.add_argument('--protocol',type=Path);parser.add_argument('--results',type=Path);parser.add_argument('--output',type=Path);args=parser.parse_args()
    if args.fit_run:fit_registered(args.fit_run)
    else:write(args.output,validate(args.protocol,args.results))
