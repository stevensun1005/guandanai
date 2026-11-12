"""Read-only endgame stop audit; no training or counter changes."""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from learner import OracleValueNet  # noqa: E402
from value_net import load_onnx_weights, sha256  # noqa: E402


def audit(run):
    read = lambda p: json.loads(p.read_text(encoding="utf-8-sig"))
    config = read(run / "config.json")
    state = torch.load(run / "learner/checkpoint.pt", map_location="cpu", weights_only=False)
    latest = read(run / "models/latest.json")
    exported = run / "models" / latest["file"]
    assert sha256(exported) == latest["sha256"]
    assert state["step"] == latest["step"]
    net = OracleValueNet(load_onnx_weights(config["champion"]["file"]))
    net.load_state_dict(state["net"])
    assert all(np.array_equal(a, b) for a, b in zip(net.weights(), load_onnx_weights(exported)))
    inherited = state.get("inherited") or {}
    updates = int(state["step"]) - int(inherited.get("step", 0))
    adam = state["optimizer"]
    assert len(adam["param_groups"]) == 1 and len(adam["param_groups"][0]["params"]) == 13
    assert len(adam["state"]) == (13 if updates else 0)
    if updates:
        assert all(int(v["step"]) == updates for v in adam["state"].values())
    rows = pending = retained = shards = 0
    for path in (run / "shards").glob("*.json"):
        d = read(path)
        n = d["rows"]
        rows += n
        shards += 1
        if path.stem not in state["ingested"]:
            pending += n
        if path.with_suffix(".x.i8").exists():
            assert path.with_suffix(".x.i8").stat().st_size == n * 567
            assert path.with_suffix(".o.i8").stat().st_size == n * 162
            assert path.with_suffix(".y.f32").stat().st_size == n * 4
            retained += n
    return {"checkpointSHA256": sha256(run / "learner/checkpoint.pt"), "latest": latest,
            "networkExactlyMatchesCheckpoint": True, "adamStates": len(adam["state"]),
            "adamMatchesNewUpdates": True, "newUpdates": updates, "inherited": inherited,
            "shards": shards, "cumulativeRows": rows, "retainedRows": retained,
            "ingestedRows": state["ingestedRows"], "pendingRows": pending,
            "trainedRows": state["trainedRows"], "replayRNGRestored": False,
            "scope": "Retained shards checked; evicted replay and RNG are not saved/restored"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--run", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    args.out.write_text(json.dumps(audit(args.run), indent=2) + "\n", encoding="utf-8")
