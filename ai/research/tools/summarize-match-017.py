"""Validate all registered full matches before opponent-separated cluster intervals."""
import argparse
import json
from pathlib import Path
import numpy as np


def score(game):
    if not game['history'] or len(game['history'])>200:
        raise ValueError('Invalid complete-match history')
    final=game['history'][-1]
    if not (final.get('win') or final.get('draw')):
        raise ValueError('Truncated match')
    if (bool(final.get('draw')) != (game['winner'] is None) or
        (final.get('win') and game['winner'] != final['team'])):
        raise ValueError('Terminal winner mismatch')
    return 0 if game['winner'] is None else 1 if game['winner']==game['neuralTeam'] else -1


def interval(values, seed, probability=.95):
    rng=np.random.default_rng(seed)
    draws=[]
    for _ in range(40):
        draws.extend(values[rng.integers(len(values),size=(100,len(values)))].mean(axis=1))
    alpha=(1-probability)/2
    return np.quantile(draws,[alpha,1-alpha]).tolist()


def summarize(run):
    import hashlib
    plan=json.loads((run/'protocol.json').read_bytes())
    digest=hashlib.sha256((run/'protocol.json').read_bytes()).hexdigest()
    rows={}
    for path in run.glob('worker-*.jsonl'):
        for line in path.read_text(encoding='utf-8').splitlines():
            value=json.loads(line);key=(value['task'],value['seed'])
            if key in rows or value['protocolSHA256']!=digest:
                raise ValueError('Duplicate or changed protocol')
            rows[key]=value
    results,paired={},{}
    if len(rows)!=sum(len(t['seeds']) for t in plan['tasks']):
        raise ValueError('Incomplete registered experiment')
    for index,task in enumerate(plan['tasks']):
        means=[]; wld=[0,0,0]; ranks={k:0 for k in ['12','13','14','23','24','34']}
        for seed in task['seeds']:
            games=rows[(task['id'],seed)]['games']
            teams=[0] if task.get('self') else [0,1]
            if [g['neuralTeam'] for g in games]!=teams or any(g['seed']!=seed for g in games):
                raise ValueError('Wrong match seed/teams')
            scores=[score(g) for g in games];means.append(np.mean(scores))
            for g,s in zip(games,scores):
                wld[0 if s>0 else 1 if s<0 else 2]+=1
                for r in g['history']:
                    order=r['order']
                    if sorted(order)!=[0,1,2,3]:raise ValueError('Invalid finishing order')
                    key=''.join(str(i+1) for i,p in enumerate(order) if p%2==g['neuralTeam'])
                    ranks[key]+=1
        values=np.array(means);paired[task['id']]=values
        results[task['id']]={'arm':task['arm'],'opponent':task['opponent'],'mixed':task.get('mixed',False),'clusters':len(means),'matches':sum(wld),'wins':wld[0],'losses':wld[1],'draws':wld[2],'matchScoreMean':float(values.mean()),'ci95':interval(values,plan['bootstrapSeed']+index),'ci99':interval(values,plan['bootstrapSeed']+index, .99),'roundTeamRanks':ranks,'doubleWins':ranks['12'],'doubleLosses':ranks['34']}
    contrasts={}
    for group in ['clint','p0','previous','mixed','self']:
        raw,web=paired['raw-'+group],paired['web-'+group]
        diff=web-raw
        contrasts[group]={'webMinusRawMatchScore':float(diff.mean()),'ci99':interval(diff,plan['bootstrapSeed']+100+len(contrasts),.99),'scope':'Matched root clusters; descriptive comparison, no selection/promotion'}
    return {'schema':1,'title':plan['displayName'],'protocolSHA256':digest,'tasks':results,'webVersusRaw':contrasts,'completedMatches':sum(t['matches'] for t in results.values()),'scope':'Independent whole-match evaluation, aFail=draw, original tribute. No pooling opponents; not comparable to gate330, GuanZero or old009 web-policy evaluations. No training, promotion or universal80percent claim.'}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--run',required=True,type=Path);args=parser.parse_args()
    (args.run/'summary.json').write_text(json.dumps(summarize(args.run),indent=2)+'\n',encoding='utf-8')
