"""Fused export of a frozen champion plus a learned endgame residual: q(s, a) = c(s, a) + f(s, a).

Both c and f are P0-architecture 567->512x5->1 tanh MLPs. The fused ONNX graph computes the two
towers side by side from the same inputs and adds their outputs, keeping EXACTLY the champion I/O
contract that ``createModelPool`` (Node) and ``inferPolicy`` (browser) feed: inputs ``state``
float32 [1, 513] and ``actions`` float32 [batch, 54], output ``values`` float32 [batch, 1].

The champion tower reproduces ``value_net.export_onnx`` node by node, so a residual whose output
layer is zero yields exactly the champion's values. Initializers carry ``c_`` / ``r_`` prefixes so
``load_onnx_weights`` refuses the fused file instead of silently reading only the champion half.

Residual weights are stored as ``.npz`` with keys W0, b0, ..., W5, b5 in the value_net layout
(W shaped (inputs, outputs)), plus ``champion_sha256`` when the residual was trained against a
known champion; ``export`` refuses to fuse such a residual with a different champion file.

  python residual_export.py export --champion C.onnx --residual R.npz --out fused.onnx
  python residual_export.py reference --champion C.onnx --residual R.npz --rows X.i8 --out Y.f32
  python residual_export.py random-residual --champion C.onnx --seed 1 --scale 0.05 --out R.npz
  python residual_export.py zero-residual --champion C.onnx --out R.npz
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import onnx
import torch
from onnx import TensorProto, helper, numpy_helper

sys.path.insert(0, str(Path(__file__).resolve().parent))
from value_net import (  # noqa: E402
    ACTION,
    DEPTH,
    FEATURES,
    STATE,
    ValueNet,
    load_onnx_weights,
    sha256,
    validate,
)

GRAPH_NAME = "GuandanChampionPlusEndgameResidual"


def save_residual(weights, path, champion_sha256=None):
    validate(weights)
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp.npz")
    arrays = {f"{'W' if i % 2 == 0 else 'b'}{i // 2}": w for i, w in enumerate(weights)}
    if champion_sha256:
        arrays["champion_sha256"] = np.array(str(champion_sha256))
    np.savez(temporary, **arrays)
    os.replace(temporary, path)
    return sha256(path)


def load_residual(path):
    with np.load(path) as data:
        weights = []
        for i in range(DEPTH + 1):
            weights += [data[f"W{i}"], data[f"b{i}"]]
    weights = [np.ascontiguousarray(w, dtype=np.float32) for w in weights]
    validate(weights)
    return weights


def residual_champion(path):
    """Champion SHA-256 recorded with a residual, or None."""
    with np.load(path) as data:
        return str(data["champion_sha256"]) if "champion_sha256" in data.files else None


def zero_output_residual(champion_weights):
    """Hidden layers copied from the champion, output layer zero: f == 0 everywhere."""
    weights = [w.copy() for w in champion_weights]
    weights[-2] = np.zeros_like(weights[-2])
    weights[-1] = np.zeros_like(weights[-1])
    return weights


def _tower(prefix, weights):
    """Nodes and initializers of one tower; same op sequence as value_net.export_onnx."""
    first = weights[0]
    p = prefix
    initializers = [
        numpy_helper.from_array(first[:STATE].copy(), f"{p}state_weight"),
        numpy_helper.from_array(first[STATE:].copy(), f"{p}action_weight"),
        numpy_helper.from_array(weights[1], f"{p}first_bias"),
    ]
    nodes = [
        helper.make_node("Gemm", ["state", f"{p}state_weight", f"{p}first_bias"], [f"{p}state_hidden"]),
        helper.make_node("MatMul", ["actions", f"{p}action_weight"], [f"{p}action_hidden"]),
        helper.make_node("Add", [f"{p}state_hidden", f"{p}action_hidden"], [f"{p}first_linear"]),
        helper.make_node("Tanh", [f"{p}first_linear"], [f"{p}hidden0"]),
    ]
    previous = f"{p}hidden0"
    for i in range(1, DEPTH + 1):
        initializers += [
            numpy_helper.from_array(weights[2 * i], f"{p}w{i}"),
            numpy_helper.from_array(weights[2 * i + 1], f"{p}b{i}"),
        ]
        output = f"{p}linear{i}" if i < DEPTH else f"{p}values"
        nodes.append(helper.make_node("Gemm", [previous, f"{p}w{i}", f"{p}b{i}"], [output]))
        if i < DEPTH:
            previous = f"{p}hidden{i}"
            nodes.append(helper.make_node("Tanh", [output], [previous]))
    return nodes, initializers, f"{p}values"


def fused_onnx(champion_weights, residual_weights, path):
    """Write one graph computing champion + residual with the champion I/O contract; return SHA-256."""
    validate(champion_weights)
    validate(residual_weights)
    c_nodes, c_init, c_out = _tower("c_", champion_weights)
    r_nodes, r_init, r_out = _tower("r_", residual_weights)
    nodes = c_nodes + r_nodes + [helper.make_node("Add", [c_out, r_out], ["values"])]
    graph = helper.make_graph(
        nodes,
        GRAPH_NAME,
        [
            helper.make_tensor_value_info("state", TensorProto.FLOAT, [1, STATE]),
            helper.make_tensor_value_info("actions", TensorProto.FLOAT, ["batch", ACTION]),
        ],
        [helper.make_tensor_value_info("values", TensorProto.FLOAT, ["batch", 1])],
        c_init + r_init,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="GuandanAI")
    model.ir_version = 8
    onnx.checker.check_model(model)
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    onnx.save(model, str(temporary))
    os.replace(temporary, path)
    return sha256(path)


def torch_values(champion_weights, residual_weights, x, device="cpu", chunk=65536):
    """Reference c + f in float32 PyTorch for int8/float feature rows [n, 567]."""
    c_net = ValueNet(champion_weights).to(device).eval()
    f_net = ValueNet(residual_weights).to(device).eval()
    out = np.empty(len(x), np.float32)
    with torch.no_grad():
        for start in range(0, len(x), chunk):
            rows = torch.from_numpy(np.asarray(x[start : start + chunk], dtype=np.float32)).to(device)
            out[start : start + len(rows)] = (c_net(rows) + f_net(rows)).cpu().numpy()
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    export = sub.add_parser("export")
    export.add_argument("--champion", required=True)
    export.add_argument("--residual", required=True)
    export.add_argument("--out", required=True)
    export.add_argument("--expect-champion-sha256")
    reference = sub.add_parser("reference")
    reference.add_argument("--champion", required=True)
    reference.add_argument("--residual", required=True)
    reference.add_argument("--rows", required=True, help="int8 feature rows [n, 567]")
    reference.add_argument("--out", required=True, help="float32 c + f values [n]")
    random_residual = sub.add_parser("random-residual")
    random_residual.add_argument("--champion", required=True)
    random_residual.add_argument("--seed", type=int, required=True)
    random_residual.add_argument("--scale", type=float, default=0.05)
    random_residual.add_argument("--out", required=True)
    zero = sub.add_parser("zero-residual")
    zero.add_argument("--champion", required=True)
    zero.add_argument("--out", required=True)
    args = parser.parse_args()

    champion_digest = sha256(args.champion)
    champion = load_onnx_weights(args.champion)
    if args.command == "export":
        if args.expect_champion_sha256 and args.expect_champion_sha256 != champion_digest:
            raise SystemExit(f"Champion SHA-256 {champion_digest} != expected {args.expect_champion_sha256}")
        trained_against = residual_champion(args.residual)
        if trained_against and trained_against != champion_digest:
            raise SystemExit(f"Residual was trained against champion {trained_against}, not {champion_digest}")
        digest = fused_onnx(champion, load_residual(args.residual), args.out)
        print(json.dumps({"fused": str(args.out), "sha256": digest, "championSHA256": champion_digest,
                          "residualSHA256": sha256(args.residual)}))
    elif args.command == "reference":
        x = np.fromfile(args.rows, np.int8)
        if x.size % FEATURES:
            raise SystemExit("Row file is not a multiple of 567 int8 features")
        values = torch_values(champion, load_residual(args.residual), x.reshape(-1, FEATURES))
        values.astype(np.float32).tofile(args.out)
        print(json.dumps({"rows": len(values), "out": str(args.out)}))
    elif args.command == "random-residual":
        rng = np.random.default_rng(args.seed)
        weights = [
            (w + rng.normal(0, args.scale, w.shape)).astype(np.float32) for w in zero_output_residual(champion)
        ]
        digest = save_residual(weights, args.out, champion_sha256=champion_digest)
        print(json.dumps({"residual": str(args.out), "sha256": digest}))
    else:
        digest = save_residual(zero_output_residual(champion), args.out, champion_sha256=champion_digest)
        print(json.dumps({"residual": str(args.out), "sha256": digest}))


if __name__ == "__main__":
    main()
