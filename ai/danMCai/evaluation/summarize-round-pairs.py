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


def summarize(protocol, results):
    protocol, results = Path(protocol), Path(results)
    plan = json.loads(protocol.read_text())
    protocol_sha = hashlib.sha256(protocol.read_bytes()).hexdigest()
    tasks = {t["id"]: t for t in plan["tasks"]}
    data = {id: {} for id in tasks}
    for slot in range(plan["workers"]):
        status = json.loads((results / f"worker-{slot}.json").read_text())
        if status["phase"] != "complete" or status["protocolSHA256"] != protocol_sha:
            raise ValueError("Incomplete or mismatched worker")
        for line in (results / f"worker-{slot}.jsonl").read_text().splitlines():
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
                         "clint" if tasks[id].get("mixed") and p != focus else tasks[id]["model"] for p in range(4)]
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
            "model": task["model"], "opponent": task["opponent"], "mixed": task["mixed"],
            "pairs": len(points), "rounds": len(points) * 2,
            "wins": wins["wins"], "losses": wins["losses"], "draws": 0,
            "signedUpgradePoints": estimate(points), "roundWinScore": estimate(scores),
            "finishingRankPairs": dict(sorted(ranks.items())),
            "meanTurns": statistics.mean(turns),
        }
    contrasts = {}
    for group in ["vs-clint", "vs-p0", "vs-previous", "mixed-clint"]:
        a, b = data["champion-" + group], data["latest-" + group]
        if set(a) != set(b):
            raise ValueError("Common-opponent seeds differ")
        differences = []
        for seed in sorted(a):
            for ga, gb in zip(a[seed]["games"], b[seed]["games"]):
                if (ga["dealSHA256"], ga["level"], ga["leader"]) != (gb["dealSHA256"], gb["level"], gb["leader"]):
                    raise ValueError("Common-opponent deals differ")
            differences.append(statistics.mean(g["signedPoints"] for g in b[seed]["games"]) -
                               statistics.mean(g["signedPoints"] for g in a[seed]["games"]))
        contrasts[group] = estimate(differences, z=2.4977054744)
        contrasts[group]["confidenceLevel"] = 0.9875
        contrasts[group]["direction"] = "latest minus champion"
    primary = reports["head-to-head"]["signedUpgradePoints"]
    lo, hi = primary["ci"]
    winner = "latest" if lo > 0 else "champion" if hi < 0 else "inconclusive"
    return {
        "schema": 1, "id": plan["id"], "completedAtUTC": datetime.now(timezone.utc).isoformat(),
        "purpose": plan["purpose"], "protocolSHA256": protocol_sha,
        "models": plan["models"], "unit": "complete single round", "protocol": plan["rules"],
        "pipeline": plan["pipeline"], "pairing": plan["pairing"], "statistics": plan["analysis"],
        "plannedPairs": plan["plannedPairs"], "completedPairs": sum(v["pairs"] for v in reports.values()),
        "completedRounds": sum(v["rounds"] for v in reports.values()),
        "reports": reports, "secondaryContrasts": contrasts,
        "primaryWinner": winner, "primaryInterpretation": "Latest perspective; 95% seed-cluster CI for signed upgrade points",
        "scope": "Fixed models and observed lineups only; not whole-match strength, human coaching efficacy, or automatic champion promotion",
        "optimizerUpdatesExecuted": 0,
    }


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--protocol", required=True)
    p.add_argument("--results", required=True)
    p.add_argument("--output", required=True)
    args = p.parse_args()
    result = summarize(args.protocol, args.results)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"completeRounds": result["completedRounds"], "primaryWinner": result["primaryWinner"]}))
