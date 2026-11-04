"""Learn relative action values from paired branch returns, including all ties."""

import os

os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import argparse
import copy
import json
from pathlib import Path
import time

import numpy as np
import onnx
from onnx import helper, TensorProto
import onnxruntime as ort
import torch
from torch import nn

from policy_dataset import ROOT, _sha, _backbone, _verify_checkpoint
from policy_features import POLICY_EXTRA_FEATURES
from ai.reference.numpy_engine import PolicyNetwork
from train_policy import export_policy

FEATURES = 512 + POLICY_EXTRA_FEATURES
K = 4


class CounterfactualData:
    def __init__(self, directories):
        self.parts = []
        try:
            self._load(directories)
        except Exception:
            self.close()
            raise

    def _load(self, directories):
        self.parts, self.sources = [], []
        targets, masks, seeds, bases = [], [], [], []
        self.rows = 0
        known_seeds = set()
        known_paths = set()
        base_path = ROOT / "ai/policy.onnx"
        base_graph = onnx.load(base_path)
        _verify_checkpoint(base_graph)
        self.base_weight, self.base_bias = PolicyNetwork().layers[-1]
        for directory in directories:
            path = Path(directory).resolve()
            if path in known_paths:
                raise ValueError("Duplicate counterfactual dataset")
            known_paths.add(path)
            metadata = json.loads((path / "metadata.json").read_text(encoding="utf-8"))
            rollout = json.loads((path / "rollout.json").read_text(encoding="utf-8"))
            rows = metadata.get("rows")
            if (
                metadata.get("version") != 1
                or metadata.get("status") != "complete"
                or type(rows) is not int
                or rows < 1
                or metadata.get("k") != K
                or metadata.get("features") != FEATURES
            ):
                raise ValueError("Incomplete or invalid counterfactual dataset dimensions")
            if (
                rollout.get("status") != "complete"
                or rollout.get("pivots", rollout.get("rows")) != rows
            ):
                raise ValueError("Counterfactual rollout is incomplete")
            config = metadata.get("config", {})
            games, first_seed = config.get("games"), config.get("seed")
            if (
                type(games) is not int
                or games < 1
                or type(first_seed) is not int
                or rollout.get("completedGames") != games
                or rollout.get("games") != games
                or rollout.get("seed") != first_seed
                or metadata.get("seedRange") != [first_seed, first_seed + games - 1]
            ):
                raise ValueError("Incomplete counterfactual deal count")
            checks = (
                (base_path, metadata.get("basePolicySHA256")),
                (ROOT / "scripts/policy_features.py", metadata.get("extraFeaturesSHA256")),
                (ROOT / "ai/reference/numpy_engine.py", metadata.get("referenceEncoderSHA256")),
            )
            for source, expected in checks:
                if _sha(source) != expected:
                    raise ValueError("Counterfactual base or feature hash changed")
            proposal = Path(metadata["model"])
            proposal = proposal if proposal.is_absolute() else ROOT / proposal
            if _sha(proposal) != metadata.get("modelSHA256") or rollout.get(
                "modelSHA256"
            ) != metadata.get("modelSHA256"):
                raise ValueError("Counterfactual proposal hash changed")
            if _backbone(onnx.load(proposal).graph) != _backbone(base_graph.graph):
                raise ValueError("Counterfactual proposal uses a different backbone")
            sources = metadata.get("sourceSHA256")
            if not isinstance(sources, dict) or not sources:
                raise ValueError("Missing counterfactual source fingerprints")
            if rollout.get("sourceSHA256") != sources or config.get("sourceSHA256") != sources:
                raise ValueError("Counterfactual source manifests disagree")
            for relative, expected in sources.items():
                source = (ROOT / relative).resolve()
                if not source.is_relative_to(ROOT) or _sha(source) != expected:
                    raise ValueError("Counterfactual source hash changed")
            layout = {
                "features.f32": ("<f4", (rows, K, FEATURES)),
                "targets.f32": ("<f4", (rows, K)),
                "mask.f32": ("<f4", (rows, K)),
                "proposal-values.f32": ("<f4", (rows, K)),
                "seeds.i64": ("<i8", (rows,)),
            }
            for filename, (dtype, shape) in layout.items():
                if (path / filename).stat().st_size != int(np.prod(shape)) * np.dtype(
                    dtype
                ).itemsize:
                    raise ValueError(f"Counterfactual byte count mismatch: {filename}")
            if _sha(path / "seeds.i64") != metadata.get("seedSHA256"):
                raise ValueError("Counterfactual seed fingerprint mismatch")
            deal_seeds = np.fromfile(path / "seeds.i64", dtype="<i8")
            seed_range = metadata.get("seedRange")
            if (
                not isinstance(seed_range, list)
                or len(seed_range) != 2
                or any(type(value) is not int for value in seed_range)
                or seed_range[0] < 0
                or seed_range[1] >= 2**32
                or seed_range[0] > seed_range[1]
                or rollout.get("seedRange") != seed_range
                or np.any((deal_seeds < seed_range[0]) | (deal_seeds > seed_range[1]))
            ):
                raise ValueError("Invalid counterfactual deal seeds")
            unique_seeds = set(deal_seeds.tolist())
            if known_seeds.intersection(unique_seeds):
                raise ValueError("Counterfactual datasets share deal seeds")
            known_seeds.update(unique_seeds)
            target = np.fromfile(path / "targets.f32", dtype="<f4").reshape(rows, K)
            mask = np.fromfile(path / "mask.f32", dtype="<f4").reshape(rows, K)
            proposal_values = np.fromfile(path / "proposal-values.f32", dtype="<f4").reshape(
                rows, K
            )
            if (
                not np.isin(mask, [0, 1]).all()
                or np.any(mask.sum(axis=1) < 2)
                or not np.isfinite(proposal_values).all()
                or not np.isin(target[mask == 1], [-1, 1]).all()
                or np.any(target[mask == 0] != 0)
            ):
                raise ValueError("Invalid counterfactual masks or continuous branch returns")
            features = np.memmap(
                path / "features.f32", dtype="<f4", mode="r", shape=(rows, K, FEATURES)
            )
            base = np.empty((rows, K), np.float32)
            for first in range(0, rows, 4096):
                last = min(rows, first + 4096)
                chunk = features[first:last]
                valid = mask[first:last].astype(bool)
                if (
                    not np.isfinite(chunk).all()
                    or np.any(np.abs(chunk[:, :, :512]) > 1.000001)
                    or np.any(chunk[:, :, 512 + 18][valid] != 1)
                ):
                    features._mmap.close()
                    raise ValueError("Invalid public frozen features or already-settled pivot")
                base[first:last] = (chunk[:, :, :512] @ self.base_weight + self.base_bias).squeeze(
                    -1
                )
            self.parts.append((self.rows, self.rows + rows, features))
            self.rows += rows
            targets.append(target)
            masks.append(mask.astype(bool))
            seeds.append(deal_seeds)
            bases.append(base)
            self.sources.append(
                {
                    "path": str(path),
                    "metadata": metadata,
                    "dataSHA256": {name: _sha(path / name) for name in layout},
                }
            )
        if not self.parts:
            raise ValueError("No counterfactual data")
        self.targets = np.concatenate(targets)
        self.masks = np.concatenate(masks)
        self.seeds = np.concatenate(seeds)
        self.base = np.concatenate(bases)
        self.validation = np.isin(self.seeds % 20, [0, 11])
        self.train_indices = np.flatnonzero(~self.validation)
        self.validation_indices = np.flatnonzero(self.validation)
        if not len(self.train_indices) or not len(self.validation_indices):
            self.close()
            raise ValueError("Need independent whole-deal training and validation sets")

    def get_features(self, indices):
        result = np.empty((len(indices), K, FEATURES), np.float32)
        for first, last, features in self.parts:
            selected = (indices >= first) & (indices < last)
            result[selected] = features[indices[selected] - first]
        return torch.from_numpy(result)

    def close(self):
        for _, _, features in self.parts:
            features._mmap.close()


