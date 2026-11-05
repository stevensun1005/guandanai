"""Test checkpoint/Adam restoration, real updates and ONNX parity on the requested backend.

All probe updates are discarded. The transferred run and its checkpoint are read-only here.
"""

import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import tempfile
import time

import numpy as np
import onnxruntime as ort
import torch

from learner import Learner, learner_device, read_json, write_json
from value_net import FEATURES, ValueNet, load_onnx_weights, sha256


def probe(run, device="mps", steps=20):
    run = Path(run).resolve()
    learner_device(device)
    if device == "mps":
        if platform.system() != "Darwin" or platform.machine() != "arm64":
            raise RuntimeError("Run native Apple silicon Python, not Rosetta")
        if os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK") != "0":
            raise RuntimeError("Set PYTORCH_ENABLE_MPS_FALLBACK=0 for the compatibility probe")
        torch.mps.set_per_process_memory_fraction(0.5)
    checkpoint_sha = sha256(run / "learner/checkpoint.pt")
    config = read_json(run / "config.json")
    latest = read_json(run / "models/latest.json")
    model = run / "models" / latest["file"]
    if sha256(model) != latest["sha256"]:
        raise ValueError("Latest export SHA mismatch")
    manifests = sorted((run / "shards").glob("*.json"), key=lambda p: (p.stat().st_mtime, p.name))
    if not manifests:
        raise ValueError("Imported replay shards missing")
    source = manifests[-1]
    stem = source.with_suffix("")
    rows = min(512, int(read_json(source)["rows"]))
    if rows < 64:
        raise ValueError("Probe needs at least 64 imported replay rows")
    x = np.fromfile(str(stem) + ".x.i8", np.int8, count=rows * FEATURES).reshape(rows, FEATURES)
    y = np.fromfile(str(stem) + ".y.f32", np.float32, count=rows * 4).reshape(rows, 4)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="danMCai-probe-") as temporary:
        target = Path(temporary)
        for directory in ["models", "learner", "shards"]:
            (target / directory).mkdir()
        for name in [latest["file"], "latest.json", "anchor.onnx"]:
            shutil.copy2(run / "models" / name, target / "models" / name)
        shutil.copy2(run / "learner/checkpoint.pt", target / "learner/checkpoint.pt")
        config["learner"].update(device=device, threads=1, capacity=1024, batch=64)
        write_json(target / "config.json", config)
        learner = Learner(target)
        initial_step = learner.step
        if initial_step != latest["step"]:
            raise ValueError("Checkpoint and latest export steps differ")
        for a, b in zip(learner.net.weights(), load_onnx_weights(model)):
            np.testing.assert_array_equal(a, b)
        if not learner.optimizer.state:
            raise ValueError("Adam state was not restored")
        features = torch.from_numpy(x[:64].astype(np.float32))
        with torch.no_grad():
            cpu = ValueNet(learner.net.weights())(features).numpy()
            actual = learner.net(features.to(learner.device)).cpu().numpy()
        error = float(np.max(np.abs(cpu - actual)))
        np.testing.assert_allclose(actual, cpu, atol=1e-4, rtol=1e-4)
        learner.replay.add(x, y)
        before = learner.net.weights()
        for _ in range(steps):
            learner.train_step()
        if not any(not np.array_equal(a, b) for a, b in zip(before, learner.net.weights())):
            raise ValueError("Probe weights did not update")
        if not all(np.isfinite(a).all() for a in learner.net.weights()):
            raise ValueError("Non-finite probe weights")
        learner.publish()
        output = target / "models" / f"v{learner.step:09d}.onnx"
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(
            str(output), sess_options=options, providers=["CPUExecutionProvider"]
        )
        feed = {"state": x[:1, :513].astype(np.float32), "actions": x[:64, 513:].astype(np.float32)}
        exported = session.run(None, feed)[0].reshape(-1)
        combined = np.concatenate([np.repeat(feed["state"], 64, axis=0), feed["actions"]], axis=1)
        with torch.no_grad():
            expected = learner.net(torch.from_numpy(combined).to(learner.device)).cpu().numpy()
        export_error = float(np.max(np.abs(exported - expected)))
        np.testing.assert_allclose(exported, expected, atol=1e-4, rtol=1e-4)
    if sha256(run / "learner/checkpoint.pt") != checkpoint_sha:
        raise ValueError("Source checkpoint changed during probe")
    return {
        "kind": "test",
        "device": device,
        "platform": platform.platform(),
        "torch": torch.__version__,
        "strengthMatches": 0,
        "probeUpdatesDiscarded": steps,
        "sourceStep": initial_step,
        "checkpointSHA256": checkpoint_sha,
        "optimizerRestored": True,
        "initialWeightsMatchExport": True,
        "backendMaxAbsoluteError": error,
        "onnxMaxAbsoluteError": export_error,
        "sourceCheckpointUnchanged": True,
        "elapsedSeconds": round(time.monotonic() - started, 3),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--device", choices=["cpu", "mps"], default="mps")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = probe(args.run, args.device)
    write_json(args.output, result)
    print(json.dumps(result))
