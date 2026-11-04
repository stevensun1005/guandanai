"""Write paired rollout returns with public-only frozen representations."""

import hashlib
import json
import os
from pathlib import Path
import sys

import numpy as np

from policy_learning import ROOT, RolloutEngine
from policy_features import POLICY_EXTRA_FEATURES, encode_policy_extras_batch

K = 4
FEATURES = 512 + POLICY_EXTRA_FEATURES


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class CounterfactualWriter:
    def __init__(self, message):
        self.engine = RolloutEngine(message["model"])
        self.output = Path(message["output"])
        self.output.mkdir(parents=True, exist_ok=True)
        self.config = message
        self.rows = 0
        self.seeds = set()
        self.status = "running"
        self.streams = {
            name: (self.output / name).open("xb")
            for name in (
                "features.f32",
                "targets.f32",
                "mask.f32",
                "proposal-values.f32",
                "seeds.i64",
            )
        }
        self.provenance = {
            "model": str(self.engine.path),
            "modelSHA256": sha(self.engine.path),
            "basePolicySHA256": sha(ROOT / "ai/policy.onnx"),
            "extraFeaturesSHA256": sha(ROOT / "scripts/policy_features.py"),
            "referenceEncoderSHA256": sha(ROOT / "ai/reference/numpy_engine.py"),
            "sourceSHA256": message.get("sourceSHA256", {}),
        }
        self.write_metadata()

    def record(self, message):
        if self.status != "running":
            raise ValueError("Dataset already finalized")
        seed = message["seed"]
        indices = message["indices"]
        targets = message["returns"]
        state = message["state"]
        if (
            type(seed) is not int
            or seed in self.seeds
            or not self.config["seed"] <= seed < self.config["seed"] + self.config["games"]
            or not isinstance(indices, list)
            or not 2 <= len(indices) <= K
            or len(set(indices)) != len(indices)
            or len(targets) != len(indices)
            or any(
                type(index) is not int or not 0 <= index < len(state["actions"])
                for index in indices
            )
            or any(type(value) not in (int, float) or value not in (-1, 1) for value in targets)
        ):
            raise ValueError("Invalid counterfactual record")
        if any(count == 0 for count in state["counts"]):
            raise ValueError("Counterfactual pivot must precede first-out")
        scores, hidden, extras = self.engine.score(state)
        if extras is None:
            extras = encode_policy_extras_batch(state)
        features = np.zeros((K, FEATURES), dtype="<f4")
        returns = np.zeros(K, dtype="<f4")
        mask = np.zeros(K, dtype="<f4")
        proposals = np.zeros(K, dtype="<f4")
        for slot, index in enumerate(indices):
            features[slot] = np.r_[hidden[index], extras[index]]
            returns[slot] = targets[slot]
            mask[slot] = 1
            proposals[slot] = scores[index]
        if not np.isfinite(features).all() or not np.isfinite(proposals).all():
            raise ValueError("Nonfinite representation")
        for name, array in (
            ("features.f32", features),
            ("targets.f32", returns),
            ("mask.f32", mask),
            ("proposal-values.f32", proposals),
            ("seeds.i64", np.asarray([seed], dtype="<i8")),
        ):
            array.tofile(self.streams[name])
            self.streams[name].flush()
        self.seeds.add(seed)
        self.rows += 1
        if self.rows % 100 == 0:
            self.write_metadata()
        return {"stored": True, "rows": self.rows, "actions": len(indices)}

    def write_metadata(self):
        metadata = {
            "version": 1,
            "status": self.status,
            "rows": self.rows,
            "k": K,
            "features": FEATURES,
            "seedRange": [self.config["seed"], self.config["seed"] + self.config["games"] - 1],
            "reward": "First-out team win +1 / loss -1 relative to acting seat; ties retained.",
            "information": "Environment rollouts own all cards. Each policy receives only own hand/public observations. Training inputs are frozen own/public representations; branch returns are labels only.",
            "representation": "Frozen hidden4[512] plus public supplementary features[53].",
            "seedSHA256": sha(self.output / "seeds.i64"),
            "config": self.config,
            **self.provenance,
        }
        (self.output / "metadata.json").write_text(
            json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
        )

    def finalize(self, status):
        if status not in ("complete", "failed"):
            raise ValueError("Invalid completion status")
        self.status = status
        for stream in self.streams.values():
            stream.flush()
        self.write_metadata()
        return {"status": status, "rows": self.rows}

    def close(self):
        for stream in self.streams.values():
            stream.close()


def main():
    writer = None
    standalone = None
    try:
        for line in sys.stdin:
            try:
                message = json.loads(line)
                op = message.get("op")
                if op == "init":
                    if writer is not None:
                        raise ValueError("Collector already initialized")
                    writer = CounterfactualWriter(message)
                    result = {"ready": True, "features": FEATURES, "k": K}
                elif op == "record":
                    if writer is None:
                        raise ValueError("Initialize collector first")
                    result = writer.record(message)
                elif op == "finalize":
                    if writer is None:
                        raise ValueError("Initialize collector first")
                    result = writer.finalize(message["status"])
                elif op is None:
                    if writer is None and standalone is None:
                        standalone = RolloutEngine(
                            os.environ.get("GUANDAN_POLICY_MODEL", ROOT / "ai/policy.onnx")
                        )
                    engine = writer.engine if writer else standalone
                    scores, _, _ = engine.score(message)
                    result = {"values": scores.tolist()}
                else:
                    raise ValueError("Unknown operation")
                print(json.dumps(result, separators=(",", ":")), flush=True)
            except Exception as error:
                print(json.dumps({"error": str(error)}), flush=True)
    finally:
        if writer is not None:
            writer.close()


if __name__ == "__main__":
    main()
