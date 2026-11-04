"""Whole-match self-play inference and raw-input collection for complete-network training."""

import json
import os
from pathlib import Path
import sys

import numpy as np
import onnxruntime as ort

from full_model import WIDTH, raw_features, sha, source_hashes


class FullEngine:
    def __init__(self, path):
        self.path = Path(path).resolve()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        self.engine = ort.InferenceSession(
            str(self.path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self.output = None
        self.pending = {}
        self.games = self.rows = 0
        self.model_hash = sha(self.path)
        self.sources = source_hashes()
        self.epsilon = float(os.environ.get("FULL_EPSILON", ".05"))
        if not 0 <= self.epsilon <= 1:
            raise ValueError("Invalid exploration probability")

    def score(self, state):
        features = raw_features(state)
        values = []
        for first in range(0, len(features), 128):
            chunk = features[first : first + 128]
            values.extend(
                self.engine.run(
                    ["values"],
                    {
                        "state": chunk[:1, :513],
                        "actions": chunk[:, 513:567],
                        "extras": chunk[:, 567:],
                    },
                )[0]
                .reshape(-1)
                .tolist()
            )
        if not np.isfinite(values).all():
            raise ValueError("Nonfinite full-network output")
        return np.asarray(values), features

    def initialize(self, message):
        self.output = Path(message["output"])
        self.output.mkdir(parents=True, exist_ok=True)
        self.stream = (self.output / "raw.f32").open("xb")
        self.collection = message
        self.random = np.random.default_rng(message["seed"])
        self.write_metadata()
        return {"ready": True, "modelSHA256": self.model_hash, "legalActionSupport": "all"}

    def decide(self, message):
        values, features = self.score(message["state"])
        index = (
            int(self.random.integers(len(values)))
            if self.random.random() < self.epsilon
            else int(np.argmax(values))
        )
        self.pending.setdefault(message["episode"], []).append(
            (message["seat"], features[index].copy())
        )
        return {"index": index}

    def finish(self, message):
        rows = []
        for seat, features in self.pending.pop(message["episode"], []):
            target = 0 if message["winner"] is None else 1 if seat % 2 == message["winner"] else -1
            rows.append(np.r_[features, target, message["episode"], seat].astype("<f4"))
        if rows:
            np.asarray(rows, dtype="<f4").tofile(self.stream)
        self.stream.flush()
        self.games += 1
        self.rows += len(rows)
        self.write_metadata()
        return {"stored": len(rows)}

    def write_metadata(self):
        expected = self.collection["options"]["games"]
        data = {
            "kind": "complete-match-raw",
            "version": 1,
            "features": WIDTH,
            "rowFloats": WIDTH + 3,
            "rows": self.rows,
            "games": self.games,
            "status": "complete" if self.games == expected and not self.pending else "collecting",
            "model": str(self.path),
            "modelSHA256": self.model_hash,
            "sourceSHA256": self.sources,
            "collection": self.collection,
            "epsilon": self.epsilon,
            "reward": "Terminal full-match team win +1, loss -1, draw 0",
        }
        (self.output / "metadata.json").write_text(json.dumps(data, indent=2), encoding="utf-8")


def main():
    engine = None
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if engine is None:
                engine = FullEngine(message.get("model") or os.environ["GUANDAN_POLICY_MODEL"])
            op = message.get("op")
            if op == "init":
                result = engine.initialize(message)
            elif op == "decide":
                result = engine.decide(message)
            elif op == "finish":
                result = engine.finish(message)
            elif op is None:
                result = {"values": engine.score(message)[0].tolist()}
            else:
                raise ValueError("Unknown whole-network operation")
            print(json.dumps(result, separators=(",", ":")), flush=True)
        except Exception as error:
            print(json.dumps({"error": str(error)}), flush=True)
    if engine and engine.output:
        engine.stream.close()


if __name__ == "__main__":
    main()
