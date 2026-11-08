"""P0-architecture action-value network: load, train in PyTorch and export web-compatible ONNX.

The exported graph matches ``ai/danMCai/training/export_model.py``: inputs ``state`` [1, 513] and
``actions`` [batch, 54], output ``values`` [batch, 1]. The browser Worker, the Node table
evaluator and the continuous actors can therefore load any exported version unchanged.
"""

import hashlib
import os
from pathlib import Path

import numpy as np
import onnx
import torch
from onnx import TensorProto, helper, numpy_helper

STATE = 513
ACTION = 54
FEATURES = STATE + ACTION
WIDTH = 512
DEPTH = 5


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def load_onnx_weights(path):
    """Return [W0, b0, ..., W5, b5] with W shaped (inputs, outputs), as in policy.ckpt."""
    graph = onnx.load(str(path)).graph
    arrays = {item.name: numpy_helper.to_array(item) for item in graph.initializer}
    required = ["state_weight", "action_weight", "first_bias"]
    required += [f"{kind}{i}" for i in range(1, DEPTH + 1) for kind in ("w", "b")]
    if any(name not in arrays for name in required):
        raise ValueError(f"{path} is not a P0-architecture policy export")
    weights = [
        np.concatenate((arrays["state_weight"], arrays["action_weight"])),
        arrays["first_bias"],
    ]
    for i in range(1, DEPTH + 1):
        weights += [arrays[f"w{i}"], arrays[f"b{i}"]]
    validate(weights)
    return [np.ascontiguousarray(w, dtype=np.float32) for w in weights]


def validate(weights):
    shapes = [(FEATURES, WIDTH), (WIDTH,)]
    shapes += [(WIDTH, WIDTH), (WIDTH,)] * (DEPTH - 1) + [(WIDTH, 1), (1,)]
    if len(weights) != len(shapes) or any(w.shape != s for w, s in zip(weights, shapes)):
        raise ValueError("Unexpected value network shapes")
    if not all(np.isfinite(w).all() for w in weights):
        raise ValueError("Non-finite value network weights")


class ValueNet(torch.nn.Module):
    def __init__(self, weights=None):
        super().__init__()
        sizes = [FEATURES] + [WIDTH] * DEPTH + [1]
        self.layers = torch.nn.ModuleList(
            torch.nn.Linear(a, b) for a, b in zip(sizes[:-1], sizes[1:])
        )
        if weights is not None:
            self.load_weights(weights)

    def load_weights(self, weights):
        validate(weights)
        with torch.no_grad():
            for i, layer in enumerate(self.layers):
                layer.weight.copy_(torch.from_numpy(weights[2 * i].T.copy()))
                layer.bias.copy_(torch.from_numpy(weights[2 * i + 1].copy()))

    def weights(self):
        out = []
        for layer in self.layers:
            out += [
                layer.weight.detach().cpu().numpy().T.astype(np.float32).copy(),
                layer.bias.detach().cpu().numpy().astype(np.float32).copy(),
            ]
        return out

    def forward(self, features):
        hidden = features
        for layer in self.layers[:-1]:
            hidden = torch.tanh(layer(hidden))
        return self.layers[-1](hidden).squeeze(-1)


class ValueNetExtras(ValueNet):
    """Equivalent champion student at initialization; opt-in extras learner uses public features."""
    def __init__(self, weights=None):
        super().__init__(weights)
        self.extra_weight = torch.nn.Parameter(torch.zeros(53, WIDTH))

    def forward(self, features, extras):
        hidden = torch.tanh(self.layers[0](features) + extras @ self.extra_weight)
        for layer in self.layers[1:-1]:
            hidden = torch.tanh(layer(hidden))
        return self.layers[-1](hidden).squeeze(-1)


def export_onnx(weights, path):
    """Write the same graph layout as the deployed ai/danMCai/models/baseline/policy.onnx, atomically."""
    validate(weights)
    first = weights[0]
    initializers = [
        numpy_helper.from_array(first[:STATE].copy(), "state_weight"),
        numpy_helper.from_array(first[STATE:].copy(), "action_weight"),
        numpy_helper.from_array(weights[1], "first_bias"),
    ]
    nodes = [
        helper.make_node("Gemm", ["state", "state_weight", "first_bias"], ["state_hidden"]),
        helper.make_node("MatMul", ["actions", "action_weight"], ["action_hidden"]),
        helper.make_node("Add", ["state_hidden", "action_hidden"], ["first_linear"]),
        helper.make_node("Tanh", ["first_linear"], ["hidden0"]),
    ]
    previous = "hidden0"
    for i in range(1, DEPTH + 1):
        initializers += [
            numpy_helper.from_array(weights[2 * i], f"w{i}"),
            numpy_helper.from_array(weights[2 * i + 1], f"b{i}"),
        ]
        output = f"linear{i}" if i < DEPTH else "values"
        nodes.append(helper.make_node("Gemm", [previous, f"w{i}", f"b{i}"], [output]))
        if i < DEPTH:
            previous = f"hidden{i}"
            nodes.append(helper.make_node("Tanh", [output], [previous]))
    graph = helper.make_graph(
        nodes,
        "GuanDanPolicy",
        [
            helper.make_tensor_value_info("state", TensorProto.FLOAT, [1, STATE]),
            helper.make_tensor_value_info("actions", TensorProto.FLOAT, ["batch", ACTION]),
        ],
        [helper.make_tensor_value_info("values", TensorProto.FLOAT, ["batch", 1])],
        initializers,
    )
    model = helper.make_model(
        graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="GuandanAI"
    )
    model.ir_version = 8
    onnx.checker.check_model(model)
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    onnx.save(model, str(temporary))
    os.replace(temporary, path)
    return sha256(path)


def export_onnx_extras(weights, path, extra_weight=None):
    """Add a zero (or explicitly supplied) per-action public-feature projection, keeping values."""
    import tempfile
    extra = np.zeros((53, WIDTH), dtype=np.float32) if extra_weight is None else np.asarray(extra_weight, dtype=np.float32)
    if extra.shape != (53, WIDTH) or not np.isfinite(extra).all():
        raise ValueError('Invalid extras projection')
    path = Path(path)
    with tempfile.TemporaryDirectory(dir=path.parent) as directory:
        base = Path(directory) / 'base.onnx'
        export_onnx(weights, base)
        model = onnx.load(base)
    graph = model.graph
    graph.input.append(helper.make_tensor_value_info('extras', TensorProto.FLOAT, ['batch', 53]))
    graph.initializer.append(numpy_helper.from_array(extra.copy(), 'extra_weight'))
    nodes = list(graph.node)
    # Preserve the existing state/action summation, then add the independent public projection.
    nodes[2].output[0] = 'base_first_linear'
    nodes[3:3] = [helper.make_node('MatMul', ['extras', 'extra_weight'], ['extra_hidden']),
                  helper.make_node('Add', ['base_first_linear', 'extra_hidden'], ['first_linear'])]
    del graph.node[:]
    graph.node.extend(nodes)
    graph.name = 'GuandanChampionZeroExtrasStudent'
    onnx.checker.check_model(model)
    temporary = path.with_name(path.name + '.tmp')
    onnx.save(model, temporary)
    os.replace(temporary, path)
    return sha256(path)
