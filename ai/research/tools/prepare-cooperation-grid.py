"""Freeze a once-only lineup-grid runtime protocol before deadline registration."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import subprocess

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def prepare(design, runtime, run, python):
    design, runtime, run = Path(design), Path(runtime), Path(run)
    plan = json.loads(design.read_bytes())
    audit = design.parent / 'seed-audit.json'
    seeds = json.loads(audit.read_bytes())['seeds']
    assert len(seeds) == len(set(seeds)) == 12000
    tasks = []
    for task in plan.pop('taskDefinitions'):
        task['seeds'] = seeds[task.pop('seedBlock')*4000:][:4000]
        tasks.append(task)
    for model in plan['models'].values():
        if sha(model['file']) != model['sha256']:
            raise ValueError('Frozen model mismatch')
    paths = subprocess.check_output(['git','ls-files','web/src','ai/shared/simulation','ai/danMCai/evaluation/evaluate-round-pairs.mjs','ai/danMCai/evaluation/summarize-round-pairs.py','ai/danMCai/evaluation/cooperation-labels.mjs','ai/danMCai/training/continuous/lib.mjs','ai/danMCai/training/continuous/resources.mjs','ai/research/tools/run-round-evaluation.mjs','ai/research/tools/research-deadline.mjs','ai/research/tools/prepare-cooperation-grid.py'],cwd=runtime,text=True).splitlines()
    plan.update(tasks=tasks,evaluationSource=str(runtime.resolve()),python=str(Path(python).resolve()),
                sourceCommit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=runtime,text=True).strip(),
                sourceSHA256={name:sha(runtime/name) for name in paths},
                seedAuditSHA256=sha(audit),designSHA256=sha(design),
                evaluationDeadlineUTC=min(datetime.now(timezone.utc)+timedelta(hours=plan['budgetHours']),datetime(2026,11,11,16,45,tzinfo=timezone.utc)).isoformat())
    run.mkdir(parents=True,exist_ok=True)
    with (run/'protocol.json').open('x',encoding='utf-8',newline='\n') as out:
        out.write(json.dumps(plan,ensure_ascii=False,indent=2)+'\n')
    return {'sourceCommit':plan['sourceCommit'],'protocolSHA256':sha(run/'protocol.json'),
            'sourceFiles':len(paths),'plannedRounds':plan['plannedRounds'],
            'evaluationDeadlineUTC':plan['evaluationDeadlineUTC']}

if __name__ == '__main__':
    p=argparse.ArgumentParser(__doc__)
    for name in ['design','runtime','run','python']:
        p.add_argument('--'+name,required=True)
    print(json.dumps(prepare(**vars(p.parse_args()))))
