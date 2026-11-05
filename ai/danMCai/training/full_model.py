"""Raw observation encoding and the complete trainable match-value network."""

import hashlib
import json
from pathlib import Path
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT))
from ai.danMCai.reference.numpy_engine import PolicyNetwork, encode, cards_array  # noqa: E402
from policy_features import encode_policy_extras_batch  # noqa: E402
from match_learning import match_features  # noqa: E402

WIDTH = 628  # 513 state + 54 action + 53 public action extras + 8 public match features
DIMS = [WIDTH, 512, 512, 512, 512, 512, 1]


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_hashes():
    paths = [
        "ai/danMCai/training/full_model.py",
        "ai/danMCai/training/full_learning.py",
        "ai/danMCai/training/match_learning.py",
        "ai/danMCai/training/policy_features.py",
        "ai/danMCai/reference/numpy_engine.py",
        "web/src/core/match.js",
        "ai/shared/simulation/match-simulation.mjs",
        "ai/shared/simulation/match-rollout.mjs",
    ]
    return {path: sha(ROOT / path) for path in paths}


def initial_parameters():
    weights = {}
    for i, (w, b) in enumerate(PolicyNetwork().layers):
        weights[f"w{i}"] = (
            np.concatenate([w, np.zeros((61, 512), np.float32)]) if i == 0 else w.copy()
        )
        weights[f"b{i}"] = b.copy()
    weights["w5"] *= 1 / 3
    weights["b5"] *= 1 / 3
    return weights


def save_parameters(path, weights, **extra):
    metadata = {
        "kind": "guandan-full-match-value",
        "version": 1,
        "dimensions": DIMS,
        "features": WIDTH,
        "objective": "Terminal whole-match team win +1, loss -1, draw 0",
        "actionSupport": "Every generated legal action; no proposal top-K mask",
        **extra,
    }
    np.savez(path, **weights, metadata=np.array(json.dumps(metadata, sort_keys=True)))


def load_parameters(path):
    with np.load(path, allow_pickle=False) as archive:
        metadata = json.loads(str(archive["metadata"]))
        if metadata.get("kind") != "guandan-full-match-value" or metadata.get("dimensions") != DIMS:
            raise ValueError("Incompatible complete-network checkpoint")
        weights = {name: archive[name].copy() for i in range(6) for name in (f"w{i}", f"b{i}")}
    for i, (inputs, outputs) in enumerate(zip(DIMS, DIMS[1:])):
        for name, shape in [(f"w{i}", (inputs, outputs)), (f"b{i}", (outputs,))]:
            value = weights[name]
            if value.shape != shape or value.dtype != np.float32 or not np.isfinite(value).all():
                raise ValueError(f"Invalid complete-network parameter {name}")
    return weights, metadata


def raw_features(state):
    n = len(state["actions"])
    result = np.empty((n, WIDTH), np.float32)
    result[:, :513] = encode(state)
    result[:, 513:567] = [cards_array(action) for action in state["actions"]]
    result[:, 567:620] = encode_policy_extras_batch(state)
    result[:, 620:] = match_features(state)
    return result


def export_model(path, weights):
    initializers = [
        numpy_helper.from_array(weights["w0"][:513].copy(), "state_w"),
        numpy_helper.from_array(weights["w0"][513:567].copy(), "action_w"),
        numpy_helper.from_array(weights["w0"][567:].copy(), "extra_w"),
        numpy_helper.from_array(weights["b0"], "b0"),
    ]
    nodes = [
        helper.make_node("Gemm", ["state", "state_w", "b0"], ["state_h"]),
        helper.make_node("MatMul", ["actions", "action_w"], ["action_h"]),
        helper.make_node("MatMul", ["extras", "extra_w"], ["extra_h"]),
        helper.make_node("Add", ["state_h", "action_h"], ["base_h"]),
        helper.make_node("Add", ["base_h", "extra_h"], ["linear0"]),
        helper.make_node("Tanh", ["linear0"], ["hidden0"]),
    ]
    previous = "hidden0"
    for i in range(1, 6):
        initializers.extend(
            [
                numpy_helper.from_array(weights[f"w{i}"], f"w{i}"),
                numpy_helper.from_array(weights[f"b{i}"], f"b{i}"),
            ]
        )
        output = "values" if i == 5 else f"linear{i}"
        nodes.append(helper.make_node("Gemm", [previous, f"w{i}", f"b{i}"], [output]))
        if i < 5:
            previous = f"hidden{i}"
            nodes.append(helper.make_node("Tanh", [output], [previous]))
    graph = helper.make_graph(
        nodes,
        "CompleteMatchPolicy",
        [
            helper.make_tensor_value_info("state", TensorProto.FLOAT, [1, 513]),
            helper.make_tensor_value_info("actions", TensorProto.FLOAT, ["batch", 54]),
            helper.make_tensor_value_info("extras", TensorProto.FLOAT, ["batch", 61]),
        ],
        [helper.make_tensor_value_info("values", TensorProto.FLOAT, ["batch", 1])],
        initializers,
    )
    model = helper.make_model(
        graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="GuandanAI"
    )
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, path)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--initialize", required=True)
    args = parser.parse_args()
    output = Path(args.initialize)
    output.mkdir(parents=True, exist_ok=False)
    weights = initial_parameters()
    save_parameters(
        output / "full.npz",
        weights,
        initialization="Original learned backbone, zero new observation weights, value output scaled by 1/3",
    )
    export_model(output / "policy.onnx", weights)
    print(
        json.dumps(
            {
                "parameters": sum(x.size for x in weights.values()),
                "modelSHA256": sha(output / "policy.onnx"),
            }
        )
    )
