"""Validate the complete preregistered round-pair experiment and summarize seed clusters."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import statistics


def estimate(values, z=1.96):
    mean = statistics.mean(values)
    se = statistics.stdev(values) / math.sqrt(len(values)) if len(values) > 1 else None
    return {"clusters": len(values), "mean": mean, "standardError": se,
            "ci": [mean - z * se, mean + z * se] if se is not None else None,
            "z": z, "method": "Normal approximation using independent seed-pair sample SD"}


def exploitation_signal(data, specification):
    """Head-to-head gain minus paired common-P0 improvement on a disjoint deal block."""
    head, latest, champion = (data[specification[key]] for key in ['head', 'latestVsP0', 'championVsP0'])
    if set(latest) != set(champion) or set(head) & set(latest):
        raise ValueError('Exploitation signal requires paired P0 and disjoint head-to-head deals')
    points = lambda row: statistics.mean(g['signedPoints'] for g in row['games'])
    differences=[]
    for seed in latest:
        for a,b in zip(latest[seed]['games'],champion[seed]['games']):
            if (a['dealSHA256'],a['level'],a['leader']) != (b['dealSHA256'],b['level'],b['leader']):
                raise ValueError('Exploitation common-opponent deals differ')
        differences.append(points(latest[seed])-points(champion[seed]))
    a,b=estimate([points(row) for row in head.values()]),estimate(differences)
    if a['standardError'] is None or b['standardError'] is None:
        raise ValueError('Insufficient independent exploitation clusters')
    mean=a['mean']-b['mean'];se=math.hypot(a['standardError'],b['standardError']);z=2.5758293035
    return {'mean':mean,'standardError':se,'ci':[mean-z*se,mean+z*se],
            'confidenceLevel':.99,'headClusters':a['clusters'],'commonP0Clusters':b['clusters'],
            'definition':'latest-vs-017 points minus (latest-vs-P0 minus 017-vs-P0 points)',
            'baseline':'017 versus itself has exact zero paired mean by side-swap symmetry; no baseline games invented',
            'method':'Independent deal-block variances added; paired common-P0 difference preserves covariance',
            'roadmapPointGate':a['ci'][0]>0 and mean>.05,
            'limit':'One target and one run; signal interval crossing zero remains uncertain, no automatic promotion'}


def cooperation_interactions(data, specifications):
    """Compute paired linear interactions, retaining all three terms' covariance."""
    output={}
    for item in specifications:
        terms=item['terms']
        reference=data[terms[0]['task']]
        if any(set(data[t['task']]) != set(reference) for t in terms):
            raise ValueError('Interaction requires common deal seeds')
        gaps=[]
        for seed,row in reference.items():
            identity=[(g['dealSHA256'],g['level'],g['leader']) for g in row['games']]
            if any([(g['dealSHA256'],g['level'],g['leader']) for g in data[t['task']][seed]['games']] != identity for t in terms):
                raise ValueError('Interaction deals differ')
            gaps.append(sum(t['weight']*statistics.mean(g['signedPoints'] for g in data[t['task']][seed]['games']) for t in terms))
        result=estimate(gaps,z=2.5758293035)
        result['confidenceLevel']=.99
        family=estimate(gaps,z=statistics.NormalDist().inv_cdf(1-.01/(2*len(specifications))))
        result['familywise99CI']=family['ci']
        result['passesResultCondition']=abs(result['mean'])>.10 and (family['ci'][0]>0 or family['ci'][1]<0)
        result['terms']=terms
        result['zeroBaselines']=item.get('zeroBaselines',[])
        result['scope']='Paired lineup interaction, not a causal tactical explanation. No authorization for teammate training or promotion.'
        output[item['id']]=result
    return output


