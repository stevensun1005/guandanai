"""Read simulated traces only; Q gaps are relative scores, never probabilities."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np


def describe(values):
    if not values:return {'n':0}
    a=np.array(values)
    return {'n':len(a),'mean':float(a.mean()),'quantiles':dict(zip(['min','p05','p25','p50','p75','p95','max'],np.quantile(a,[0,.05,.25,.5,.75,.95,1]).tolist())),'fractionAtLeastPoint1':float(np.mean(a>=.1)),'fractionPoint05Through1':float(np.mean((a>=.05)&(a<=1)))}


def summarize(protocol,run,gaps_only=False):
    plan=json.loads(protocol.read_bytes());digest=hashlib.sha256(protocol.read_bytes()).hexdigest();rows={}
    for file in run.glob('worker-*.jsonl'):
        raw=file.read_bytes();raw=raw[:raw.rfind(b'\n')+1]
        for line in raw.splitlines():
            r=json.loads(line)
            if gaps_only and r['stage']!='gap':continue
            key=(r['task'],r['seed'])
            if key in rows or r['protocolSHA256']!=digest:raise ValueError('Duplicate/changed trace')
            rows[key]=r
    result={};total_rounds=0
    for task in plan['tasks']:
        if gaps_only and task['stage']!='gap':continue
        q2=[];q5=[];decisions=0;forced=0;wld=[0,0,0];hist=[0,0,0,0];pairs=0
        for seed in task['seeds']:
            r=rows.pop((task['id'],seed));pairs+=1
            if [g['team'] for g in r['games']]!=[0,1]:raise ValueError('Missing swap')
            for game in r['games']:
                if sorted(game['order'])!=[0,1,2,3] or game['winner']!=game['order'][0]%2:raise ValueError('Invalid terminal round')
                if sorted(c for h in game['initial']['hands'] for c in h)!=list(range(108)):raise ValueError('Invalid physical deal')
                wld[0 if game['winner']==game['team'] else 1]+=1
                total_rounds+=1
                for i,p in enumerate(game['order']):
                    if p%2==game['team']:hist[i]+=1
                for move in game['moves']:
                    if move['model']!='champion':continue
                    decisions+=1;top=move['top5']
                    if not top:forced+=1;continue
                    if any(top[i]['q']<top[i+1]['q'] for i in range(len(top)-1)):raise ValueError('Unsorted scores')
                    if len(top)>=2:q2.append(top[0]['q']-top[1]['q'])
                    if len(top)>=5:q5.append(top[0]['q']-top[4]['q'])
        result[task['id']]={'stage':task['stage'],'opponent':task['opponent'],'mixed':task.get('mixed',False),'pairedDeals':pairs,'rounds':pairs*2,'wins':wld[0],'losses':wld[1],'draws':wld[2],'teamRankCounts':hist,'championDecisions':decisions,'forcedChampionDecisions':forced,'top2Gap':describe(q2),'top5Gap':describe(q5)}
    if rows:raise ValueError('Unregistered rows')
    return {'schema':1,'protocolSHA256':digest,'gapOnly':gaps_only,'completeRounds':total_rounds,'tasks':result,'optimizerUpdates':0,'strengthGames':0,'scope':'Descriptive Q gaps over champion simulated trajectories, decisions correlated within deal. No realized deviation, calibration, causal/tactical recommendation or strength acceptance; complete private simulated deals remain ignored locally.'}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--protocol',required=True,type=Path);parser.add_argument('--results',required=True,type=Path);parser.add_argument('--output',required=True,type=Path);parser.add_argument('--gaps-only',action='store_true');args=parser.parse_args()
    args.output.write_text(json.dumps(summarize(args.protocol,args.results,args.gaps_only),indent=2)+'\n',encoding='utf-8')
