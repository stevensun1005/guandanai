"""Measure full-network training on a frozen copy of real training rows, never on held-out games."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import statistics
import sys
import time

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from value_net import FEATURES, ValueNet, load_onnx_weights, sha256  # noqa: E402


def capture(run, destination):
    """Copy a complete new shard before the learner retires it; leave the live run untouched."""
    run = Path(run)
    for _ in range(5):
        try:
            manifest = max((run / "shards").glob("*.json"), key=lambda p: p.stat().st_mtime_ns)
            meta = json.loads(manifest.read_text())
            stem = manifest.with_suffix("")
            x = np.fromfile(f"{stem}.x.i8", np.int8).reshape(-1, FEATURES)
            y = np.fromfile(f"{stem}.y.f32", np.float32).reshape(-1, 4)
            assert len(x) == len(y) == meta["rows"]
            break
        except FileNotFoundError:
            continue
    else:
        raise RuntimeError("Could not capture a stable complete training shard")
    destination.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(destination, x=x, y=y)
    config = json.loads((run / "config.json").read_text())
    destination.with_suffix(".json").write_text(json.dumps({
        "role": "throughput and numerical compatibility only; copied training rows, no held-out data",
        "run": str(run.resolve()), "manifest": manifest.name, "rows": len(x),
        "datasetSHA256": sha256(destination), "sourceSHA256": config.get("sourceSHA256", {}),
    }, indent=2))


def measure(args):
    dataset = Path(args.dataset)
    if args.capture_from:
        if dataset.exists():
            raise ValueError("Frozen benchmark data already exists; do not overwrite it")
        capture(args.capture_from, dataset)
    data = np.load(dataset)
    x, raw = data["x"], data["y"]
    weights = load_onnx_weights(args.policy)
    results = {}
    devices = args.devices.split(",")
    for repeat in range(args.repeats):
        for name in devices if repeat % 2 == 0 else devices[::-1]:
            device = torch.device(name)
            if device.type == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("GPU requested but no compatible GPU is available")
            torch.set_num_threads(args.threads if device.type == "cpu" else 1)
            net = ValueNet(weights).to(device)
            optimizer = torch.optim.Adam(net.parameters(), lr=1e-5)
            rng = np.random.default_rng(20261104)
            probe = torch.from_numpy(x[:64].astype(np.float32))
            with torch.no_grad():
                expected = ValueNet(weights)(probe).numpy()
                actual = net(probe.to(device)).cpu().numpy()
            np.testing.assert_allclose(actual, expected, atol=1e-4, rtol=1e-4)
            def step():
                index = rng.integers(0, len(x), args.batch)
                features = torch.from_numpy(x[index].astype(np.float32)).to(device)
                goal = torch.from_numpy(raw[index, 0]).to(device)
                loss = ((net(features) - goal) ** 2).mean()
                if not torch.isfinite(loss):
                    raise RuntimeError("Non-finite loss")
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
                optimizer.step()
                return float(loss.detach().cpu())
            for _ in range(args.warmup):
                step()
            if device.type == "cuda":
                torch.cuda.synchronize(device)
                torch.cuda.reset_peak_memory_stats(device)
            started = time.perf_counter()
            for _ in range(args.steps):
                loss = step()
            if device.type == "cuda":
                torch.cuda.synchronize(device)
            seconds = time.perf_counter() - started
            after = net.weights()
            assert all(not np.array_equal(a, b) for a, b in zip(weights[::2], after[::2]))
            record = results.setdefault(name, {
                "device": str(device),
                "name": torch.cuda.get_device_name(device) if device.type == "cuda" else "CPU",
                "cpuThreads": args.threads if device.type == "cpu" else 1,
                "runs": [],
            })
            record["runs"].append({
                "seconds": seconds, "steps": args.steps,
                "stepsPerSecond": args.steps / seconds, "lastLoss": loss,
                "forwardMaxAbsError": float(np.max(np.abs(actual - expected))),
                "allLayerWeightsChanged": True,
                "peakGPUAllocatedBytes": torch.cuda.max_memory_allocated(device) if device.type == "cuda" else None,
            })
            print(json.dumps({"repeat": repeat, "device": name, **record["runs"][-1]}), flush=True)
            del net, optimizer
            if device.type == "cuda":
                torch.cuda.empty_cache()
    for record in results.values():
        record["medianStepsPerSecond"] = statistics.median(r["stepsPerSecond"] for r in record["runs"])
        record["medianRowsPerSecond"] = record["medianStepsPerSecond"] * args.batch
    output = {
        "schema": 1, "completedUTC": datetime.now(timezone.utc).isoformat(),
        "role": "development throughput only; not match strength or held-out acceptance",
        "protocol": "Real copied training rows; float32, Adam 1e-5, gradient clipping 1; includes minibatch sampling, host-to-device transfer and loss synchronization; excludes disk ingestion and ONNX export",
        "caveat": "Existing six-actor CPU training continues concurrently; results describe this shared machine load, not an isolated hardware limit",
        "python": sys.version, "torch": torch.__version__, "hip": torch.version.hip,
        "policySHA256": sha256(args.policy), "datasetSHA256": sha256(dataset),
        "scriptSHA256": sha256(__file__), "batch": args.batch, "warmup": args.warmup,
        "stepsPerRepeat": args.steps, "repeats": args.repeats, "results": results,
    }
    Path(args.output).write_text(json.dumps(output, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--devices", default="cpu,cuda:0")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--capture-from")
    parser.add_argument("--policy", default="ai/local/models/baseline/policy.onnx")
    parser.add_argument("--batch", type=int, default=2048)
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()
    if min(arguments.batch, arguments.steps, arguments.warmup, arguments.repeats, arguments.threads) < 1:
        raise ValueError("Benchmark sizes must be positive")
    measure(arguments)
