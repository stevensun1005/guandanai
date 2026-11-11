"""Window 5 G1 (PLAN section 4, review R2): DESCRIPTIVE true-deal regression of belief v2a at 41-60
cards. Window 4's g1_gate.py; the old S4c eligibility thresholds are computed and REPORTED AS NUMBERS
ONLY: they decide nothing (G1 never gates D5/ACC5). Window-4 docstring follows.
(window 4) Eligibility only (not play, not acceptance). The regression and its bootstrap are window-3
scripts/s4c_gate.py's, unchanged (copy kept in RT/inputs/g1/s4c_gate.py):

  for every position and every non-champion root i, y = trueOutcome[i] - trueOutcome[c],
  x = mean over worlds of (outcome[:, i] - outcome[:, c]), q = rootQ[i] - rootQ[c];
  fit y = a + b x + g q by least squares; 95% intervals from 1,000 position-bootstrap draws
  (numpy default_rng(20261110), as S4c).

    python g1_gate.py <G1 dir> <G1/gate-v2a.json> [planned=160]

Rule (PLAN row G1, = S4c criteria 1 and 2; S4c's 81-108 criterion is not part of G1):
  (1) lane v2a (64 v2a-marginal worlds, common random numbers): rollout coefficient 95% lower
      bound >= 0.5 AND intercept interval covers 0, on all 160 stored 41-60 positions;
  (2) log loss per unseen copy at 41-60 and at 61-80 (metrics.mjs, seeds 3990000000..3990000299,
      every 2nd turn, same as S4c) not worse than v1 by more than 0.01 in either band.
eligible = (1) and (2) and complete; anything missing -> eligible false, "not eligible (incomplete)".
Descriptive only: lane v1 (control re-run, same worlds seeds), the v2a regression on the positions
both lanes completed, 81-108 log loss, and the sampled four-of-a-kind ranks (structure-*.json).
"""
import glob
import json
import sys

import numpy as np

D, OUT = sys.argv[1], sys.argv[2]
PLANNED = int(sys.argv[3]) if len(sys.argv) > 3 else 160


def lane_rows(lane):
    rows = {}
    for f in sorted(glob.glob(f"{D}/{lane}/part-*.jsonl")):
        for line in open(f):
            if line.strip():
                try:
                    r = json.loads(line)
                    rows[r["id"]] = r
                except Exception:
                    pass
    return rows


def regression(rows, seed=20261110):
    rng = np.random.default_rng(seed)
    xs, ys, qg, ids = [], [], [], []
    for r in rows.values():
        O = np.array(r["outcome"], float)
        c = r["championRoot"]
        m = (O - O[:, [c]]).mean(0)
        for i in range(O.shape[1]):
            if i != c:
                xs.append(m[i])
                ys.append(r["trueOutcome"][i] - r["trueOutcome"][c])
                qg.append(r["rootQ"][i] - r["rootQ"][c])
                ids.append(r["id"])
    if len(set(ids)) < 10:
        return None
    xs, ys, qg, ids = map(np.array, (xs, ys, qg, ids))
    uid = np.unique(ids)
    X = np.column_stack([np.ones(len(xs)), xs, qg])
    coef = np.linalg.lstsq(X, ys, rcond=None)[0]
    cb = []
    for _ in range(1000):
        pick = rng.choice(uid, len(uid))
        mk = np.concatenate([np.where(ids == u)[0] for u in pick])
        cb.append(np.linalg.lstsq(X[mk], ys[mk], rcond=None)[0])
    cb = np.array(cb)
    ci = lambda k: [round(float(v), 3) for v in np.percentile(cb[:, k], [2.5, 97.5])]
    return {
        "positions": int(len(uid)),
        "alternatives": int(len(xs)),
        "intercept": round(float(coef[0]), 3),
        "interceptCI": ci(0),
        "rollout": round(float(coef[1]), 3),
        "rolloutCI": ci(1),
        "qGap": round(float(coef[2]), 3),
        "qGapCI": ci(2),
    }


def read(path):
    try:
        return json.load(open(path))
    except Exception:
        return None


