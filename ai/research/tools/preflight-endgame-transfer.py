"""Bounded synthetic CUDA check of the registered endgame transfer; never strength evidence."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
import shutil
import sys
import time

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "ai/danMCai/endgame"))
from learner import Learner  # noqa: E402
from value_net import sha256  # noqa: E402

parser = argparse.ArgumentParser(__doc__)
parser.add_argument("--run", required=True, type=Path)
args = parser.parse_args()
root = args.run
plan = json.loads((root / "protocol.json").read_text(encoding="utf-8-sig"))
deadline = datetime.fromisoformat(plan["deadlineUTC"].replace("Z", "+00:00")).timestamp()
def check():
    if time.time() >= deadline or (root / "STOP").exists():
        raise RuntimeError("STOP/deadline")

check()
assert sha256(plan["checkpoint"]) == plan["checkpointSHA256"]
assert sha256(plan["champion"]) == plan["championSHA256"]
run = root / "synthetic"
assert not run.exists(), "Do not repeat a synthetic preflight in place"
(run / "learner").mkdir(parents=True)
(run / "models").mkdir()
(run / "shards").mkdir()
shutil.copyfile(plan["checkpoint"], run / "learner/init.pt")
config = {"deadline": plan["deadlineUTC"], "champion": {"file": plan["champion"]},
          "learner": {"device": "cuda", "threads": 1, "seed": 2026111207, "learningRate": 1e-5,
                      "batch": 8, "capacity": 128, "minSamples": 8, "replayRatio": 4,
                      "oracleDecaySteps": 29000, "exportSeconds": 600,
                      "init": {"file": "learner/init.pt", "sha256": plan["checkpointSHA256"]}}}
(run / "config.json").write_text(json.dumps(config), encoding="utf-8")
learner = Learner(run)
initial = json.loads((run / "models/latest.json").read_text())
assert initial["sha256"] == plan["initialStudentSHA256"]
assert learner.step == 61050 and len(learner.optimizer.state) == 0
rng = np.random.default_rng(2026111207)
learner.replay.add(rng.integers(0, 3, (32, 567), dtype=np.int8), rng.integers(0, 3, (32, 162), dtype=np.int8), np.resize(np.array([-3, -2, -1, 1, 2, 3], np.float32), 32))
for _ in range(2):
    check()
    assert learner.train_step() == 0
assert all(p.is_cuda and p.grad is not None and torch.isfinite(p.grad).all() for p in learner.net.parameters())
assert sum(int(torch.count_nonzero(p.grad) > 0) for p in learner.net.parameters()) == 12
assert torch.count_nonzero(learner.net.oracle_weight.grad) == 0
assert len(learner.optimizer.state) == 13
learner.save()
learner.publish()
restored = Learner(run)
assert restored.step == 61052 and len(restored.optimizer.state) == 13
assert all(torch.equal(v, restored.net.state_dict()[k]) for k, v in learner.net.state_dict().items())
result = {"passed": True, "device": str(learner.device), "deviceName": torch.cuda.get_device_name(0),
          "torch": torch.__version__, "hip": torch.version.hip, "initialStudentSHA256": initial["sha256"],
          "syntheticUpdates": 2, "cudaGradientGroups": 13, "nonzeroTrunkGradientGroups": 12,
          "oracleGradientNonzero": 0, "adamStates": 13, "temporaryRestoreExact": True,
          "newGames": 0, "formalRunUpdates": 0, "loss": learner.loss_ema}
(root / "gpu-preflight.json").write_bytes((json.dumps(result, indent=2) + "\n").encode())
print(json.dumps(result))
