"""Importance-weighted final-round deviation diagnostics, never a policy/calibration export."""
import argparse
from datetime import datetime,timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import time
import numpy as np


def weighted_fit(x,y,w,seed,replicates=4000,check=lambda:None):
    if len(x)<2 or np.sum(w*x*x)<=0:return {'n':len(x),'slope':None,'ci95':None,'ci99':None}
    slope=float(np.sum(w*x*y)/np.sum(w*x*x));rng=np.random.default_rng(seed);draws=[]
    for start in range(0,replicates,100):
        check();i=rng.integers(len(x),size=(min(100,replicates-start),len(x)))
        numerator=np.sum(w[i]*x[i]*y[i],axis=1);denominator=np.sum(w[i]*x[i]*x[i],axis=1)
        if np.any(denominator<=0):raise ValueError('Degenerate bootstrap slope')
        draws.extend(numerator/denominator)
    mx,my=np.sum(w*x)/w.sum(),np.sum(w*y)/w.sum();variance=np.sum(w*(x-mx)**2)
    intercept_slope=float(np.sum(w*(x-mx)*(y-my))/variance) if variance>0 else None
    return {'n':len(x),'slope':slope,'ci95':np.quantile(draws,[.025,.975]).tolist(),'ci99':np.quantile(draws,[.005,.995]).tolist(),'weightedMeanPredictedGap':float(mx),'weightedMeanRealizedDelta':float(my),'effectiveSampleSize':float(w.sum()**2/np.sum(w*w)),'interceptSensitivity':None if intercept_slope is None else {'slope':intercept_slope,'intercept':float(my-intercept_slope*mx)}}


def point_bin(x,y,w):
    if not len(x):return {'n':0}
    mean=float(np.sum(w*y)/w.sum());n=len(x)
    se=float(np.sqrt(n/(n-1)*np.sum(w*w*(y-mean)**2))/w.sum()) if n>1 else None
    return {'n':n,'weightedPredictedGap':float(np.sum(w*x)/w.sum()),'weightedRealizedDelta':mean,'clusterStandardError':se,'effectiveSampleSize':float(w.sum()**2/np.sum(w*w))}


