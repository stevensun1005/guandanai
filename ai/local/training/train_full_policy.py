"""Progressively unfreeze the complete value network on whole-match returns."""

import os

os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import argparse
import copy
import json
from pathlib import Path
import time

import numpy as np
import torch
from torch import nn

from full_model import (
    ROOT,
    WIDTH,
    load_parameters,
    save_parameters,
    export_model,
    sha,
)


class CompleteNetwork(nn.Module):
    def __init__(self, weights):
        super().__init__()
        self.first = nn.Linear(567, 512)
        self.extras = nn.Linear(61, 512, bias=False)
        self.hidden = nn.ModuleList([nn.Linear(512, 512) for _ in range(4)])
        self.value = nn.Linear(512, 1)
        with torch.no_grad():
            self.first.weight.copy_(torch.from_numpy(weights["w0"][:567].T.copy()))
            self.first.bias.copy_(torch.from_numpy(weights["b0"]))
            self.extras.weight.copy_(torch.from_numpy(weights["w0"][567:].T.copy()))
            for i, layer in enumerate([*self.hidden, self.value], 1):
                layer.weight.copy_(torch.from_numpy(weights[f"w{i}"].T.copy()))
                layer.bias.copy_(torch.from_numpy(weights[f"b{i}"]))

    def forward(self, x):
        x = torch.tanh(self.first(x[..., :567]) + self.extras(x[..., 567:]))
        for layer in self.hidden:
            x = torch.tanh(layer(x))
        return self.value(x)

    def unfreeze(self, stage):
        for p in self.parameters():
            p.requires_grad_(True)
        if stage != "full":
            for p in self.first.parameters():
                p.requires_grad_(False)
            for i, layer in enumerate(self.hidden):
                if i < (3 if stage == "tail" else 1):
                    for p in layer.parameters():
                        p.requires_grad_(False)

    def export(self):
        result = {
            "w0": np.concatenate(
                [self.first.weight.detach().numpy().T, self.extras.weight.detach().numpy().T]
            ).copy(),
            "b0": self.first.bias.detach().numpy().copy(),
        }
        for i, layer in enumerate([*self.hidden, self.value], 1):
            result[f"w{i}"] = layer.weight.detach().numpy().T.copy()
            result[f"b{i}"] = layer.bias.detach().numpy().copy()
        return result


def load_data(directories):
    parts, validation, sources, ranges = [], [], [], []
    for directory in directories:
        path = Path(directory)
        m = json.loads((path / "metadata.json").read_text(encoding="utf-8"))
        outer = json.loads((path / "rollout.json").read_text(encoding="utf-8"))
        count = m["collection"]["options"]["games"]
        seed = m["collection"]["seed"]
        if (
            m["kind"] != "complete-match-raw"
            or m["status"] != "complete"
            or outer["status"] != "complete"
            or m["games"] != count
            or outer["completedGames"] != count
        ):
            raise ValueError("Incomplete full-network match data")
        if (
            m["features"] != WIDTH
            or m["rowFloats"] != WIDTH + 3
            or (path / "raw.f32").stat().st_size != m["rows"] * (WIDTH + 3) * 4
        ):
            raise ValueError("Invalid raw dimensions or length")
        for source, expected in m["sourceSHA256"].items():
            if sha(ROOT / source) != expected:
                raise ValueError(f"Encoding or rules changed: {source}")
        if sha(m["model"]) != m["modelSHA256"]:
            raise ValueError("Behavior model changed")
        if any(seed < end and start < seed + count for start, end in ranges):
            raise ValueError("Overlapping training matches")
        ranges.append((seed, seed + count))
        rows = np.memmap(path / "raw.f32", dtype="<f4", mode="r").reshape(-1, WIDTH + 3)
        if (
            not len(rows)
            or not np.isfinite(rows).all()
            or not np.isin(rows[:, WIDTH], [-1, 0, 1]).all()
        ):
            raise ValueError("Invalid whole-match learning targets")
        ids = rows[:, WIDTH + 1]
        if (
            not np.equal(ids, ids.astype(int)).all()
            or np.any((ids < 0) | (ids >= count))
            or not np.isin(rows[:, WIDTH + 2], [0, 1, 2, 3]).all()
        ):
            raise ValueError("Invalid episode or seat IDs")
        parts.append(rows)
        validation.append((ids.astype(np.int64) + seed) % 10 == 0)
        sources.append({"path": str(path), "metadata": m, "rawSHA256": sha(path / "raw.f32")})
    data = np.concatenate(parts)
    valid = np.concatenate(validation)
    if not valid.any() or valid.all():
        raise ValueError("Need independent complete matches for validation")
    return data, valid, sources


