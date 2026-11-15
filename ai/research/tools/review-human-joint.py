"""Read-only joint-policy human metrics and paired terminal-outcome closeout."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics
import numpy as np


def read(p):
    return json.loads(Path(p).read_text(encoding='utf-8'))


def write(p, value):
    Path(p).write_bytes((json.dumps(value, ensure_ascii=False, indent=2)+'\n').encode('utf-8'))


def interval(xs, z=1.96):
    n=len(xs);mean=statistics.mean(xs);se=statistics.stdev(xs)/math.sqrt(n)
    return {'pairs':n,'mean':mean,'standardError':se,'ci':[mean-z*se,mean+z*se],'z':z}


def human(root):
    import onnxruntime as ort
    plan=read(root/'protocol.json');data=Path(plan['humanData']);manifest=read(data/'manifest.json')
    for f,h in plan['humanDataSHA256'].items():
        assert hashlib.sha256((data/f).read_bytes()).hexdigest()==h
    rows=read(data/'decisions.json');features=np.memmap(data/'features.i8',dtype=np.int8,mode='r',shape=(manifest['candidateRows'],567))
    reports={}
    for name,file in [('029',plan['initialModel']),('final',str(root/'final.onnx'))]:
        options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
        session=ort.InferenceSession(file,sess_options=options,providers=['CPUExecutionProvider'])
        report={}
        for split in ['validation','test']:
            correct=0;nll=0.;predictions=[]
            for d in (r for r in rows if r['split']==split):
                x=features[d['start']:d['start']+d['length']].astype(np.float32)
                q=session.run(None,{'state':x[:1,:513],'actions':x[:,513:]})[0].reshape(-1).astype(np.float64)
                assert len(q)==d['length'] and np.isfinite(q).all()
                chosen=int(np.argmax(q));correct+=chosen==d['target'];predictions.append(chosen)
                maximum=float(q.max());nll+=maximum+math.log(float(np.exp(q-maximum).sum()))-float(q[d['target']])
            report[split]={'decisions':len(predictions),'correct':int(correct),'accuracy':correct/len(predictions),'nll':nll/len(predictions)}
            write(root/f'human-{name}-{split}-predictions.json',predictions)
        reports[name]=report
    output={'reports':reports,'selection':'Final-window learner only, no validation/test model selection',
            'retrospectiveOnly':True,'oneValidationAndOneTestSession':True,'previouslyInspectedData':True,
            'notWinProbability':True,'optimizerUpdatesDuringReview':0}
    write(root/'human-results.json',output)
    write(root/'human-panel.json',{'title':'真人动作回顾性留出（非胜率）','rows':[
        ['测试029/最终一致率',f"{reports['029']['test']['accuracy']:.2%} / {reports['final']['test']['accuracy']:.2%}"],
        ['测试029/最终NLL',f"{reports['029']['test']['nll']:.5f} / {reports['final']['test']['nll']:.5f}"],
        ['验证029/最终一致率',f"{reports['029']['validation']['accuracy']:.2%} / {reports['final']['validation']['accuracy']:.2%}"],
        ['边界','原10/1/1分组、单个测试会话且已看过；不作新的独立真人验收']]})


def pairs(root, protocol):
    rows={}
    for slot in range(protocol['workers']):
        for line in (root/f'worker-{slot}.jsonl').read_text(encoding='utf-8').splitlines():
            r=json.loads(line)
            assert r['seed'] not in rows
            rows[r['seed']]=r
    assert set(rows)==set(protocol['tasks'][0]['seeds'])
    return rows


def closeout(root):
    names=['vs029','vsreason','029vsreason'];data={};reports={}
    fmt=lambda e:f"{e['mean']:.5f} [{e['ci'][0]:.5f}, {e['ci'][1]:.5f}]"
    for name in names:
        group=root/name;protocol=read(group/'protocol.json');summary=read(group/'summary.json')
        assert read(group/'status.json')['phase']=='complete' and summary['completedRounds']==1000
        assert summary['protocolSHA256']==hashlib.sha256((group/'protocol.json').read_bytes()).hexdigest()
        data[name]=pairs(group,protocol);r=summary['reports']['head-to-head'];reports[name]=r
        write(group/'final-panel.json',{'title':protocol['displayName'],'rows':[
            ['胜/负/平',f"{r['wins']}/{r['losses']}/{r['draws']}"],
            ['胜率与95%牌副簇区间',fmt(r['roundWinScore'])],
            ['终局升级分与95%牌副簇区间',fmt(r['signedUpgradePoints'])],
            ['双上/双下',f"{r['doubleUps']}/{r['doubleDowns']}"]]})
    assert set(data['vsreason'])==set(data['029vsreason'])
    assert not set(data['vs029'])&set(data['vsreason'])
    differences=[];win_differences=[]
    for seed,a in data['vsreason'].items():
        b=data['029vsreason'][seed]
        for ga,gb in zip(a['games'],b['games']):
            assert (ga['dealSHA256'],ga['level'],ga['leader'])==(gb['dealSHA256'],gb['level'],gb['leader'])
        differences.append(statistics.mean(g['signedPoints']for g in a['games'])-statistics.mean(g['signedPoints']for g in b['games']))
        win_differences.append(statistics.mean(g['winner']==g['team']for g in a['games'])-statistics.mean(g['winner']==g['team']for g in b['games']))
    contrast=interval(differences);win_contrast=interval(win_differences)
    h=read(root/'human-results.json')['reports'];delta=h['final']['test']['accuracy']-h['029']['test']['accuracy']
    behavior=delta>=.05 and h['final']['test']['nll']<h['029']['test']['nll']
    result={'complete':True,'reports':reports,'pairedUpgradeGainVsOldReason':contrast,'pairedWinRateGainVsOldReason':win_contrast,
            'retrospectiveHumanAccuracyDelta':delta,'retrospectiveHumanPointGoal':behavior,
            'beats029Upgrade95':reports['vs029']['signedUpgradePoints']['ci'][0]>0,
            'beatsOldReasonUpgrade95':reports['vsreason']['signedUpgradePoints']['ci'][0]>0,
            'bothExploratoryGoalsMet':behavior and reports['vs029']['signedUpgradePoints']['ci'][0]>0 and contrast['ci'][0]>0,
            'humanGeneralizationAccepted':False,'webPublished':False,'optimizerUpdatesDuringEvaluation':0,
            'limits':'Same fixed retrospective human split; not new prospective acceptance. Three groups share oldreason deal block by design; no pooled overall winrate. Native timed search depends on machine load; report fallbacks. No automatic model promotion or website deployment.'}
    write(root/'results.json',result)
    write(root/'results-panel.json',{'title':'最终双目标检查（不自动发布）','rows':[
        ['真人测试一致率增量',f'{delta:+.2%}（同一回顾性会话）'],
        ['对029升级分95%下界',reports['vs029']['signedUpgradePoints']['ci'][0]],
        ['共同旧reason配对升级分增量',fmt(contrast)],
        ['探索性双目标点条件',str(result['bothExploratoryGoalsMet'])],
        ['网站','029保持；没有自动晋升/发布授权']]})


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--run',type=Path,required=True);p.add_argument('--mode',choices=['human','closeout'],required=True);a=p.parse_args()
    (human if a.mode=='human'else closeout)(a.run)