def center(values, mask):
    return values - (values * mask).sum(dim=1, keepdim=True) / mask.sum(dim=1, keepdim=True)


def centered_loss(predictions, targets, mask, residual, regularization=0.05):
    """Keep every valid action and return tie; learn differences, not hindsight winners."""
    count = mask.sum(dim=1)
    errors = center(predictions, mask) - center(targets, mask)
    fit = ((errors.square() * mask).sum(dim=1) / count).mean()
    penalty = ((residual.square() * mask).sum(dim=1) / count).mean()
    return fit + regularization * penalty


def prediction_metrics(predictions, targets, mask):
    count = mask.sum(axis=1, keepdims=True)
    predicted_center = predictions - (predictions * mask).sum(axis=1, keepdims=True) / count
    target_center = targets - (targets * mask).sum(axis=1, keepdims=True) / count
    centered_mse = (
        ((predicted_center - target_center) ** 2 * mask).sum(axis=1) / count[:, 0]
    ).mean()
    error_sum = pairs = informative = correct = 0
    tie_abs = tie_pairs = 0
    for first in range(K):
        for second in range(first + 1, K):
            valid = mask[:, first] & mask[:, second]
            truth = (targets[:, first] - targets[:, second])[valid]
            predicted = (predictions[:, first] - predictions[:, second])[valid]
            error_sum += float(((predicted - truth) ** 2).sum())
            pairs += len(truth)
            unequal = truth != 0
            informative += int(unequal.sum())
            correct += int(((predicted[unequal] * truth[unequal]) > 0).sum())
            tie_pairs += int((~unequal).sum())
            tie_abs += float(np.abs(predicted[~unequal]).sum())
    pivot_min = np.where(mask, targets, np.inf).min(axis=1)
    pivot_max = np.where(mask, targets, -np.inf).max(axis=1)
    return {
        "centeredReturnMSE": float(centered_mse),
        "pairedDifferenceMSE": error_sum / max(1, pairs),
        "pivots": len(targets),
        "informativePivots": int((pivot_max != pivot_min).sum()),
        "pairsIncludingTies": pairs,
        "informativePairs": informative,
        "preferenceAccuracyOnUnequalPairs": correct / informative if informative else None,
        "tiedPairs": tie_pairs,
        "meanAbsolutePredictedDifferenceOnTies": tie_abs / tie_pairs if tie_pairs else None,
    }