def train(args):
    if (
        args.epochs < 1
        or args.batch < 1
        or args.threads < 1
        or not np.isfinite(args.anchor_weight)
        or args.anchor_weight < 0
        or not all(np.isfinite(v) and v > 0 for v in [args.learning_rate, args.extra_learning_rate])
    ):
        raise ValueError("Invalid full-network optimization settings")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    weights, metadata = load_parameters(args.checkpoint)
    model = CompleteNetwork(weights)
    model.unfreeze(args.stage)
    data, validation, sources = load_data(args.datasets)
    x = torch.from_numpy(data[:, :WIDTH])
    y = torch.from_numpy(data[:, WIDTH : WIDTH + 1])
    reference_weights, _ = load_parameters(args.anchor or args.checkpoint)
    reference_model = CompleteNetwork(reference_weights).eval()
    with torch.no_grad():
        reference_values = torch.cat(
            [reference_model(x[s : s + 2048]) for s in range(0, len(x), 2048)]
        )
    training = np.flatnonzero(~validation)
    valid = np.flatnonzero(validation)
    optimizer = torch.optim.AdamW(
        [
            {
                "params": [
                    p
                    for n, p in model.named_parameters()
                    if p.requires_grad and not n.startswith("extras.")
                ],
                "lr": args.learning_rate,
            },
            {"params": model.extras.parameters(), "lr": args.extra_learning_rate},
        ],
        weight_decay=1e-5,
    )
    random = np.random.default_rng(args.seed)

    def metric():
        model.eval()
        with torch.no_grad():
            errors = [
                ((model(x[valid[s : s + 2048]]) - y[valid[s : s + 2048]]) ** 2).sum().item()
                for s in range(0, len(valid), 2048)
            ]
        return sum(errors) / len(valid)

    baseline = metric()
    best_loss = baseline
    best = copy.deepcopy(model.state_dict())
    best_epoch = 0
    history = []
    for epoch in range(args.epochs):
        model.train()
        order = random.permutation(training)
        for start in range(0, len(order), args.batch):
            indices = order[start : start + args.batch]
            predictions = model(x[indices])
            loss = ((predictions - y[indices]) ** 2).mean() + args.anchor_weight * (
                (predictions - reference_values[indices]) ** 2
            ).mean()
            if not torch.isfinite(loss):
                raise ValueError("Nonfinite complete-network loss")
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1)
            optimizer.step()
        error = metric()
        history.append({"epoch": epoch + 1, "validationMSE": error})
        print(json.dumps(history[-1]), flush=True)
        if error < best_loss:
            best_loss = error
            best_epoch = epoch + 1
            best = copy.deepcopy(model.state_dict())
    last = model.export()
    save_parameters(
        output / "last-optimization.npz",
        last,
        parentSHA256=sha(args.checkpoint),
        stage=args.stage,
        selection="Last optimizer state; not selected for deployment",
    )
    optimization_updates = {
        key: int(np.count_nonzero(last[key] != weights[key])) for key in weights
    }
    model.load_state_dict(best)
    updated = model.export()
    save_parameters(
        output / "full.npz", updated, parentSHA256=sha(args.checkpoint), stage=args.stage
    )
    export_model(output / "policy.onnx", updated)
    report = {
        "algorithm": "Complete-network Monte Carlo value regression on terminal match team returns",
        "stage": args.stage,
        "parameters": sum(p.numel() for p in model.parameters()),
        "trainableParameters": sum(p.numel() for p in model.parameters() if p.requires_grad),
        "trainingRows": len(training),
        "validationRows": len(valid),
        "beforeValidationMSE": baseline,
        "bestValidationMSE": best_loss,
        "bestEpoch": best_epoch,
        "history": history,
        "datasets": sources,
        "parameterUpdates": {
            key: {
                "changed": int(np.count_nonzero(updated[key] != weights[key])),
                "maxAbsoluteChange": float(np.max(np.abs(updated[key] - weights[key]))),
            }
            for key in weights
        },
        "lastOptimizationChanges": optimization_updates,
        "anchorCheckpointSHA256": sha(args.anchor or args.checkpoint),
        "anchorWeight": args.anchor_weight,
        "firstBaseWeightChanges": int(np.count_nonzero(updated["w0"][:567] != weights["w0"][:567])),
        "newContextWeightChanges": int(
            np.count_nonzero(updated["w0"][567:] != weights["w0"][567:])
        ),
        "modelSHA256": sha(output / "policy.onnx"),
        "checkpointSHA256": sha(output / "full.npz"),
        "args": vars(args),
        "elapsedSeconds": time.monotonic() - started,
        "note": "Prediction improvement is not evidence of improved match win rate. Publish only after independent game and browser validation.",
    }
    (output / "training.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        json.dumps({k: v for k, v in report.items() if k not in ("datasets", "history")}),
        flush=True,
    )
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("datasets", nargs="+")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--anchor")
    parser.add_argument("--anchor-weight", type=float, default=50)
    parser.add_argument("--output", required=True)
    parser.add_argument("--stage", choices=["tail", "middle", "full"], default="tail")
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--learning-rate", type=float, default=1e-6)
    parser.add_argument("--extra-learning-rate", type=float, default=1e-6)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--seed", type=int, default=76001)
    train(parser.parse_args())
