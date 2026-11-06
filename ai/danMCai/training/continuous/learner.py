"""Continuous Deep Monte Carlo learner for the P0-architecture action-value network.

Actors write complete-match shards; this process keeps a replay buffer of the newest rows,
regresses Q(o, a) on the Monte Carlo return and periodically publishes an ONNX version that
actors load for their next match. It never edits the web model manifest.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from value_net import FEATURES, ValueNet, export_onnx, load_onnx_weights  # noqa: E402

TARGETS = 4


def read_json(path, fallback=None):
    try:
        with open(path, encoding="utf-8") as stream:
            return json.load(stream)
    except FileNotFoundError:
        return fallback


def write_json(path, value):
    temporary = f"{path}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
    for attempt in range(6):
        try:
            os.replace(temporary, path)
            break
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.01 * (attempt + 1))


def target(raw, match_weight):
    """Round level points (P0's original scale, ±1..±3) blended with the ±3-scaled match result."""
    return (1 - match_weight) * raw[:, 0] + match_weight * 3.0 * raw[:, 1]


class Replay:
    """Fixed-capacity ring of int8 features and float32 target components."""

    def __init__(self, capacity, seed):
        self.capacity = capacity
        self.x = np.zeros((capacity, FEATURES), np.int8)
        self.y = np.zeros((capacity, TARGETS), np.float32)
        self.size = 0
        self.cursor = 0
        self.random = np.random.default_rng(seed)

    def add(self, x, y):
        for start in range(0, len(x), self.capacity):
            xs, ys = x[start : start + self.capacity], y[start : start + self.capacity]
            n = len(xs)
            end = self.cursor + n
            if end <= self.capacity:
                self.x[self.cursor : end], self.y[self.cursor : end] = xs, ys
            else:
                first = self.capacity - self.cursor
                self.x[self.cursor :], self.y[self.cursor :] = xs[:first], ys[:first]
                self.x[: n - first], self.y[: n - first] = xs[first:], ys[first:]
            self.cursor = end % self.capacity
            self.size = min(self.capacity, self.size + n)

    def batch(self, n):
        index = self.random.integers(0, self.size, n)
        return self.x[index], self.y[index]


def learner_device(name):
    device = torch.device(name)
    if device.type not in ("cpu", "cuda", "mps"):
        raise ValueError("Supported learner devices are cpu, cuda and mps")
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("GPU requested but this Python has no usable CUDA/ROCm device")
    if device.type == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("Apple MPS requested but unavailable; refusing silent CPU fallback")
    return device


class Learner:
    def __init__(self, run):
        self.run = Path(run)
        self.config = read_json(self.run / "config.json")
        if not self.config:
            raise SystemExit(f"Missing {self.run / 'config.json'}")
        self.settings = self.config["learner"]
        self.device = learner_device(self.settings.get("device", "cpu"))
        torch.set_num_threads(int(self.settings["threads"]))
        torch.manual_seed(int(self.settings["seed"]))
        self.models = self.run / "models"
        self.shards = self.run / "shards"
        self.state_dir = self.run / "learner"
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.checkpoint = self.state_dir / "checkpoint.pt"
        self.replay = Replay(int(self.settings["capacity"]), int(self.settings["seed"]))
        self.ingested = set()
        self.counted = set()
        self.ingested_rows = 0
        self.step = 0
        self.trained_rows = 0
        self.loss_ema = None
        self.started = time.time()
        latest = read_json(self.models / "latest.json")
        initial = self.models / latest["file"]
        self.net = ValueNet(load_onnx_weights(initial)).to(self.device)
        self.optimizer = torch.optim.Adam(
            self.net.parameters(), lr=float(self.settings["learningRate"])
        )
        self.anchor = None
        if float(self.settings["anchorWeight"]) > 0:
            self.anchor = ValueNet(load_onnx_weights(self.run / "models" / "anchor.onnx")).to(self.device)
            self.anchor.requires_grad_(False)
        if self.checkpoint.exists():
            saved = torch.load(self.checkpoint, weights_only=True, map_location="cpu")
            self.net.load_state_dict(saved["model"])
            self.optimizer.load_state_dict(saved["optimizer"])
            self.step = saved["step"]
            self.trained_rows = saved["trainedRows"]
            self.ingested_rows = saved["ingestedRows"]
            self.counted = set(saved.get("countedShards", []))
        self.version = latest["version"]
        self.last_export = time.time()
        self.log(
            {
                "event": "start",
                "step": self.step,
                "initial": latest,
                "resumed": self.checkpoint.exists(),
                "device": str(self.device),
                "torch": torch.__version__,
                "hip": torch.version.hip,
            }
        )

    def log(self, record):
        record = {"t": time.time(), **record}
        with open(self.state_dir / "log.jsonl", "a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")

    def manifests(self):
        return sorted(self.shards.glob("*.json"), key=lambda p: (p.stat().st_mtime, p.name))

    def ingest(self):
        """Load complete shards, then delete files no longer needed to refill the buffer."""
        added = 0
        manifests = self.manifests()
        for manifest in manifests:
            if manifest.name in self.ingested:
                continue
            meta = read_json(manifest)
            stem = manifest.with_suffix("")
            x = np.fromfile(f"{stem}.x.i8", np.int8)
            y = np.fromfile(f"{stem}.y.f32", np.float32)
            rows = int(meta["rows"])
            if x.size != rows * FEATURES or y.size != rows * TARGETS:
                self.log({"event": "bad-shard", "name": manifest.name})
                self.ingested.add(manifest.name)
                continue
            self.replay.add(x.reshape(rows, FEATURES), y.reshape(rows, TARGETS))
            self.ingested.add(manifest.name)
            if manifest.name not in self.counted:
                self.counted.add(manifest.name)
                self.ingested_rows += rows
                added += rows
        kept = 0
        for manifest in reversed(manifests):
            if manifest.name not in self.ingested:
                continue
            meta = read_json(manifest, {"rows": 0})
            kept += int(meta["rows"])
            if kept > self.replay.capacity:
                stem = manifest.with_suffix("")
                for suffix in (".x.i8", ".y.f32", ".json"):
                    Path(f"{stem}{suffix}").unlink(missing_ok=True)
                self.ingested.discard(manifest.name)
                self.counted.discard(manifest.name)
        return added

    def train_step(self):
        x, raw = self.replay.batch(int(self.settings["batch"]))
        features = torch.from_numpy(x.astype(np.float32)).to(self.device)
        goal = torch.from_numpy(target(raw, float(self.settings["targetMatchWeight"]))).to(self.device)
        prediction = self.net(features)
        loss = torch.mean((prediction - goal) ** 2)
        if self.anchor is not None:
            with torch.no_grad():
                reference = self.anchor(features)
            loss = loss + float(self.settings["anchorWeight"]) * torch.mean(
                (prediction - reference) ** 2
            )
        if not torch.isfinite(loss):
            self.log({"event": "non-finite-loss", "step": self.step})
            raise SystemExit(3)
        self.optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.net.parameters(), float(self.settings["gradClip"]))
        self.optimizer.step()
        self.step += 1
        self.trained_rows += len(x)
        value = float(loss.detach().cpu())
        self.loss_ema = value if self.loss_ema is None else 0.99 * self.loss_ema + 0.01 * value

    def publish(self):
        version = f"v{self.step:09d}"
        file = f"{version}.onnx"
        digest = export_onnx(self.net.weights(), self.models / file)
        torch.save(
            {
                "model": self.net.state_dict(),
                "optimizer": self.optimizer.state_dict(),
                "step": self.step,
                "trainedRows": self.trained_rows,
                "ingestedRows": self.ingested_rows,
                "countedShards": sorted(self.counted),
            },
            f"{self.checkpoint}.tmp",
        )
        os.replace(f"{self.checkpoint}.tmp", self.checkpoint)
        latest = {
            "version": version,
            "file": file,
            "sha256": digest,
            "step": self.step,
            "trainedRows": self.trained_rows,
            "ingestedRows": self.ingested_rows,
            "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        write_json(self.models / "latest.json", latest)
        self.version = version
        self.last_export = time.time()
        # ponytail: retain immutable exports until offline cleanup after ALL consumers stop.
        # A lane can reload an old version after ONNX session-cache eviction. Neither a
        # fixed version count nor the current latest.json proves that its readers ended.
        # At 600 s/export, a six-hour window adds about 185 MiB; diskLimitGB still applies.
        self.log({"event": "publish", **latest})

    def status(self, state):
        elapsed = max(1e-9, time.time() - self.started)
        write_json(
            self.state_dir / "status.json",
            {
                "pid": os.getpid(),
                "device": str(self.device),
                "deviceName": (
                    torch.cuda.get_device_name(self.device) if self.device.type == "cuda"
                    else "Apple MPS" if self.device.type == "mps" else "CPU"
                ),
                "torch": torch.__version__,
                "hip": torch.version.hip,
                "gpuAllocatedBytes": (
                    torch.cuda.memory_allocated(self.device) if self.device.type == "cuda"
                    else torch.mps.current_allocated_memory() if self.device.type == "mps" else None
                ),
                "state": state,
                "step": self.step,
                "version": self.version,
                "buffer": self.replay.size,
                "ingestedRows": self.ingested_rows,
                "trainedRows": self.trained_rows,
                "lossEMA": self.loss_ema,
                "replayRatio": self.trained_rows / max(1, self.ingested_rows),
                "stepsPerSecond": self.step_count / elapsed,
                "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
        )

    def loop(self, max_steps=0, max_seconds=0):
        self.step_count = 0
        min_samples = int(self.settings["minSamples"])
        ratio = float(self.settings["replayRatio"])
        batch = int(self.settings["batch"])
        last_ingest = last_status = 0
        stop = self.run / "STOP"
        while not stop.exists():
            now = time.time()
            if max_seconds and now - self.started >= max_seconds:
                break
            if max_steps and self.step_count >= max_steps:
                break
            if now - last_ingest >= 5:
                self.ingest()
                last_ingest = now
            ready = self.replay.size >= min_samples
            allowed = self.trained_rows + batch <= ratio * self.ingested_rows
            if not (ready and allowed):
                self.status("waiting-for-data")
                time.sleep(2)
                continue
            self.train_step()
            self.step_count += 1
            if self.step % 100 == 0:
                self.log({"event": "train", "step": self.step, "lossEMA": self.loss_ema})
            if now - last_status >= 10:
                self.status("training")
                last_status = now
            if now - self.last_export >= float(self.settings["exportSeconds"]):
                self.publish()
        if self.step_count:
            self.publish()
        self.status("stopped")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", default="ai/danMCai/runs/main")
    parser.add_argument("--max-steps", type=int, default=0)
    parser.add_argument("--max-seconds", type=float, default=0)
    args = parser.parse_args()
    Learner(args.run).loop(args.max_steps, args.max_seconds)


if __name__ == "__main__":
    main()