v2a, v1 = lane_rows("v2a"), lane_rows("v1")
res = {
    "stage": "G1",
    "window": "window5-20261111",
    "note": "DESCRIPTIVE (PLAN review R2): true-deal regression and log loss of v2a at 41-60; the old S4c thresholds are reported as numbers and decide nothing; not acceptance, not play, no strength claim; log-loss seeds 3990000000-3990000299 are used a third time (S4c, v1b, v2a), which weakens that test (R8)",
    "positions41to60": {"planned": PLANNED, "v2aCompleted": len(v2a), "v1Completed": len(v1)},
    "worlds": 64,
    "commonRandomNumbers": "world seeds worldSeed(position seed, ply) identical in both lanes; worlds differ only through the belief network",
    "laneOrder": "v2a lane first, then v1 control in the time left; both descriptive",
    "reference": {
        "v1_128worlds_window3": "rollout 0.03 [-0.36, 0.46], Q gap 1.24 [0.69, 1.72] (calibration.md, all 320 positions)",
        "v1b_64worlds_S4c": "rollout 0.189 [-0.384, 0.703], intercept 0.166 [-0.195, 0.517] (window-3 S4/gate-v1b.json)",
    },
}
crit = {}
reg = regression(v2a)
res["regressionV2a"] = reg
crit["1_v2a_rolloutLowerBound>=0.5_and_interceptCovers0"] = (
    None if reg is None else bool(reg["rolloutCI"][0] >= 0.5 and reg["interceptCI"][0] <= 0 <= reg["interceptCI"][1])
)
res["regressionV1Control"] = regression(v1)
common = sorted(set(v1) & set(v2a))
res["commonPositions"] = len(common)
if len(common) >= 10 and len(common) < len(v2a):
    res["regressionV2aOnCommon"] = regression({k: v2a[k] for k in common})

m1, m2 = read(f"{D}/metrics-v1.json"), read(f"{D}/metrics-v2a.json")
if m1 and m2:
    b1, b2 = m1.get("byTableCards", {}), m2.get("byTableCards", {})
    comp, ok2 = {}, True
    for band in ["41-60", "61-80"]:
        if band in b1 and band in b2:
            d = b2[band]["beliefLogLossPerCopy"] - b1[band]["beliefLogLossPerCopy"]
            comp[band] = {
                "v1": round(b1[band]["beliefLogLossPerCopy"], 4),
                "v2a": round(b2[band]["beliefLogLossPerCopy"], 4),
                "uniform": round(b2[band]["uniformLogLossPerCopy"], 4),
                "v2aMinusV1": round(d, 4),
                "decisions": b2[band].get("decisions"),
            }
            ok2 = ok2 and d <= 0.01
        else:
            ok2 = False
    hi = [k for k in ["81-100", "101-120"] if k in b1 and k in b2]
    if hi:
        n = sum(b2[k]["decisions"] for k in hi)
        w = lambda b, key: sum(b[k][key] * b[k]["decisions"] for k in hi) / n
        comp["81-108 (descriptive)"] = {
            "v1": round(w(b1, "beliefLogLossPerCopy"), 4),
            "v2a": round(w(b2, "beliefLogLossPerCopy"), 4),
            "uniform": round(w(b2, "uniformLogLossPerCopy"), 4),
            "decisions": n,
        }
    comp["seeds"] = "3990000000..3990000299 (calibration self-play seeds; held out from v1 and v2a training), every 2nd turn, as S4c"
    comp["v1SHA256"], comp["v2aSHA256"] = m1.get("beliefSHA256"), m2.get("beliefSHA256")
    res["logLoss"] = comp
    crit["2_logLoss41-60_and_61-80_notWorseThanV1By>0.01"] = bool(ok2)
else:
    crit["2_logLoss41-60_and_61-80_notWorseThanV1By>0.01"] = None
res["structure"] = {lane: read(f"{D}/structure-{lane}.json") for lane in ("v2a", "v1")}
for lane in ("v2a", "v1"):
    s = res["structure"][lane]
    if s:
        s.pop("rows", None)
res["oldS4cThresholdsReportedOnly"] = crit
res["complete"] = len(v2a) >= PLANNED
res["decision"] = "descriptive only (no decision; PLAN review R2)"
json.dump(res, open(OUT, "w"), indent=2)
print(json.dumps({"complete": res["complete"], "decision": res["decision"], "oldThresholdsReportedOnly": crit,
                  "v2a": reg and {k: reg[k] for k in ("positions", "rollout", "rolloutCI", "intercept", "interceptCI")}}))
