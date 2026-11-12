"""Endgame oracle-guiding learner (Suphx-style oracle dropout on the danMCai value network).

The network is the champion's 567->512x5->1 tanh MLP plus a 162->512 projection of the other three
seats' private hands into the first layer. It starts as an exact copy of the champion (oracle
projection zero). Training regresses Q(o, a) on the decider team's final round points with Monte
Carlo targets, while each sample's oracle features are kept with probability p(step) that decays
from 1 to 0. After decay the oracle input is always zero, so the exported student, which drops the
oracle projection, is exactly the network that was trained: the same ONNX contract as the web.

A new run may start from an earlier run's checkpoint (config learner.init, SHA-checked by run.mjs and
again here): network, oracle projection and Adam state are inherited and the step count continues,
so the oracle schedule and export names carry on. Shard bookkeeping (ingested names, row counters
for the replay ratio, pruning) starts fresh, because the new run's shard names restart at s0-000000.
The inherited counters are kept separately under `inherited`.
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training" / "continuous"))
from value_net import FEATURES, WIDTH, ValueNet, export_onnx, load_onnx_weights, sha256  # noqa: E402

ORACLE = 162


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
    os.replace(temporary, path)


def labels_valid(y, kind="signed-points"):
    """Monte Carlo rows carry one realised result (+-1/+-2/+-3); PIMC rows carry an average of
    exact signed round points over sampled worlds, so any finite value in [-3, 3]."""
    if kind == "signed-points":
        return bool(np.isin(y, [-3, -2, -1, 1, 2, 3]).all())
    if kind == "pimc-mean":
        return bool(np.isfinite(y).all() and (np.abs(y) <= 3).all())
    raise ValueError(f"Unknown label kind {kind}")


def keep_probability(step, decay_steps):
    """Oracle keep rate: 1 at step 0, linearly to 0 at decay_steps, then 0."""
    if decay_steps <= 0:
        return 0.0
    return max(0.0, 1.0 - step / decay_steps)


class OracleValueNet(ValueNet):
    def __init__(self, weights):
        super().__init__(weights)
        self.oracle_weight = torch.nn.Parameter(torch.zeros(ORACLE, WIDTH))

    def forward(self, features, oracle):
        hidden = torch.tanh(self.layers[0](features) + oracle @ self.oracle_weight)
        for layer in self.layers[1:-1]:
            hidden = torch.tanh(layer(hidden))
        return self.layers[-1](hidden).squeeze(-1)


class Replay:
    def __init__(self, capacity, seed):
        self.capacity = capacity
        self.x = np.zeros((capacity, FEATURES), np.int8)
        self.o = np.zeros((capacity, ORACLE), np.int8)
        self.y = np.zeros(capacity, np.float32)
        self.size = self.cursor = 0
        self.random = np.random.default_rng(seed)

    def add(self, x, o, y):
        for i in range(0, len(x), self.capacity):
            xs, os_, ys = x[i : i + self.capacity], o[i : i + self.capacity], y[i : i + self.capacity]
            n = len(xs)
            idx = (self.cursor + np.arange(n)) % self.capacity
            self.x[idx], self.o[idx], self.y[idx] = xs, os_, ys
            self.cursor = (self.cursor + n) % self.capacity
            self.size = min(self.capacity, self.size + n)

    def batch(self, n):
        index = self.random.integers(0, self.size, n)
        return self.x[index], self.o[index], self.y[index]


def device_of(name):
    device = torch.device(name)
    if device.type == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("Apple MPS requested but unavailable; refusing silent CPU fallback")
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable; refusing silent CPU fallback")
    return device


class Learner:
    def __init__(self, run):
        self.run = Path(run)
        self.config = read_json(self.run / "config.json")
        self.s = self.config["learner"]
        self.device = device_of(self.s["device"])
        torch.set_num_threads(int(self.s["threads"]))
        torch.manual_seed(int(self.s["seed"]))
        self.models = self.run / "models"
        self.shards = self.run / "shards"
        self.state_dir = self.run / "learner"
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.checkpoint = self.state_dir / "checkpoint.pt"
        self.replay = Replay(int(self.s["capacity"]), int(self.s["seed"]))
        self.random = np.random.default_rng(int(self.s["seed"]) + 1)
        champion = load_onnx_weights(self.config["champion"]["file"])
        self.net = OracleValueNet(champion).to(self.device)
        self.optimizer = torch.optim.Adam(self.net.parameters(), lr=float(self.s["learningRate"]))
        self.step = self.trained_rows = self.ingested_rows = 0
        self.ingested = set()
        self.pruned_rows = 0
        self.loss_ema = None
        self.inherited = None
        self.started = time.time()
        if self.checkpoint.exists():
            state = torch.load(self.checkpoint, map_location=self.device, weights_only=False)
            self.net.load_state_dict(state["net"])
            self.optimizer.load_state_dict(state["optimizer"])
            self.set_learning_rate()
            self.step, self.trained_rows = state["step"], state["trainedRows"]
            self.ingested_rows, self.ingested = state["ingestedRows"], set(state["ingested"])
            self.loss_ema = state.get("lossEma")
            self.pruned_rows = state.get("prunedRows", 0)
            self.inherited = state.get("inherited")
            # Replay is not checkpointed: refill it from the newest shards still on disk.
            self.refill()
        else:
            if self.s.get("init"):
                self.start_from(self.s["init"])
            self.publish()

    def set_learning_rate(self):
        # A loaded Adam state carries the old run's learning rate; the frozen config decides.
        for group in self.optimizer.param_groups:
            group["lr"] = float(self.s["learningRate"])

    def start_from(self, init):
        """Inherit network, oracle projection, Adam state and step from a preregistered checkpoint."""
        path = self.run / init["file"]
        if sha256(path) != init["sha256"]:
            raise RuntimeError(f"Init checkpoint SHA mismatch: {path}")
        state = torch.load(path, map_location=self.device, weights_only=False)
        self.net.load_state_dict(state["net"])
        self.optimizer.load_state_dict(state["optimizer"])
        self.set_learning_rate()
        self.step = int(state["step"])
        previous = state.get("inherited") or {}
        self.inherited = {
            "sha256": init["sha256"],
            "step": self.step,
            "trainedRows": int(state["trainedRows"]) + int(previous.get("trainedRows", 0)),
            "ingestedRows": int(state["ingestedRows"]) + int(previous.get("ingestedRows", 0)),
            "chain": previous.get("chain", []) + [init["sha256"]],
        }

    def refill(self):
        names = sorted(p.name[:-5] for p in self.shards.glob("*.json"))
        rows = 0
        for name in reversed(names):
            if rows >= self.replay.capacity:
                break
            if not Path(f"{self.shards / name}.y.f32").exists():
                break  # older data files were pruned after ingestion
            rows += self.load(name, count=False)

    def prune(self):
        """Delete data files of ingested shards outside the newest keepShardRows rows.

        Training only ever samples the newest `capacity` rows, so pruning older ingested shards
        changes nothing it learns; it bounds disk use. Per-shard JSON metadata is kept as record.
        """
        keep = int(self.s.get("keepShardRows", 0))
        if keep <= 0:
            return
        live = []
        for meta in sorted(self.shards.glob("*.json"), key=lambda p: p.stat().st_mtime):
            name = meta.name[:-5]
            if name in self.ingested and Path(f"{self.shards / name}.y.f32").exists():
                live.append((name, read_json(meta, {}).get("rows", 0)))
        total = sum(rows for _, rows in live)
        for name, rows in live:
            if total <= keep:
                break
            for ext in ("x.i8", "o.i8", "y.f32"):
                Path(f"{self.shards / name}.{ext}").unlink(missing_ok=True)
            total -= rows
            self.pruned_rows += rows

    def load(self, name, count=True):
        base = self.shards / name
        y = np.fromfile(f"{base}.y.f32", np.float32)
        x = np.fromfile(f"{base}.x.i8", np.int8).reshape(len(y), FEATURES)
        o = np.fromfile(f"{base}.o.i8", np.int8).reshape(len(y), ORACLE)
        if not labels_valid(y, self.s.get("labels", "signed-points")):
            raise ValueError(f"{name}: labels outside signed round points")
        self.replay.add(x, o, y)
        if count:
            self.ingested.add(name)
            self.ingested_rows += len(y)
        return len(y)

    def ingest(self):
        added = 0
        for meta in sorted(self.shards.glob("*.json")):
            name = meta.name[:-5]
            if name not in self.ingested:
                added += self.load(name)
        return added

    def train_step(self):
        x, o, y = self.replay.batch(int(self.s["batch"]))
        keep = keep_probability(self.step, int(self.s["oracleDecaySteps"]))
        mask = (self.random.random(len(y)) < keep).astype(np.float32)[:, None]
        features = torch.from_numpy(x.astype(np.float32)).to(self.device)
        oracle = torch.from_numpy(o.astype(np.float32) * mask).to(self.device)
        goal = torch.from_numpy(y).to(self.device)
        loss = torch.mean((self.net(features, oracle) - goal) ** 2)
        self.optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.net.parameters(), 1.0)
        self.optimizer.step()
        self.step += 1
        self.trained_rows += len(y)
        value = float(loss.detach().cpu())
        self.loss_ema = value if self.loss_ema is None else 0.99 * self.loss_ema + 0.01 * value
        return keep

    def publish(self):
        """Export the student: the trained trunk without the oracle projection."""
        weights = [w for w in self.net.weights()]
        version = f"e{self.step:08d}"
        path = self.models / f"{version}.onnx"
        digest = export_onnx(weights, path)
        write_json(self.models / "latest.json", {"file": path.name, "version": version, "step": self.step, "sha256": digest})
        return digest

    def save(self):
        temporary = self.checkpoint.with_suffix(".tmp")
        torch.save(
            {
                "net": self.net.state_dict(),
                "optimizer": self.optimizer.state_dict(),
                "step": self.step,
                "trainedRows": self.trained_rows,
                "ingestedRows": self.ingested_rows,
                "ingested": sorted(self.ingested),
                "lossEma": self.loss_ema,
                "prunedRows": self.pruned_rows,
                "inherited": self.inherited,
            },
            temporary,
        )
        os.replace(temporary, self.checkpoint)

    def status(self, state, keep=None):
        write_json(
            self.state_dir / "status.json",
            {
                "state": state,
                "step": self.step,
                "trainedRows": self.trained_rows,
                "ingestedRows": self.ingested_rows,
                "replayRows": self.replay.size,
                "oracleKeep": keep,
                "prunedRows": self.pruned_rows,
                "lossEma": self.loss_ema,
                "device": str(self.device),
                "inherited": self.inherited,
                "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
        )

    def loop(self, max_steps=0):
        deadline = datetime.fromisoformat(self.config["deadline"].replace("Z", "+00:00")).timestamp()
        last_export = last_save = time.time()
        keep = None
        while True:
            stop = (self.run / "STOP").exists() or time.time() >= deadline or (max_steps and self.step >= max_steps)
            self.ingest()
            ratio_ok = self.trained_rows < float(self.s["replayRatio"]) * max(self.ingested_rows, 1)
            if stop:
                break
            if self.replay.size < int(self.s["minSamples"]) or not ratio_ok:
                self.status("waiting-for-data", keep)
                time.sleep(2)
                continue
            for _ in range(50):
                keep = self.train_step()
            if time.time() - last_export >= float(self.s["exportSeconds"]):
                self.publish()
                last_export = time.time()
            if time.time() - last_save >= 120:
                self.save()
                self.prune()
                last_save = time.time()
            self.status("training", keep)
        self.save()
        self.publish()
        self.status("stopped", keep)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--max-steps", type=int, default=0)
    args = parser.parse_args()
    Learner(args.run).loop(args.max_steps)


if __name__ == "__main__":
    main()
