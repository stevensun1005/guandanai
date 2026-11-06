"""Read-only model/Adam/replay and destination-backend verification. No optimizer updates."""

import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sys

import numpy as np
import torch

sys.dont_write_bytecode = True
from transfer import digest, verify  # noqa: E402
from value_net import ValueNet, load_onnx_weights  # noqa: E402


def check(snapshot, project, run, device="cpu"):
    snapshot, project, run = (Path(p).resolve() for p in (snapshot, project, run))
    manifest = verify(snapshot)
    parent = snapshot / manifest["sourceRun"]
    migration = json.loads((run / "migration.json").read_text())
    actual_sha = digest(run / "learner/checkpoint.pt")
    if actual_sha != digest(parent / "learner/checkpoint.pt") or actual_sha != migration["checkpointSHA256"]:
        raise ValueError("Prepared checkpoint differs from archived parent")
    if (run / "learner/status.json").exists():
        raise ValueError("Run has learner activity; this verifier is for preparation only")
    saved = torch.load(run / "learner/checkpoint.pt", weights_only=True, map_location="cpu")
    latest = json.loads((run / "models/latest.json").read_text())
    model = run / "models" / latest["file"]
    if digest(model) != latest["sha256"] or latest["step"] != saved["step"]:
        raise ValueError("Latest model/step mismatch")
    net = ValueNet(load_onnx_weights(model))
    if len(saved["optimizer"]["state"]) != len(list(net.parameters())):
        raise ValueError("Incomplete Adam parameter states")
    for key, value in net.state_dict().items():
        if not torch.equal(value, saved["model"][key]):
            raise ValueError("ONNX and checkpoint disagree: " + key)
    for state in saved["optimizer"]["state"].values():
        if int(state["step"]) != saved["step"] or any(not torch.isfinite(v).all() for v in state.values()):
            raise ValueError("Invalid Adam state")
    module_path = project / "ai/research/tools/audit-continuous-stop.py"
    spec = importlib.util.spec_from_file_location("stop_audit", module_path)
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)
    absent = set(saved["countedShards"]) - {p.name for p in (parent / "shards").glob("*.json")}
    shards = audit.audit_shards(run / "shards", saved["countedShards"], absent)
    for p in (parent / "shards").glob("*"):
        q = run / "shards" / p.name
        if digest(p) != digest(q) or abs(p.stat().st_mtime - q.stat().st_mtime) >= 0.001:
            raise ValueError("Replay bytes or mtime changed")
    features = np.fromfile(next((run / "shards").glob("*.x.i8")), dtype=np.int8).reshape(-1, 567)
    probe = torch.from_numpy(features[:129].astype(np.float32))
    backend = torch.device(device)
    if backend.type == "cuda" and not torch.cuda.is_available():
        raise ValueError("Requested Windows GPU backend is unavailable; do not start training")
    if backend.type not in ["cpu", "cuda"]:
        raise ValueError("Use cpu or cuda:0 (including AMD ROCm)")
    torch.set_num_threads(1)
    with torch.no_grad():
        expected = net(probe).numpy()
        actual = net.to(backend)(probe.to(backend)).cpu().numpy()
    np.testing.assert_allclose(actual, expected, atol=1e-4, rtol=1e-4)
    if not np.isfinite(actual).all():
        raise ValueError("Non-finite restored forward pass")
    optimizer = torch.optim.Adam(net.parameters(), lr=1e-5)
    optimizer.load_state_dict(saved["optimizer"])
    for parameter in net.parameters():
        state = optimizer.state[parameter]
        for name in ["exp_avg", "exp_avg_sq"]:
            value = state[name]
            if value.shape != parameter.shape or value.device != parameter.device or not torch.isfinite(value).all():
                raise ValueError("Adam could not restore to destination backend")
    return {
        "passed": True, "verifiedAtUTC": datetime.now(timezone.utc).isoformat(),
        "platform": sys.platform, "python": sys.version, "torch": torch.__version__,
        "backendActuallyTested": str(backend), "hip": torch.version.hip,
        "gpuName": torch.cuda.get_device_name(backend) if backend.type == "cuda" else None,
        "gpuTotalMemoryBytes": torch.cuda.get_device_properties(backend).total_memory if backend.type == "cuda" else None,
        "gpuPeakAllocatedBytes": torch.cuda.max_memory_allocated(backend) if backend.type == "cuda" else None,
        "torchHostThreads": torch.get_num_threads(),
        "step": saved["step"], "checkpointSHA256": actual_sha,
        "networkMatchesCheckpointExactly": True, "adamStates": len(saved["optimizer"]["state"]),
        "allAdamStatesFiniteAndStepsMatch": True,
        "adamRestoredOnBackendWithoutUpdate": True,
        "retainedReplayRows": shards["retainedRows"], "retainedShards": shards["shards"],
        "pendingRows": shards["pendingRows"], "shardBytesAndMtimePreserved": True,
        "forwardRows": len(probe), "forwardMaxAbsError": float(np.max(np.abs(actual - expected))),
        "optimizerUpdatesExecuted": 0, "trainingStarted": False,
        "oldMacScheduleCopiedToNewRun": (run / "schedule.json").exists(),
        "limit": "Backend actually tested only; a Mac CPU check does not verify Windows ROCm/CUDA or DirectML",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if output.is_relative_to(Path(args.run).resolve()) or output.is_relative_to(Path(args.snapshot).resolve()):
        raise ValueError("Verification output must be outside run and snapshot")
    result = check(args.snapshot, args.project, args.run, args.device)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))
