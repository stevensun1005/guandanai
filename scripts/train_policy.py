"""Fit a frozen-backbone residual value policy from complete Monte Carlo returns."""

import os

os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys
import time

import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto
import torch
from torch import nn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ai.reference.numpy_engine import PolicyNetwork  # noqa: E402
from policy_features import POLICY_EXTRA_FEATURES  # noqa: E402
from policy_dataset import validate_dataset, validate_seed_ranges  # noqa: E402


def export_policy(path, weights, alpha, base_scale):
    model = onnx.load(ROOT / "ai/policy.onnx")
    for node in model.graph.node:
        for index, name in enumerate(node.output):
            if name == "values":
                node.output[index] = "base_values"
    model.graph.input.append(
        helper.make_tensor_value_info("extras", TensorProto.FLOAT, ["batch", POLICY_EXTRA_FEATURES])
    )
    nodes = [helper.make_node("Concat", ["hidden4", "extras"], ["residual_input"], axis=1)]
    previous = "residual_input"
    for index, (weight, bias) in enumerate(zip(weights[::2], weights[1::2])):
        wname, bname = f"residual_w{index}", f"residual_b{index}"
        model.graph.initializer.extend(
            [
                numpy_helper.from_array(weight.T.copy(), wname),
                numpy_helper.from_array(bias.copy(), bname),
            ]
        )
        linear = f"residual_linear{index}"
        nodes.append(helper.make_node("Gemm", [previous, wname, bname], [linear]))
        if index < len(weights) // 2 - 1:
            previous = f"residual_hidden{index}"
            nodes.append(helper.make_node("Tanh", [linear], [previous]))
        else:
            previous = linear
    model.graph.initializer.extend(
        [
            numpy_helper.from_array(
                np.array([alpha / base_scale], dtype=np.float32), "residual_alpha"
            ),
            numpy_helper.from_array(np.array([18], dtype=np.int64), "unsettled_index"),
        ]
    )
    nodes.extend(
        [
            helper.make_node("Mul", [previous, "residual_alpha"], ["residual_scaled"]),
            helper.make_node("Gather", ["extras", "unsettled_index"], ["unsettled"], axis=1),
            helper.make_node("Mul", ["residual_scaled", "unsettled"], ["residual_active"]),
            helper.make_node("Add", ["base_values", "residual_active"], ["values"]),
        ]
    )
    model.graph.node.extend(nodes)
    model.graph.name = "GuanDanLearnedStrategy"
    onnx.checker.check_model(model)
    onnx.save(model, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("datasets", nargs="+")
    parser.add_argument("--output", required=True)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch", type=int, default=1024)
    parser.add_argument("--learning-rate", type=float, default=0.0003)
    parser.add_argument("--regularization", type=float, default=0.05)
    parser.add_argument("--base-scale", type=float, default=0.4)
    parser.add_argument("--grade-weight", type=float, default=0.1)
    parser.add_argument("--opponents", choices=["all", "rule"], default="all")
    parser.add_argument("--seed", type=int, default=765013)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    torch.set_num_threads(4)
    torch.manual_seed(args.seed)
    width = 512 + POLICY_EXTRA_FEATURES
    source, parts, split, eligible_parts = [], [], [], []
    for directory in args.datasets:
        path = Path(directory)
        rows, metadata = validate_dataset(path)
        source.append(
            {
                "path": str(path),
                "metadata": metadata,
                "dataSHA256": hashlib.sha256((path / "transitions.f32").read_bytes()).hexdigest(),
            }
        )
        parts.append(rows)
        split.append(np.isin(rows[:, width + 1].astype(np.int64) % 40, [0, 11, 22, 33]))
        mode = metadata["config"]["options"]["opponent"]
        eligible_parts.append(
            np.ones(len(rows), dtype=bool)
            if args.opponents == "all" or mode == "rule"
            else rows[:, width + 1].astype(np.int64) % 4 >= 2
            if mode == "mixed"
            else np.zeros(len(rows), dtype=bool)
        )
    validate_seed_ranges([entry["metadata"] for entry in source])
    data = np.concatenate(parts)
    validation = np.concatenate(split)
    x = torch.from_numpy(data[:, :width])
    y = torch.from_numpy(data[:, width : width + 1])
    if args.grade_weight != 0.1:
        y = y.sign() * (1 + args.grade_weight * ((y.abs() - 1) / 0.1).round())
    backbone = PolicyNetwork()
    w, b = backbone.layers[-1]
    base = torch.from_numpy((data[:, :512] @ w + b) * args.base_scale)
    unsettled = (data[:, 512 + 18] == 1) & np.concatenate(eligible_parts)
    train = np.flatnonzero(~validation & unsettled)
    valid = np.flatnonzero(validation & unsettled)
    if not len(train) or not len(valid):
        raise ValueError("Need separate whole training and validation games")
    head = nn.Sequential(nn.Linear(width, 128), nn.Tanh(), nn.Linear(128, 1))
    nn.init.zeros_(head[-1].weight)
    nn.init.zeros_(head[-1].bias)
    optimizer = torch.optim.AdamW(head.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    random = np.random.default_rng(args.seed)
    best, best_loss, best_epoch = None, float("inf"), 0
    history = []
    with torch.no_grad():
        initial_loss = float(((base[valid] - y[valid]) ** 2).mean())
    for epoch in range(args.epochs):
        head.train()
        shuffled = random.permutation(train)
        for start in range(0, len(shuffled), args.batch):
            indices = shuffled[start : start + args.batch]
            residual = head(x[indices])
            loss = ((base[indices] + residual - y[indices]) ** 2).mean() + args.regularization * (
                residual**2
            ).mean()
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(head.parameters(), 5)
            optimizer.step()
        head.eval()
        with torch.no_grad():
            predicted = torch.cat(
                [
                    base[valid[s : s + 8192]] + head(x[valid[s : s + 8192]])
                    for s in range(0, len(valid), 8192)
                ]
            )
            error = float(((predicted - y[valid]) ** 2).mean())
        history.append({"epoch": epoch + 1, "validationMSE": error})
        print(json.dumps(history[-1]), flush=True)
        if error < best_loss:
            best_loss, best_epoch, best = error, epoch + 1, copy.deepcopy(head.state_dict())
        if epoch + 1 - best_epoch >= 5:
            break
    head.load_state_dict(best)
    weights = [parameter.detach().numpy().copy() for parameter in head.parameters()]
    np.savez(output / "residual.npz", **{f"p{i}": value for i, value in enumerate(weights)})
    models = []
    for alpha in (0.25, 0.5, 1):
        path = output / f"policy-{alpha:g}.onnx"
        export_policy(path, weights, alpha, args.base_scale)
        models.append(
            {
                "file": path.name,
                "alpha": alpha,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    report = {
        "algorithm": "Monte Carlo team-return residual value regression; frozen backbone",
        "args": vars(args),
        "datasets": source,
        "rows": len(data),
        "trainingRows": len(train),
        "validationRows": len(valid),
        "split": "Within each independent shard: episode % 40 in [0,11,22,33] validation; others training. Both rule-team seats and self-play represented.",
        "unsettledOnly": True,
        "outputScale": "Original policy + alpha / baseScale * residual, gated off after first-out",
        "trainableParameters": sum(parameter.numel() for parameter in head.parameters()),
        "baseValidationMSE": initial_loss,
        "bestValidationMSE": best_loss,
        "bestEpoch": best_epoch,
        "history": history,
        "models": models,
        "elapsedSeconds": time.monotonic() - started,
        "note": "Value prediction loss is not a win-rate result. Choose alpha using separate validation deals before final held-out evaluation.",
    }
    (output / "training.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {key: value for key, value in report.items() if key not in ("datasets", "history")}
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