def verify_export(path, features, head, base_weight, base_bias, alpha, base_scale):
    """Check the merged ONNX head on known embeddings, including the post-first-out gate."""
    model = onnx.load(path)
    producers = {name: node for node in model.graph.node for name in node.output}
    initializers = {tensor.name: tensor for tensor in model.graph.initializer}
    required_nodes, required_tensors = set(), set()

    def visit(name):
        if name in ("hidden4", "extras"):
            return
        if name in initializers:
            required_tensors.add(name)
            return
        node = producers[name]
        key = tuple(node.output)
        if key in required_nodes:
            return
        required_nodes.add(key)
        for dependency in node.input:
            visit(dependency)

    visit("values")
    graph = helper.make_graph(
        [node for node in model.graph.node if tuple(node.output) in required_nodes],
        "CounterfactualExportCheck",
        [
            helper.make_tensor_value_info("hidden4", TensorProto.FLOAT, ["batch", 512]),
            helper.make_tensor_value_info(
                "extras", TensorProto.FLOAT, ["batch", POLICY_EXTRA_FEATURES]
            ),
        ],
        [helper.make_tensor_value_info("values", TensorProto.FLOAT, ["batch", 1])],
        [tensor for name, tensor in initializers.items() if name in required_tensors],
    )
    check_model = helper.make_model(
        graph, opset_imports=list(model.opset_import), ir_version=model.ir_version
    )
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    engine = ort.InferenceSession(
        check_model.SerializeToString(), sess_options=options, providers=["CPUExecutionProvider"]
    )
    samples = np.concatenate((features, features.copy()))
    samples[len(features) :, 512 + 18] = 0
    with torch.no_grad():
        residual = head(torch.from_numpy(samples)).numpy()
    expected = (
        samples[:, :512] @ base_weight
        + base_bias
        + alpha / base_scale * residual * samples[:, 512 + 18 : 512 + 19]
    )
    actual = engine.run(
        ["values"], {"hidden4": samples[:, :512].copy(), "extras": samples[:, 512:].copy()}
    )[0]
    error = float(np.max(np.abs(expected - actual)))
    if error > 2e-4:
        raise ValueError(f"Counterfactual export mismatch: {error}")
    return error