def summarize(protocol, results):
    protocol, results = Path(protocol), Path(results)
    plan = json.loads(protocol.read_text(encoding="utf-8"))
    protocol_sha = hashlib.sha256(protocol.read_bytes()).hexdigest()
    tasks = {t["id"]: t for t in plan["tasks"]}
    data = {id: {} for id in tasks}
    for slot in range(plan["workers"]):
        status = json.loads((results / f"worker-{slot}.json").read_text(encoding="utf-8"))
        if status["phase"] != "complete" or status["protocolSHA256"] != protocol_sha:
            raise ValueError("Incomplete or mismatched worker")
        for line in (results / f"worker-{slot}.jsonl").read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            id, seed = row["task"], row["seed"]
            if row["protocolSHA256"] != protocol_sha or seed in data[id] or seed not in tasks[id]["seeds"]:
                raise ValueError("Repeated, unknown or mismatched result")
            if len(row["games"]) != 2 or [g["team"] for g in row["games"]] != [0, 1]:
                raise ValueError("Incomplete position-swap pair")
            if len({(g["dealSHA256"], g["level"], g["leader"]) for g in row["games"]}) != 1:
                raise ValueError("Paired deals differ")
            for game in row["games"]:
                order, team = game["order"], game["team"]
                if sorted(order) != [0, 1, 2, 3] or game["winner"] != order[0] % 2:
                    raise ValueError("Invalid finishing order")
                mate = order.index((order[0] + 2) % 4)
                points = 3 if mate == 1 else 2 if mate == 2 else 1
                if game["points"] != points or game["signedPoints"] != points * (1 if game["winner"] == team else -1):
                    raise ValueError("Invalid final round reward")
                focus = team + (seed % 2) * 2
                seats = [tasks[id]["opponent"] if p % 2 != team else
                         (tasks[id].get("teammate") or ("clint" if tasks[id].get("mixed") else tasks[id]["model"]))
                         if p != focus else tasks[id]["model"] for p in range(4)]
                if seats != game["seats"]:
                    raise ValueError("Wrong lineup")
            data[id][seed] = row
    reports = {}
    for id, task in tasks.items():
        if set(data[id]) != set(task["seeds"]):
            raise ValueError("Missing preregistered seed pairs")
        points, scores, ranks, wins, turns = [], [], Counter(), Counter(), []
        for seed in task["seeds"]:
            row = data[id][seed]
            points.append(statistics.mean(g["signedPoints"] for g in row["games"]))
            scores.append(statistics.mean(g["winner"] == g["team"] for g in row["games"]))
            for g in row["games"]:
                wins["wins" if g["winner"] == g["team"] else "losses"] += 1
                places = "".join(str(i + 1) for i, p in enumerate(g["order"]) if p % 2 == g["team"])
                ranks[places] += 1
                turns.append(g["turns"])
        reports[id] = {
            "model": task["model"], "opponent": task["opponent"], "mixed": task.get("mixed", False),
            "teammate": task.get("teammate", "clint" if task.get("mixed") else task["model"]),
            "pairs": len(points), "rounds": len(points) * 2,
            "wins": wins["wins"], "losses": wins["losses"], "draws": 0,
            "signedUpgradePoints": estimate(points), "roundWinScore": estimate(scores),
            "finishingRankPairs": dict(sorted(ranks.items())),
            "doubleDowns": ranks["34"], "doubleUps": ranks["12"],
            "meanTurns": statistics.mean(turns),
        }
        if plan.get('descriptive'):
            totals=Counter()
            for row in data[id].values():
                for g in row['games']:
                    for seat in [g['team'],g['team']+2]:
                        totals.update(g['descriptions'][seat])
            reports[id]['descriptiveTeamCounts']=dict(totals)
            reports[id]['descriptiveScope']='Counts per acting team decision; never rewards, losses, gates or acceptance criteria.'
    contrasts = {}
    specifications = plan.get("contrasts", [
        {"id": group, "left": "champion-"+group, "right": "latest-"+group,
         "z": 2.4977054744, "confidenceLevel": 0.9875, "direction": "latest minus champion"}
        for group in ["vs-clint", "vs-p0", "vs-previous", "mixed-clint"]])
    for comparison in specifications:
        group = comparison["id"]
        a, b = data[comparison["left"]], data[comparison["right"]]
        if set(a) != set(b):
            raise ValueError("Common-opponent seeds differ")
        differences = []
        for seed in sorted(a):
            for ga, gb in zip(a[seed]["games"], b[seed]["games"]):
                if (ga["dealSHA256"], ga["level"], ga["leader"]) != (gb["dealSHA256"], gb["level"], gb["leader"]):
                    raise ValueError("Common-opponent deals differ")
            differences.append(statistics.mean(g["signedPoints"] for g in b[seed]["games"]) -
                               statistics.mean(g["signedPoints"] for g in a[seed]["games"]))
        contrasts[group] = estimate(differences, z=comparison["z"])
        contrasts[group]["confidenceLevel"] = comparison["confidenceLevel"]
        contrasts[group]["direction"] = comparison["direction"]
    primary = reports[plan.get('primaryTask','head-to-head')]["signedUpgradePoints"]
    lo, hi = primary["ci"]
    primary_model = plan.get("primaryModel", "latest")
    primary_opponent = plan.get("primaryOpponent", "champion")
    winner = primary_model if lo > 0 else primary_opponent if hi < 0 else "inconclusive"
    result = {
        "schema": 1, "id": plan["id"], "completedAtUTC": datetime.now(timezone.utc).isoformat(),
        "purpose": plan["purpose"], "protocolSHA256": protocol_sha,
        "models": plan["models"], "unit": "complete single round", "protocol": plan["rules"],
        "pipeline": plan["pipeline"], "pairing": plan["pairing"], "statistics": plan["analysis"],
        "plannedPairs": plan["plannedPairs"], "completedPairs": sum(v["pairs"] for v in reports.values()),
        "completedRounds": sum(v["rounds"] for v in reports.values()),
        "reports": reports, "secondaryContrasts": contrasts,
        "primaryWinner": winner, "primaryInterpretation": plan.get("primaryInterpretation", "Latest perspective; 95% seed-cluster CI for signed upgrade points"),
        "scope": "Fixed models and observed lineups only; not whole-match strength, human coaching efficacy, or automatic champion promotion",
        "optimizerUpdatesExecuted": 0,
    }
    if plan.get('exploitationSignal'):
        result['exploitationSignal']=exploitation_signal(data,plan['exploitationSignal'])
    if plan.get('interactions'):
        result['cooperationInteractions']=cooperation_interactions(data,plan['interactions'])
    return result


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--protocol", required=True)
    p.add_argument("--results", required=True)
    p.add_argument("--output", required=True)
    args = p.parse_args()
    result = summarize(args.protocol, args.results)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"completeRounds": result["completedRounds"], "primaryWinner": result["primaryWinner"]}))
