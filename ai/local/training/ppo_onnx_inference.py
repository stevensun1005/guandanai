"""Native ONNX PPO inference with stable global proposal selection across batches."""

import os

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import json
import sys

import numpy as np
import onnxruntime as ort

from policy_learning import ROOT, encode, cards_array
from policy_features import encode_policy_extras_batch
from ppo_learning import file_sha


def select_ppo_values(proposals, logits, counts, k):
    proposals, logits = np.asarray(proposals, np.float32), np.asarray(logits, np.float32)
    if proposals.ndim != 1 or proposals.shape != logits.shape or not len(proposals):
        raise ValueError("Invalid PPO output shape")
    if not np.isfinite(proposals).all() or not np.isfinite(logits).all():
        raise ValueError("Nonfinite PPO scores")
    if any(count == 0 for count in counts):
        return proposals.copy()
    indices = np.argsort(-proposals, kind="stable")[:k]
    chosen_logits = logits[indices].astype(np.float64)
    maximum = chosen_logits.max()
    normalizer = maximum + np.log(np.exp(chosen_logits - maximum).sum())
    result = np.full(len(proposals), -1e9, np.float32)
    result[indices] = chosen_logits - normalizer
    return result


class PPOOnnxEngine:
    def __init__(self, path):
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self.config = json.loads(self.session.get_modelmeta().custom_metadata_map["guandan.policy"])
        if (
            self.config.get("schema") != 1
            or self.config.get("policyKind") != "frozen-proposal-ppo"
            or self.config.get("k") not in (2, 4)
        ):
            raise ValueError("Unsupported PPO ONNX contract")
        if {item.name for item in self.session.get_outputs()} != {"values", "policy_logits"}:
            raise ValueError("PPO ONNX output contract mismatch")
        if (
            file_sha(ROOT / "ai/local/training/policy_features.py") != self.config["featuresSHA256"]
            or file_sha(ROOT / "ai/local/reference/numpy_engine.py")
            != self.config["referenceEncoderSHA256"]
        ):
            raise ValueError("PPO encoding changed")

    def raw(self, state):
        inputs = {"state": encode(state)[None, :]}
        actions = np.array([cards_array(action) for action in state["actions"]], dtype=np.float32)
        extras = encode_policy_extras_batch(state)
        proposals, logits = [], []
        for first in range(0, len(actions), 128):
            inputs["actions"] = actions[first : first + 128]
            inputs["extras"] = extras[first : first + 128]
            output = self.session.run(["values", "policy_logits"], inputs)
            proposals.append(output[0].reshape(-1))
            logits.append(output[1].reshape(-1))
        return np.concatenate(proposals), np.concatenate(logits)

    def score(self, state):
        proposals, logits = self.raw(state)
        return select_ppo_values(proposals, logits, state["counts"], self.config["k"])


def main():
    model = os.environ.get("GUANDAN_POLICY_MODEL")
    if not model:
        raise ValueError("GUANDAN_POLICY_MODEL must name an exported PPO ONNX")
    engine = PPOOnnxEngine(model)
    for line in sys.stdin:
        try:
            state = json.loads(line)
            result = {
                "values": engine.score(state).tolist(),
                "policySHA256": engine.config["policySHA256"],
            }
        except Exception as error:
            result = {"error": str(error)}
        print(json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