def train(args):
    if (
        args.epochs < 1
        or args.batch < 1
        or args.learning_rate <= 0
        or args.regularization < 0
        or args.base_scale <= 0
    ):
        raise ValueError("Invalid counterfactual training settings")
    started = time.monotonic()
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    data = CounterfactualData(args.datasets)
    try:
        output = Path(args.output)
        output.mkdir(parents=True, exist_ok=False)
        head = (
            nn.Sequential(nn.Linear(FEATURES, 1))
            if args.linear
            else nn.Sequential(nn.Linear(FEATURES, 128), nn.Tanh(), nn.Linear(128, 1))
        )
        nn.init.zeros_(head[-1].weight)
        nn.init.zeros_(head[-1].bias)
        optimizer = torch.optim.AdamW(head.parameters(), lr=args.learning_rate, weight_decay=1e-4)
        targets = torch.from_numpy(data.targets)
        masks = torch.from_numpy(data.masks)
        base = torch.from_numpy(data.base * args.base_scale)
        valid = data.validation_indices

        def evaluate():
            chunks = []
            with torch.no_grad():
                for first in range(0, len(valid), 2048):
                    indices = valid[first : first + 2048]
                    chunks.append(
                        (base[indices] + head(data.get_features(indices)).squeeze(-1)).numpy()
                    )
            return prediction_metrics(
                np.concatenate(chunks), data.targets[valid], data.masks[valid]
            )

        before = evaluate()
        best_loss, best_epoch, best = (
            before["centeredReturnMSE"],
            0,
            copy.deepcopy(head.state_dict()),
        )
        random = np.random.default_rng(args.seed)
        history = []
        for epoch in range(args.epochs):
            head.train()
            order = random.permutation(data.train_indices)
            for first in range(0, len(order), args.batch):
                indices = order[first : first + args.batch]
                residual = head(data.get_features(indices)).squeeze(-1)
                loss = centered_loss(
                    base[indices] + residual,
                    targets[indices],
                    masks[indices],
                    residual,
                    args.regularization,
                )
                if not torch.isfinite(loss):
                    raise ValueError("Nonfinite counterfactual training loss")
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                nn.utils.clip_grad_norm_(head.parameters(), 5)
                optimizer.step()
            head.eval()
            metrics = evaluate()
            history.append({"epoch": epoch + 1, **metrics})
            print(json.dumps(history[-1]), flush=True)
            if metrics["centeredReturnMSE"] < best_loss:
                best_loss, best_epoch, best = (
                    metrics["centeredReturnMSE"],
                    epoch + 1,
                    copy.deepcopy(head.state_dict()),
                )
            if epoch + 1 - best_epoch >= 5:
                break
        head.load_state_dict(best)
        head.eval()
        after = evaluate()
        weights = [parameter.detach().numpy().copy() for parameter in head.parameters()]
        np.savez(
            output / "residual.npz", **{f"p{index}": value for index, value in enumerate(weights)}
        )
        verification = data.get_features(valid[: min(16, len(valid))]).numpy().reshape(-1, FEATURES)
        models = []
        for alpha in (0.25, 0.5, 1):
            path = output / f"policy-{alpha:g}.onnx"
            export_policy(path, weights, alpha, args.base_scale)
            error = verify_export(
                path, verification, head, data.base_weight, data.base_bias, alpha, args.base_scale
            )
            models.append(
                {
                    "file": path.name,
                    "alpha": alpha,
                    "sha256": _sha(path),
                    "exportMaxAbsoluteError": error,
                }
            )
        report = {
            "algorithm": "Centered counterfactual return-difference regression on all valid actions, including ties",
            "args": vars(args),
            "datasets": data.sources,
            "rows": data.rows,
            "trainingPivots": len(data.train_indices),
            "validationPivots": len(valid),
            "trainingDeals": len(np.unique(data.seeds[data.train_indices])),
            "validationDeals": len(np.unique(data.seeds[valid])),
            "split": "Actual deal seed % 20 in [0,11] is validation; every pivot from the same deal stays together",
            "before": before,
            "after": after,
            "bestEpoch": best_epoch,
            "history": history,
            "trainableParameters": sum(parameter.numel() for parameter in head.parameters()),
            "target": "Signed team first-out win from each simulated branch; no hindsight argmax labels",
            "outputScale": "Original base policy + alpha / baseScale * learned residual, disabled after first-out",
            "models": models,
            "elapsedSeconds": time.monotonic() - started,
            "trainerSHA256": _sha(__file__),
            "exporterSHA256": _sha(ROOT / "scripts/train_policy.py"),
            "note": "Branch-value prediction and held-out preference accuracy are not actual game win rates. Full hidden deals belong only to simulation; student inputs remain public plus own hand.",
        }
        (output / "training.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(
            json.dumps(
                {key: value for key, value in report.items() if key not in ("datasets", "history")}
            ),
            flush=True,
        )
        return report
    finally:
        data.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("datasets", nargs="+")
    parser.add_argument("--output", required=True)
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--batch", type=int, default=512)
    parser.add_argument("--learning-rate", type=float, default=0.0003)
    parser.add_argument("--regularization", type=float, default=0.05)
    parser.add_argument("--base-scale", type=float, default=0.4)
    parser.add_argument("--linear", action="store_true")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--seed", type=int, default=765013)
    train(parser.parse_args())


if __name__ == "__main__":
    main()
