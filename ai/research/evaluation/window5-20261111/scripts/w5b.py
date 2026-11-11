"""Window-5 W5-0b (PLAN section 4, review F8c/C8): 017's above-40 MSE against the whole-round label
and its round-cluster SD on 20 window-4 C1 blocks, and the scorer's rows/s. Descriptive; registers
L1-mse's detectable delta and cost BEFORE L1 has data. CPU, one thread.

    python w5b.py --src=<checkout> --c1=<C1 corpus dir> --champion=<017 onnx> --out=<json> [--blocks=20]
        [--seed=20261114] [--expected-heldout-rounds=2300,2600]

Blocks: the finished C1 blocks (blocks/bNNNNNN.done.json), sorted, 20 drawn without replacement with
numpy default_rng(20261114). Rows of a block belong to rounds in done.json `results` order (each
result's `rows`). Label = y[:, 0] (signed round points, targetMatchWeight 0, as the learner).
Prediction = 017's value (value_net.ValueNet on the x.i8 features, the learner's own forward).
Detectable delta (registered approximation): 2.8 x SD(per-round mean squared error) / sqrt(n held-out
rounds); the paired L1-minus-017 difference has SD <= that of either arm only if they correlate
positively, which is expected for a frozen-trunk extras model (stated as an approximation).
"""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

p = argparse.ArgumentParser()
p.add_argument("--src", required=True)
p.add_argument("--c1", required=True)
p.add_argument("--champion", required=True)
p.add_argument("--out", required=True)
p.add_argument("--blocks", type=int, default=20)
p.add_argument("--seed", type=int, default=20261114)
p.add_argument("--expected-heldout-rounds", default="2300,2600")
a = p.parse_args()
sys.path.insert(0, str(Path(a.src) / "ai/danMCai/training/continuous"))
from value_net import FEATURES, ValueNet, load_onnx_weights  # noqa: E402

torch.set_num_threads(1)


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


blocks = sorted(Path(a.c1, "blocks").glob("b*.done.json"))
if len(blocks) < a.blocks:
    sys.exit(f"only {len(blocks)} finished C1 blocks")
rng = np.random.default_rng(a.seed)
pick = sorted(rng.choice(len(blocks), a.blocks, replace=False).tolist())
net = ValueNet(load_onnx_weights(a.champion)).eval()
per_round, rows_total, secs, chosen = [], 0, 0.0, []
for i in pick:
    done = json.loads(blocks[i].read_text())
    stem = Path(a.c1, "blocks", done["name"], done["shard"])
    meta = json.loads(Path(f"{stem}.json").read_text())
    n = int(meta["rows"])
    x = np.fromfile(f"{stem}.x.i8", np.int8).reshape(n, FEATURES)
    y = np.fromfile(f"{stem}.y.f32", np.float32).reshape(n, 4)[:, 0]
    t0 = time.time()
    with torch.no_grad():
        pred = net(torch.from_numpy(x.astype(np.float32))).numpy().reshape(-1)
    secs += time.time() - t0
    err = (pred - y) ** 2
    k = 0
    for r in done["results"]:
        if r["rows"]:
            per_round.append((float(err[k:k + r["rows"]].sum()), r["rows"]))
        k += r["rows"]
    if k != n:
        sys.exit(f"{done['name']}: results rows {k} != shard rows {n}")
    rows_total += n
    chosen.append({"block": done["name"], "seeds": done["seeds"], "rows": n, "doneSHA256": sha(blocks[i])})
sse = np.array([s for s, _ in per_round])
cnt = np.array([c for _, c in per_round])
mse = sse.sum() / cnt.sum()
round_mse = sse / cnt
sd_round = float(np.std(round_mse, ddof=1))
# ratio-estimator SD of the pooled MSE over rounds (cluster bootstrap analogue), per sqrt(round)
resid = sse - mse * cnt
sd_cluster = float(np.sqrt((resid ** 2).sum() / (len(cnt) - 1)) / cnt.mean())
exp = [int(v) for v in a.expected_heldout_rounds.split(",")]
out = {
    "stage": "W5-0b", "kind": "descriptive registration (no decision)", "writtenAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "model": {"path": a.champion, "sha256": sha(a.champion), "id": "017 v000855042"},
    "data": {"corpus": a.c1, "band": "> 40 cards (C1 rows=above)", "blocksDrawn": a.blocks, "of": len(blocks), "seed": a.seed,
             "blocks": chosen, "rows": rows_total, "rounds": len(cnt), "use": "evaluation only (never trained on)"},
    "label": "y[:,0] signed whole-round points (+-1..+-3), targetMatchWeight 0",
    "mse017Above40": float(mse),
    "roundClusterSD": {"perRoundMSE": sd_round, "ratioEstimatorPerRound": sd_cluster},
    "scorer": {"rowsPerSecond": rows_total / secs if secs else None, "threads": 1, "seconds": secs, "device": "cpu"},
    "detectableDelta80": {str(n): 2.8 * sd_cluster / np.sqrt(n) for n in exp},
    "detectableNote": "2.8 x ratio-estimator SD / sqrt(held-out rounds) for the expected held-out rounds (10% of ~23-26 k C2 rounds); an approximation for the paired L1 - recalibrated-017 difference (registered before L1 has data)",
    "finalScoringEstimateSeconds": {"perMillionRows": 1e6 / (rows_total / secs) if secs else None},
}
Path(a.out).parent.mkdir(parents=True, exist_ok=True)
Path(a.out).write_text(json.dumps(out, indent=1) + "\n")
print(json.dumps({"mse017Above40": round(mse, 4), "rounds": len(cnt), "rows": rows_total, "sdCluster": round(sd_cluster, 4),
                  "rowsPerSecond": round(out["scorer"]["rowsPerSecond"] or 0), "detectableDelta80": {k: round(v, 4) for k, v in out["detectableDelta80"].items()}}))
