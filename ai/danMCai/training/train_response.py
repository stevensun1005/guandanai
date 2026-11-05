"""Train a small response classifier on self-play, splitting by whole games."""

import os

os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
import json, sys, time, hashlib
from pathlib import Path
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto
import onnxruntime as ort

dataset = Path(sys.argv[1] if len(sys.argv) > 1 else "ai/danMCai/data/generated/response-dataset-v1")
output = Path(sys.argv[2] if len(sys.argv) > 2 else "ai/danMCai/data/generated/response-model-v1")
output.mkdir(parents=True, exist_ok=True)
metadata = json.loads((dataset / "metadata.json").read_text())
width = metadata["features"]
data = np.memmap(dataset / "responses.f32", dtype="<f4", mode="r").reshape(-1, width + 2)
if len(data) != metadata["rows"] or not np.isfinite(data).all():
    raise ValueError("Invalid dataset")
features = np.array(data[:, :width], dtype=np.float32)
labels = np.array(data[:, width : width + 1], dtype=np.float32)
games = np.array(data[:, width + 1], dtype=np.int32)
splits = {
    "train": np.flatnonzero(games % 10 >= 2),
    "validation": np.flatnonzero(games % 10 == 1),
    "test": np.flatnonzero(games % 10 == 0),
}
if any(len(indices) == 0 for indices in splits.values()):
    raise ValueError("Each game split needs data")


def predict(weights, x):
    activations = [x]
    for index, (w, b) in enumerate(zip(weights[::2], weights[1::2])):
        z = activations[-1] @ w + b
        activations.append(
            1 / (1 + np.exp(-np.clip(z, -20, 20))) if index == len(weights) // 2 - 1 else np.tanh(z)
        )
    return activations


def probabilities(weights, indices):
    return np.concatenate(
        [
            predict(weights, features[indices[first : first + 8192]])[-1][:, 0]
            for first in range(0, len(indices), 8192)
        ]
    )


def metrics(probability, target):
    probability = np.clip(probability, 1e-6, 1 - 1e-6)
    target = target.reshape(-1)
    order = np.argsort(probability, kind="stable")
    ordered = probability[order]
    starts = np.r_[0, np.flatnonzero(np.diff(ordered)) + 1]
    ends = np.r_[starts[1:], len(order)]
    ranks = np.repeat((starts + 1 + ends) / 2, ends - starts)
    positive = int(target.sum())
    negative = len(target) - positive
    auc = (
        float(
            (ranks[target[order] == 1].sum() - positive * (positive + 1) / 2)
            / (positive * negative)
        )
        if positive and negative
        else None
    )
    calibration = []
    for low in np.arange(0, 1, 0.1):
        chosen = (probability >= low) & (probability < low + 0.1)
        if chosen.any():
            calibration.append(
                {
                    "count": int(chosen.sum()),
                    "predicted": float(probability[chosen].mean()),
                    "observed": float(target[chosen].mean()),
                }
            )
    return {
        "rows": len(target),
        "positiveRate": float(target.mean()),
        "brier": float(np.mean((probability - target) ** 2)),
        "logLoss": float(
            -np.mean(target * np.log(probability) + (1 - target) * np.log(1 - probability))
        ),
        "auc": auc,
        "accuracy": float(np.mean((probability >= 0.5) == target)),
        "calibration": calibration,
    }


