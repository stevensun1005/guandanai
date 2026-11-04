"""Local rollout inference and terminal-return collection. No network service."""

import os

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import hashlib
import json
from pathlib import Path
import sys
import time

import numpy as np
import onnx
from onnx import helper, TensorProto
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ai.reference.numpy_engine import encode, cards_array  # noqa: E402
from policy_features import POLICY_EXTRA_FEATURES, encode_policy_extras, encode_policy_extras_batch  # noqa: E402


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class RolloutEngine:
    def __init__(self, path):
        self.path = Path(path)
        graph = onnx.load(self.path)
        if "hidden4" not in {output.name for output in graph.graph.output}:
            graph.graph.output.append(
                helper.make_tensor_value_info("hidden4", TensorProto.FLOAT, ["batch", 512])
            )
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            graph.SerializeToString(), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self.has_extras = "extras" in {item.name for item in self.session.get_inputs()}
        self.output = None
        self.pending = {}
        self.rows = self.games = 0
        self.started = time.monotonic()
        self.model_sha = sha(self.path)
        self.base_sha = sha(ROOT / "ai/policy.onnx")
        self.features_sha = sha(ROOT / "scripts/policy_features.py")

    def score(self, state):
        inputs = {"state": encode(state).reshape(1, 513)}
        actions = np.asarray([cards_array(action) for action in state["actions"]])
        extras = encode_policy_extras_batch(state) if self.has_extras else None
        values, hidden = [], []
        for first in range(0, len(actions), 128):
            inputs["actions"] = actions[first : first + 128]
            if extras is not None:
                inputs["extras"] = extras[first : first + 128]
            out = self.session.run(["values", "hidden4"], inputs)
            values.append(out[0].reshape(-1))
            hidden.append(out[1])
        return np.concatenate(values), np.concatenate(hidden), extras

    def initialize(self, message):
        if self.output is not None:
            raise ValueError("Collector already initialized")
        self.output = Path(message["output"])
        self.output.mkdir(parents=True, exist_ok=True)
        self.stream = (self.output / "transitions.f32").open("xb")
        self.random = np.random.default_rng(message["seed"])
        self.config = message
        return {
            "ready": True,
            "modelSHA256": sha(self.path),
            "features": 512 + POLICY_EXTRA_FEATURES,
        }

    def decide(self, message):
        state = message["state"]
        scores, hidden, extras = self.score(state)
        chosen = int(np.argmax(scores))
        explore = message.get("explore", {})
        if self.random.random() < explore.get("epsilon", 0):
            # Explore plausible alternatives, rather than sabotage whole hands.
            top = np.argsort(-scores, kind="stable")[:8]
            logits = (scores[top] - scores[top].max()) / max(0.01, explore.get("temperature", 0.25))
            probability = np.exp(logits)
            probability /= probability.sum()
            chosen = int(self.random.choice(top, p=probability))
        extra = extras[chosen] if extras is not None else encode_policy_extras(state, chosen)
        # Store frozen representation and public extras only. No opponent hand or future cards.
        features = np.concatenate((hidden[chosen], extra)).astype(np.float32)
        self.pending.setdefault(message["episode"], []).append((message["seat"], features))
        return {"index": chosen, "value": float(scores[chosen])}

    def finish(self, message):
        transitions = self.pending.pop(message["episode"], [])
        rows = []
        for seat, features in transitions:
            sign = 1 if seat % 2 == message["winner"] else -1
            target = sign * (1 + 0.1 * message["points"])
            rows.append(np.r_[features, target, message["episode"], seat].astype("<f4"))
        if rows:
            np.asarray(rows, dtype="<f4").tofile(self.stream)
            self.stream.flush()
        self.rows += len(rows)
        self.games += 1
        self.write_metadata()
        return {"stored": len(rows), "rows": self.rows, "games": self.games}

    def write_metadata(self):
        metadata = {
            "version": 1,
            "features": 512 + POLICY_EXTRA_FEATURES,
            "rowFloats": 515 + POLICY_EXTRA_FEATURES,
            "rows": self.rows,
            "games": self.games,
            "model": str(self.path),
            "modelSHA256": self.model_sha,
            "basePolicySHA256": self.base_sha,
            "extraFeaturesSHA256": self.features_sha,
            "reward": "team win sign * (1 + 0.1 * upgrade points)",
            "representation": "frozen 512-unit final hidden layer + public action/state extras",
            "split": "Unsplit complete episodes; trainer assigns balanced whole-game validation groups",
            "config": self.config,
            "elapsedSeconds": time.monotonic() - self.started,
        }
        (self.output / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")


def main():
    engine = None
    for line in sys.stdin:
        try:
            message = json.loads(line)
            op = message.get("op")
            if engine is None:
                model = (
                    message.get("model")
                    or os.environ.get("GUANDAN_POLICY_MODEL")
                    or ROOT / "ai/policy.onnx"
                )
                engine = RolloutEngine(model)
            if op == "init":
                result = engine.initialize(message)
            elif op == "decide":
                result = engine.decide(message)
            elif op == "finish":
                result = engine.finish(message)
            elif op is None:
                values, _, _ = engine.score(message)
                result = {"values": values.tolist()}
            else:
                raise ValueError(f"Unknown operation {op}")
            print(json.dumps(result, separators=(",", ":")), flush=True)
        except Exception as error:
            print(json.dumps({"error": str(error)}), flush=True)
    if engine is not None and engine.output is not None:
        engine.stream.close()


if __name__ == "__main__":
    main()
