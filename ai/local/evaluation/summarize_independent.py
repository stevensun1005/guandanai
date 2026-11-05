"""Seed-cluster inference for the preregistered fixed 2v2 evaluation."""
import os
os.environ.setdefault('OPENBLAS_NUM_THREADS', '1')
os.environ.setdefault('OMP_NUM_THREADS', '1')
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import numpy as np

FIELDS = ['matches','wins','losses','draws','rounds','doubleWins','doubleLosses','firsts','isolatedFirsts','signedUpgradePoints']

def metrics(total):
    v = dict(zip(FIELDS, total))
    firsts=np.asarray(v['firsts'],dtype=float)
    isolated=np.divide(v['isolatedFirsts'],firsts,out=np.full_like(firsts,np.nan),where=firsts!=0)
    return {
        'matchWinRate':v['wins']/v['matches'],
        'matchScore':(v['wins']+v['draws']/2)/v['matches'],
        'matchDrawRate':v['draws']/v['matches'],
        'doubleDownRate':v['doubleLosses']/v['rounds'],
        'doubleUpRate':v['doubleWins']/v['rounds'],
        'isolatedFirstRate':isolated,
        'safePartnerAfterFirstRate':1-isolated,
        'meanSignedUpgradePoints':v['signedUpgradePoints']/v['rounds'],
    }

def estimates(rows, iterations=2000, seed=2026110513):
    rows = np.asarray(rows,dtype=np.float64)
    if rows.ndim!=2 or rows.shape[1]!=len(FIELDS) or len(rows)<2:
        raise ValueError('Need at least two complete paired-seed clusters')
    counts = np.random.default_rng(seed).multinomial(len(rows),np.full(len(rows),1/len(rows)),size=iterations)
    boot = metrics((counts @ rows).T)
    point = metrics(rows.sum(axis=0))
    return {k:{'estimate':float(v),'bootstrap95':np.nanquantile(boot[k],[.025,.975]).tolist()} for k,v in point.items()}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--protocol',required=True)
    parser.add_argument('--run',required=True)
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    protocol=Path(args.protocol);run=Path(args.run);output=Path(args.output)
    raw_protocol=protocol.read_bytes();plan=json.loads(raw_protocol)
    protocol_sha=hashlib.sha256(raw_protocol).hexdigest()
    records=[]
    for path in sorted(run.glob('worker-*.jsonl')):
        records.extend(json.loads(line) for line in path.read_text(encoding='utf-8').splitlines())
    records.sort(key=lambda r:r['seed'])
    if [r['seed'] for r in records]!=plan['seeds']:
        raise ValueError('Incomplete, repeated or unexpected seed clusters')
    rows=[];ranks={k:0 for k in ['12','13','14','23','24','34']}
    for record in records:
        if record['protocolSHA256']!=protocol_sha:raise ValueError('Protocol mismatch')
        if len(record['games'])!=2 or [g['neuralTeam'] for g in record['games']]!=[0,1]:
            raise ValueError('Incomplete side swap')
        row={key:0 for key in FIELDS}
        for game in record['games']:
            if game['seed']!=record['seed']:raise ValueError('Mismatched game seed')
            final=game['history'][-1]
            if not (final['win'] or final['draw']):raise ValueError('Truncated match')
            row['matches']+=1
            row['draws']+=int(game['winner'] is None)
            row['wins']+=int(game['winner']==game['neuralTeam'])
            row['losses']+=int(game['winner'] is not None and game['winner']!=game['neuralTeam'])
            counts=game['cooperation']
            for key in ['rounds','doubleWins','doubleLosses','firsts','isolatedFirsts']:row[key]+=counts[key]
            for key,n in counts['ranks'].items():ranks[key]+=n
            for round in game['history']:
                row['signedUpgradePoints']+=(1 if round['team']==game['neuralTeam'] else -1)*round['up']
        rows.append([row[k] for k in FIELDS])
    total=dict(zip(FIELDS,np.asarray(rows,dtype=np.int64).sum(axis=0).tolist()))
    if sum(ranks.values())!=total['rounds']:raise ValueError('Round rank conservation failure')
    summary=estimates(rows,seed=plan['confidence']['bootstrapSeed'])
    n=len(rows);rate=summary['matchWinRate']['estimate']
    radius=float(np.sqrt(np.log(40)/(2*n)))
    lower=max(0.,rate-float(np.sqrt(np.log(20)/(2*n))))
    data=('\n'.join(json.dumps(r,separators=(',',':')) for r in records)+'\n').encode()
    compressed=gzip.compress(data,mtime=0)
    output.mkdir(parents=True,exist_ok=True)
    (output/'matches.jsonl.gz').write_bytes(compressed)
    result={
        'schema':1,'purpose':'Completed fixed independent whole-match evaluation; no model selection',
        'protocolSHA256':protocol_sha,'model':plan['model'],'opponent':plan['opponent'],'rules':plan['rules'],
        'completedAtUTC':datetime.now(timezone.utc).isoformat(),'seedStart':min(plan['seeds']),'seedEnd':max(plan['seeds']),
        'completedPairs':n,'counts':total,'metrics':summary,
        'teamRankPairs':{k:{'count':v,'roundRate':v/total['rounds']} for k,v in ranks.items()},
        'matchWinRateClusterHoeffding95':[max(0.,rate-radius),min(1.,rate+radius)],
        'matchWinRateOneSided95Lower':lower,'target80Supported':lower>.8,
        'raw':{'file':'matches.jsonl.gz','sha256':hashlib.sha256(compressed).hexdigest(),'uncompressedSHA256':hashlib.sha256(data).hexdigest(),'compressedBytes':len(compressed)},
        'analysis':{'bootstrapIterations':2000,'bootstrapSeed':plan['confidence']['bootstrapSeed'],'cluster':'Two swapped whole matches per seed; rounds never sampled independently','fingerprint':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'numpy':np.__version__},
        'limitations':plan['limitations']+['Cooperation statistics are outcome proxies, with no old-model control; they do not establish longitudinal progress or intent.'],
    }
    (output/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'counts':total,'metrics':summary,'oneSided95Lower':lower,'target80Supported':lower>.8}))

if __name__=='__main__':main()
