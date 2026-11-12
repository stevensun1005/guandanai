"""Transfer an endgame checkpoint's learned trunk delta onto a new champion, with fresh Adam.

This is an experimental initialization, not an exact optimizer resume. Original inputs stay intact.
"""
import argparse
import json
import sys
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from learner import OracleValueNet  # noqa: E402
from value_net import ValueNet, export_onnx, load_onnx_weights, sha256  # noqa: E402


def transferred_state(trained, old, new):
    if set(trained) != set(old) | {"oracle_weight"} or set(old) != set(new):
        raise ValueError("Trunk state keys differ")
    result = {"oracle_weight": trained["oracle_weight"].clone()}
    for key in old:
        if trained[key].shape != old[key].shape or old[key].shape != new[key].shape:
            raise ValueError(f"Trunk shape differs: {key}")
        result[key] = (new[key].double() + (trained[key].double() - old[key].double())).float()
    if not all(torch.isfinite(t).all() for t in result.values()):
        raise ValueError("Non-finite transferred weights")
    return result


def rebase(checkpoint, old, new, out, learning_rate):
    if out.exists():
        raise FileExistsError("Never overwrite a transferred checkpoint directory")
    previous = torch.load(checkpoint, map_location="cpu", weights_only=False)
    old_net = ValueNet(load_onnx_weights(old))
    new_weights = load_onnx_weights(new)
    new_net = OracleValueNet(new_weights)
    new_net.load_state_dict(
        transferred_state(previous["net"], old_net.state_dict(), ValueNet(new_weights).state_dict())
    )
    optimizer = torch.optim.Adam(new_net.parameters(), lr=learning_rate)
    metadata = {
        "method": "new_champion + (r2_trunk - old017_trunk), float64 arithmetic then float32",
        "checkpointSHA256": sha256(checkpoint), "oldBaseSHA256": sha256(old),
        "newBaseSHA256": sha256(new), "sourceStep": int(previous["step"]),
        "trunkParameters": len(old_net.state_dict()), "oracleProjection": "copied unchanged",
        "optimizer": "fresh Adam; zero state entries", "replay": "empty; old shards/RNG not restored",
        "validation": "Initialization only; no forward passes or optimizer updates; no strength claim",
    }
    state = {
        **previous, "net": new_net.state_dict(), "optimizer": optimizer.state_dict(),
        "ingested": [], "lossEma": None, "prunedRows": 0, "transfer": metadata,
    }
    out.mkdir(parents=True)
    torch.save(state, out / "checkpoint.pt")
    export_onnx(new_net.weights(), out / "initial.onnx")
    metadata.update({"transferredCheckpointSHA256": sha256(out / "checkpoint.pt"),
                     "initialStudentSHA256": sha256(out / "initial.onnx")})
    (out / "transfer.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser(__doc__)
    for name in ["checkpoint", "old", "new", "out"]:
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ["checkpoint", "old", "new"]:
        parser.add_argument("--" + name + "-sha", required=True)
    parser.add_argument("--learning-rate", type=float, default=1e-5)
    args = parser.parse_args()
    for name in ["checkpoint", "old", "new"]:
        if sha256(getattr(args, name)) != getattr(args, name + "_sha"):
            raise ValueError(f"{name} SHA mismatch")
    print(json.dumps(rebase(args.checkpoint, args.old, args.new, args.out, args.learning_rate)))
