"""Descriptive reanalysis of archived match logs; no inference or new games."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np

ROOT = Path(__file__).resolve().parents[3]

# Use the actual match rules, rather than maintaining a second Python rules engine.
REPLAY = r"""
import {roundOutcome} from './web/src/core/match.js';
let text=''; for await (const part of process.stdin) text+=part;
const pairs=JSON.parse(text), rows=[];
for(const pair of pairs){
 if(pair.games.length!==2 || new Set(pair.games.map(g=>g.neuralTeam)).size!==2)
   throw Error('Missing paired sides');
 const c=Array(11).fill(0);
 for(const g of pair.games){
  let state={levels:[2,2],lvlTeam:0,L:2,aFails:[0,0]}, final;
  if(!g.history.length) throw Error('Empty history');
  for(let i=0;i<g.history.length;i++){
   const r=g.history[i], own=g.neuralTeam;
   if(r.round!==i+1 || r.level!==state.L || new Set(r.order).size!==4 ||
      r.order.some(p=>![0,1,2,3].includes(p))) throw Error('Invalid history');
   const next=roundOutcome(state,r.order,'draw'), out=next.result;
   for(const k of Object.keys(out)) if(JSON.stringify(out[k])!==JSON.stringify(r[k]))
     throw Error('Rule replay mismatch: '+k);
   const ownA=state.lvlTeam===own && state.L===14;
   const oppA=state.lvlTeam!==own && state.L===14;
   c[0]+=Number(ownA && out.team===own && out.up===1); c[1]+=Number(ownA);
   c[2]+=Number(oppA && out.team!==own && out.up>=2); c[3]+=Number(oppA);
   c[9]++; c[10]+=Number(ownA && out.team===own);
   if((out.win||out.draw) && i!==g.history.length-1) throw Error('Play after terminal');
   state={...next,L:next.levels[next.lvlTeam]}; final=out;
  }
  const winner=final.draw?null:final.win?final.team:undefined;
  if(winner===undefined || winner!==g.winner) throw Error('Unfinished or wrong winner');
  c[4]+=Number(winner!==null && winner!==g.neuralTeam && final.aTeam!==g.neuralTeam && final.up>=2);
  c[5]+=Number(winner!==null && winner!==g.neuralTeam);
  c[6]+=Number(final.draw && final.aTry===3); c[7]++; c[8]+=Number(winner===g.neuralTeam);
 }
 rows.push(c);
}
const transitions=[];
for(const level of [12,13,14]) for(const active of [0,1]) for(const signed of [-3,-2,-1,1,2,3]){
 const team=signed>0?0:1, up=Math.abs(signed), orders={1:[0,1,3,2],2:[0,1,2,3],3:[0,2,1,3]};
 const order=orders[up].map(p=>p^team);
 const before={levels:[level,14],lvlTeam:active,L:active?14:level,aFails:[0,0]};
 const next=roundOutcome(before,order,'draw');
 transitions.push({ownLevel:level,activeTeam:active,signedRoundPoints:signed,
   ownLevelDelta:next.levels[0]-level,opponentLevelDelta:next.levels[1]-14,
   terminal:next.result.win?(team===0?'own-win':'own-loss'):null,
   failedAAttempt:next.result.aTry,
   scope:'exact state transition; not a learned match-value estimate'});
}
process.stdout.write(JSON.stringify({rows,transitions}));
"""


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def summarize(rows, replicates=4000, seed=2026110701):
    a = np.asarray(rows, dtype=np.int64)
    if a.ndim != 2 or a.shape[1] != 11 or not len(a):
        raise ValueError("Invalid paired counters")
    totals = a.sum(axis=0)
    rng = np.random.default_rng(seed)
    # Resample entire deal-seed pairs, preserving both exchanged matches and all rounds.
    samples = np.stack([a[rng.integers(len(a), size=len(a))].sum(axis=0)
                        for _ in range(replicates)])
    metrics = {}
    for name, n, d in [("ownAPlusOnePerOwnAAttempt", 0, 1),
                       ("ownAPlusOnePerOwnAFirst", 0, 10),
                       ("opponentAWinPerOpponentAAttempt", 2, 3),
                       ("lossesEndingInOpponentAPlusTwoOrThree", 4, 5),
                       ("threeFailedADrawRate", 6, 7), ("matchWinRate", 8, 7)]:
        valid = samples[:, d] > 0
        values = samples[valid, n] / samples[valid, d]
        metrics[name] = {"numerator": int(totals[n]), "denominator": int(totals[d]),
                         "estimate": float(totals[n] / totals[d]) if totals[d] else None,
                         "pairedSeedCluster95CI": np.quantile(values, [.025, .975]).tolist()
                         if len(values) else None,
                         "undefinedBootstrapReplicates": int((~valid).sum())}
    return {"pairs": len(a), "matches": int(totals[7]), "rounds": int(totals[9]),
            "wins": int(totals[8]), "losses": int(totals[5]), "draws": int(totals[6]),
            "metrics": metrics}


def run(protocol):
    plan = json.loads(protocol.read_text(encoding="utf-8"))
    for file, expected in plan["sourceSHA256"].items():
        if sha(ROOT / file) != expected:
            raise ValueError("Frozen source changed: " + file)
    groups = {}
    transitions = None
    for name, source in plan["groups"].items():
        archive = ROOT / source["archive"]
        if sha(archive) != source["sha256"]:
            raise ValueError("Archive changed")
        parent_bytes = (ROOT / source["originalProtocol"]).read_bytes()
        parent = json.loads(parent_bytes)
        with gzip.open(archive, "rt", encoding="utf-8") as stream:
            pairs = [json.loads(line) for line in stream if line.strip()]
        if [p["seed"] for p in pairs] != parent["seeds"]:
            raise ValueError("Missing/reordered seeds")
        if any(p["protocolSHA256"] != hashlib.sha256(parent_bytes).hexdigest() for p in pairs):
            raise ValueError("Protocol mismatch")
        replay = subprocess.run(["node", "--input-type=module", "-e", REPLAY], cwd=ROOT,
                                input=json.dumps(pairs), text=True, capture_output=True,
                                encoding="utf-8", check=True)
        checked = json.loads(replay.stdout)
        transitions = checked["transitions"]
        groups[name] = {"model": parent["model"], "opponent": parent["opponent"],
                        "opponentModel": parent.get("opponentModel"), "rules": parent["rules"],
                        "pipeline": parent["pipeline"], "sourceSHA256": source["sha256"],
                        **summarize(checked["rows"], plan["bootstrapReplicates"],
                                    plan["bootstrapRNGSeed"])}
    return {"schema": 1, "kind": "archived-009-web-policy-proxy-not-017-evaluation",
            "protocolSHA256": sha(protocol), "newGames": 0, "optimizerUpdates": 0,
            "groups": groups, "stateTransitionDeltaTable": transitions,
            "limitations": [
                "All observations are historical 009 under web-policy shortcuts, not 017 raw argmax.",
                "Bootstrap clusters include both exchanged matches and their complete histories.",
                "All non-draw match losses must end with the opponent passing A by +2/+3 under these rules. The loss-share threshold is tautological, not evidence for changing objectives.",
                "Transition deltas are exact rules, not counterfactual causal effects or a fitted value function.",
                "No new seeds, models, training, match objective or website changes."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.protocol)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: {x: v[x] for x in ["pairs", "matches", "rounds", "wins", "losses", "draws"]}
                      for k, v in result["groups"].items()}, ensure_ascii=False))