def train(name, dims, max_epochs=60):
    random = np.random.default_rng(74291)
    weights = []
    for inputs, outputs in zip(dims, dims[1:]):
        weights.extend(
            [
                (random.standard_normal((inputs, outputs)) / np.sqrt(inputs)).astype(np.float32),
                np.zeros(outputs, dtype=np.float32),
            ]
        )
    momentum = [np.zeros_like(value) for value in weights]
    velocity = [np.zeros_like(value) for value in weights]
    best = None
    best_loss = float("inf")
    best_epoch = 0
    step = 0
    history = []
    started = time.perf_counter()
    for epoch in range(max_epochs):
        indices = random.permutation(splits["train"])
        for first in range(0, len(indices), 1024):
            batch = indices[first : first + 1024]
            x = features[batch]
            target = labels[batch]
            activations = predict(weights, x)
            delta = (activations[-1] - target) / len(batch)
            gradients = [None] * len(weights)
            for layer in reversed(range(len(weights) // 2)):
                gradients[2 * layer] = activations[layer].T @ delta + 1e-5 * weights[2 * layer]
                gradients[2 * layer + 1] = delta.sum(axis=0)
                if layer:
                    delta = (delta @ weights[2 * layer].T) * (1 - activations[layer] ** 2)
            step += 1
            rate = 0.002 * 0.98**epoch
            for index, gradient in enumerate(gradients):
                momentum[index] *= 0.9
                momentum[index] += 0.1 * gradient
                velocity[index] *= 0.999
                velocity[index] += 0.001 * gradient**2
                weights[index] -= (
                    rate
                    * (momentum[index] / (1 - 0.9**step))
                    / (np.sqrt(velocity[index] / (1 - 0.999**step)) + 1e-7)
                )
        validation = metrics(
            probabilities(weights, splits["validation"]), labels[splits["validation"]]
        )
        history.append(
            {
                "epoch": epoch + 1,
                "validationLogLoss": validation["logLoss"],
                "validationBrier": validation["brier"],
            }
        )
        print(
            name,
            "epoch",
            epoch + 1,
            "validation",
            round(validation["logLoss"], 5),
            "brier",
            round(validation["brier"], 5),
            flush=True,
        )
        if validation["logLoss"] < best_loss - 1e-5:
            best_loss = validation["logLoss"]
            best = [value.copy() for value in weights]
            best_epoch = epoch + 1
        elif epoch + 1 - best_epoch >= 8:
            break
    report = {
        "architecture": dims,
        "bestEpoch": best_epoch,
        "elapsedSeconds": time.perf_counter() - started,
        "history": history,
        "splits": {
            key: metrics(probabilities(best, indices), labels[indices])
            for key, indices in splits.items()
        },
    }
    np.savez(output / f"{name}.npz", **{f"p{index}": value for index, value in enumerate(best)})
    nodes = []
    initializers = []
    previous = "features"
    for layer, (w, b) in enumerate(zip(best[::2], best[1::2])):
        initializers.extend(
            [numpy_helper.from_array(w, f"w{layer}"), numpy_helper.from_array(b, f"b{layer}")]
        )
        linear = f"z{layer}"
        result = "probability" if layer == len(best) // 2 - 1 else f"h{layer}"
        nodes.append(helper.make_node("Gemm", [previous, f"w{layer}", f"b{layer}"], [linear]))
        nodes.append(
            helper.make_node("Sigmoid" if result == "probability" else "Tanh", [linear], [result])
        )
        previous = result
    graph = helper.make_graph(
        nodes,
        "GuandanResponse",
        [helper.make_tensor_value_info("features", TensorProto.FLOAT, ["batch", width])],
        [helper.make_tensor_value_info("probability", TensorProto.FLOAT, ["batch", 1])],
        initializers,
    )
    model = helper.make_model(
        graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="GuandanAI"
    )
    model.ir_version = 8
    helper.set_model_props(
        model,
        {
            "featureVersion": "1",
            "features": str(width),
            "target": "next opponent follows a played action",
        },
    )
    onnx.checker.check_model(model)
    onnx.save(model, output / f"{name}.onnx")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    engine = ort.InferenceSession(
        str(output / f"{name}.onnx"), sess_options=options, providers=["CPUExecutionProvider"]
    )
    sample = features[splits["test"][:128]]
    parity = float(
        np.max(np.abs(engine.run(None, {"features": sample})[0] - predict(best, sample)[-1]))
    )
    if parity > 1e-5:
        raise ValueError(f"Export parity {parity}")
    report["exportMaxError"] = parity
    report["modelSHA256"] = hashlib.sha256((output / f"{name}.onnx").read_bytes()).hexdigest()
    (output / f"{name}.json").write_text(json.dumps(report, indent=2))
    return report


reports = {
    name: train(name, dims)
    for name, dims in [("response-linear", [width, 1]), ("response-small", [width, 64, 32, 1])]
}
prevalence = float(labels[splits["train"]].mean())
baseline = metrics(np.full(len(splits["test"]), prevalence), labels[splits["test"]])
summary = {
    "dataset": metadata,
    "seed": 74291,
    "splitGames": {key: len(np.unique(games[indices])) for key, indices in splits.items()},
    "constantBaselineTest": baseline,
    "models": reports,
}
(output / "training-report.json").write_text(json.dumps(summary, indent=2))
print(
    json.dumps(
        {
            "baseline": baseline,
            "models": {
                name: {
                    "bestEpoch": report["bestEpoch"],
                    "validation": report["splits"]["validation"],
                    "test": report["splits"]["test"],
                }
                for name, report in reports.items()
            },
        }
    ),
    flush=True,
)