def summarize(protocol,run):
    plan=json.loads(protocol.read_bytes());digest=hashlib.sha256(protocol.read_bytes()).hexdigest()
    spec=importlib.util.spec_from_file_location('research_memory',Path(__file__).with_name('probe-outcome-residual.py'))
    memory=importlib.util.module_from_spec(spec);spec.loader.exec_module(memory)
    paused=False
    def stop():
        return (run/'STOP').exists() or (run.parent.parent/'STOP').exists() or datetime.now(timezone.utc)>=datetime.fromisoformat(plan['evaluationDeadlineUTC'].replace('Z','+00:00'))
    def check():
        nonlocal paused
        if stop():raise RuntimeError('STOP or fixed deadline')
        while memory.available_gib()<(5 if paused else 4):
            paused=True;time.sleep(1)
            if stop():raise RuntimeError('STOP or fixed deadline')
        paused=False
    check();rows={}
    for file in run.glob('worker-*.jsonl'):
        for line in file.read_text(encoding='utf-8').splitlines():
            row=json.loads(line);key=(row['task'],row['seed'])
            if key in rows or row['protocolSHA256']!=digest:raise ValueError('Duplicate or changed protocol')
            rows[key]=row
    if len(rows)!=sum(len(t['seeds']) for t in plan['tasks']):raise ValueError('Incomplete fixed root set')
    result={};completed_rounds=0;eligible_total=0
    for task_index,task in enumerate(plan['tasks']):
        selected=[];ineligible=0;baseline_wld=[0,0,0];altered_wld=[0,0,0]
        for index,seed in enumerate(task['seeds']):
            row=rows.pop((task['id'],seed));team=(index//2)%2;focus=team+(index%2)*2
            if row['caseIndex']!=index or row['team']!=team or row['focus']!=focus:raise ValueError('Wrong focal allocation')
            for name in ['baseline','deviation']:
                if name not in row:continue
                outcome=row[name];order=outcome['order']
                if sorted(order)!=[0,1,2,3] or outcome['winner']!=order[0]%2:raise ValueError('Invalid terminal ranks')
                mate=order.index((order[0]+2)%4);points=3 if mate==1 else 2 if mate==2 else 1
                if outcome['points']!=points:raise ValueError('Invalid final upgrade points')
                (baseline_wld if name=='baseline' else altered_wld)[0 if outcome['winner']==team else 1]+=1;completed_rounds+=1
            c=row['choice']
            if c is None:
                if 'deviation' in row:raise ValueError('Ineligible root has intervention')
                ineligible+=1;continue
            if not row['oneInterventionApplied'] or c['player']!=focus or c['rank'] not in [2,3,4,5] or c['highPairs']+c['lowPairs']!=c['candidatePositionRankPairs']:raise ValueError('Invalid intervention')
            high=c['predictedGap']>=.1;size=c['highPairs'] if high else c['lowPairs'];both=c['highPairs']>0 and c['lowPairs']>0;prob=(.75 if high else .25) if both else 1
            expected=(1/c['candidatePositionRankPairs'])/(prob/size)
            if abs(c['weight']-expected)>1e-12 or abs(c['proposalProbability']-prob/size)>1e-12:raise ValueError('Incorrect importance weight')
            if abs(c['predictedGap']-(c['qBest']-c['qAlternative']))>1e-12:raise ValueError('Invalid predicted difference')
            y=(row['baseline']['points'] if row['baseline']['winner']==team else -row['baseline']['points'])-(row['deviation']['points'] if row['deviation']['winner']==team else -row['deviation']['points'])
            if row['realizedDelta']!=y:raise ValueError('Invalid final-round delta')
            selected.append((c['predictedGap'],y,c['weight'],c['ownHandCount']))
        data=np.array(selected,dtype=float).reshape(-1,4);eligible_total+=len(data);x,y,w,hand=data.T
        mask=(x>=.05)&(x<=1)
        fit=weighted_fit(x[mask],y[mask],w[mask],plan['bootstrapSeed']+task_index,plan['bootstrapReplicates'],check)
        if fit['ci95'] is not None:
            lo,hi=fit['ci95'];fit['qUnitApproxResearchCondition']=bool(lo>=.5 and hi<=1.5);fit['zeroWithinInterval']=bool(lo<=0<=hi)
        # Exact unweighted Theil–Sen is secondary on the oversampled display stratum only.
        check();xx,yy=x[mask],y[mask]
        if len(xx)>1:
            i,j=np.triu_indices(len(xx),k=1);dx=xx[j]-xx[i];nonzero=dx!=0
            fit['unweightedTheilSenDescriptive']=float(np.median((yy[j]-yy[i])[nonzero]/dx[nonzero])) if np.any(nonzero) else None
        bins={}
        for lo,hi in [(0,.05),(.05,.1),(.1,.2),(.2,.4),(.4,.7),(.7,1),(1,2),(2,None)]:
            m=(x>=lo)&((x<hi) if hi is not None else True);bins[f'{lo}..{hi if hi is not None else "above"}']=point_bin(x[m],y[m],w[m])
        stages={}
        for k,(lo,hi) in enumerate([(20,27),(10,19),(1,9)]):
            m=mask&(hand>=lo)&(hand<=hi);stages[f'{hi}..{lo}']=weighted_fit(x[m],y[m],w[m],plan['bootstrapSeed']+100+task_index*3+k,plan['bootstrapReplicates'],check)
        result[task['id']]={'roots':len(task['seeds']),'eligiblePairs':len(data),'ineligibleNoReplacement':ineligible,'baselineWLD':baseline_wld,'deviationWLD':altered_wld,'displayLayerWeightedSlope':fit,'displayLayerByOwnHandStage':stages,'predictedGapBins':bins}
        check()
    if rows:raise ValueError('Unregistered root rows')
    return {'schema':1,'protocolSHA256':digest,'completedRoots':sum(len(t['seeds']) for t in plan['tasks']),'eligiblePairs':eligible_total,'completedRounds':completed_rounds,'tasks':result,'optimizerUpdates':0,'strengthGames':0,'scope':'Final single-round baseline-minus-one-forced-action delta under fixed raw continuation; importance weights target uniform focal decision/rank pairs within each root. Opponents separate. No neural training, calibrated UI, model strength rating, match training or promotion. Theil–Sen is unweighted descriptive on oversampled cases; bootstrap is conditional on this frozen teacher.'}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--protocol',required=True,type=Path);parser.add_argument('--results',required=True,type=Path);parser.add_argument('--output',required=True,type=Path);args=parser.parse_args()
    args.output.write_text(json.dumps(summarize(args.protocol,args.results),indent=2,allow_nan=False)+'\n',encoding='utf-8',newline='\n')
