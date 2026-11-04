"""Train a small on-policy actor and critic on frozen, masked proposal sets."""

import os

os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import argparse
import json
from pathlib import Path
import time

import numpy as np
import torch
from torch import nn

from ppo_learning import FEATURES, PARAMETERS, file_sha, load_actor, save_actor


class ActorCritic(nn.Module):
    def __init__(self, weights):
        super().__init__()
        self.actor = nn.Sequential(nn.Linear(FEATURES, 64), nn.Tanh(), nn.Linear(64, 1))
        self.critic = nn.Sequential(nn.Linear(FEATURES, 64), nn.Tanh(), nn.Linear(64, 1))
        with torch.no_grad():
            for branch in ("actor", "critic"):
                network = getattr(self, branch)
                for index, layer in enumerate((network[0], network[2])):
                    layer.weight.copy_(torch.from_numpy(weights[f"{branch}_w{index}"].T.copy()))
                    layer.bias.copy_(torch.from_numpy(weights[f"{branch}_b{index}"]))

    def forward(self, features, reference, mask):
        logits = reference + self.actor(features).squeeze(-1)
        logits = logits.masked_fill(~mask, -1e9)
        log_probs = torch.log_softmax(logits, dim=-1)
        pooled = (features * mask[..., None]).sum(dim=1) / mask.sum(dim=1, keepdim=True)
        value = self.critic(pooled).squeeze(-1)
        return log_probs, value

    def export(self):
        weights = {}
        for branch in ("actor", "critic"):
            network = getattr(self, branch)
            for index, layer in enumerate((network[0], network[2])):
                weights[f"{branch}_w{index}"] = layer.weight.detach().numpy().T.copy()
                weights[f"{branch}_b{index}"] = layer.bias.detach().numpy().copy()
        assert set(weights) == set(PARAMETERS)
        return weights


def ppo_loss(
    model,
    features,
    reference,
    mask,
    chosen,
    old_log_probs,
    targets,
    advantages,
    weights,
    clip=0.2,
    value_weight=0.5,
    entropy_weight=0.01,
    reference_kl_weight=0.01,
):
    log_probs, values = model(features, reference, mask)
    old_chosen = old_log_probs.gather(1, chosen[:, None]).squeeze(1)
    new_chosen = log_probs.gather(1, chosen[:, None]).squeeze(1)
    ratio = torch.exp(new_chosen - old_chosen)
    unclipped = ratio * advantages
    clipped = ratio.clamp(1 - clip, 1 + clip) * advantages
    policy = -(torch.minimum(unclipped, clipped) * weights).mean()
    value_loss = (((values - targets) ** 2) * weights).mean()
    entropy = (-(log_probs.exp() * log_probs * mask).sum(dim=1) * weights).mean()
    reference_log_probs = torch.log_softmax(reference.masked_fill(~mask, -1e9), dim=-1)
    reference_kl = (
        (log_probs.exp() * (log_probs - reference_log_probs) * mask).sum(dim=1) * weights
    ).mean()
    old_kl = (
        (old_log_probs.exp() * (old_log_probs - log_probs) * mask).sum(dim=1) * weights
    ).mean()
    loss = (
        policy
        + value_weight * value_loss
        - entropy_weight * entropy
        + reference_kl_weight * reference_kl
    )
    return loss, {
        "loss": loss.detach(),
        "policyLoss": policy.detach(),
        "valueMSE": value_loss.detach(),
        "entropy": entropy.detach(),
        "referenceKL": reference_kl.detach(),
        "oldPolicyKL": old_kl.detach(),
        "clipFraction": (((ratio - 1).abs() > clip).float() * weights).mean().detach(),
    }


class Rollouts:
    def __init__(self, directories):
        self.parts = []
        self.sources = []
        aux_parts, episode_parts = [], []
        policy_hash = None
        self.rows = 0
        seed_ranges = []
        paths = set()
        for directory in directories:
            path = Path(directory).resolve()
            if path in paths:
                raise ValueError("Duplicate PPO dataset")
            paths.add(path)
            metadata = json.loads((path / "metadata.json").read_text(encoding="utf-8"))
            if (
                metadata.get("kind") != "guandan-ppo-rollout"
                or metadata.get("status") != "complete"
            ):
                raise ValueError("Need completed PPO rollout buffers")
            weights, config, behavior = load_actor(path / "behavior.npz")
            if metadata["policySHA256"] != behavior["policySHA256"]:
                raise ValueError("PPO buffer behavior fingerprint mismatch")
            if policy_hash is not None and behavior["policySHA256"] != policy_hash:
                raise ValueError("Cannot mix trajectories from different PPO behavior policies")
            policy_hash = behavior["policySHA256"]
            if metadata["config"] != config:
                raise ValueError("PPO buffer configuration mismatch")
            for source, expected in (
                (config["proposalPath"], config["proposalSHA256"]),
                (Path(__file__).parent / "policy_features.py", config["featuresSHA256"]),
                (
                    Path(__file__).resolve().parents[1] / "ai/reference/numpy_engine.py",
                    config["referenceEncoderSHA256"],
                ),
            ):
                if file_sha(source) != expected:
                    raise ValueError("PPO proposal or feature source changed")
            collection = metadata["collection"]
            games = collection.get("options", {}).get("games")
            seed = collection.get("seed")
            if (
                not isinstance(games, int)
                or games < 1
                or metadata["games"] != games
                or not isinstance(seed, int)
                or seed < 0
            ):
                raise ValueError("Incomplete PPO episode count")
            interval = (seed, seed + games)
            if any(interval[0] < stop and start < interval[1] for start, stop in seed_ranges):
                raise ValueError("Overlapping PPO deal seed ranges")
            seed_ranges.append(interval)
            manifest_file = path / "rollout.json"
            if manifest_file.exists():
                manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
                if (
                    manifest.get("status") != "complete"
                    or manifest.get("completedGames") != games
                    or manifest.get("seed") != seed
                ):
                    raise ValueError("PPO outer rollout is not complete")
            rows, k = metadata["rows"], config["k"]
            if (
                not isinstance(rows, int)
                or rows <= 0
                or metadata["features"] != FEATURES
                or metadata["auxFloats"] != 3 * k + 5
            ):
                raise ValueError("Invalid PPO buffer dimensions")
            if (path / "features.f32").stat().st_size != rows * k * FEATURES * 4 or (
                path / "aux.f32"
            ).stat().st_size != rows * (3 * k + 5) * 4:
                raise ValueError("Truncated PPO rollout files")
            features = np.memmap(
                path / "features.f32", dtype="<f4", mode="r", shape=(rows, k, FEATURES)
            )
            for start in range(0, rows, 8192):
                if not np.isfinite(features[start : start + 8192]).all():
                    raise ValueError("Nonfinite PPO features")
            aux = np.fromfile(path / "aux.f32", dtype="<f4").reshape(rows, 3 * k + 5)
            if not np.isfinite(aux).all():
                raise ValueError("Nonfinite PPO targets")
            mask, chosen = aux[:, k : 2 * k], aux[:, 3 * k]
            if (
                not np.isin(mask, [0, 1]).all()
                or np.any(mask.sum(axis=1) == 0)
                or not np.equal(chosen, chosen.astype(int)).all()
                or np.any((chosen < 0) | (chosen >= k))
            ):
                raise ValueError("Invalid PPO candidate masks or choices")
            if not mask[np.arange(rows), chosen.astype(int)].all():
                raise ValueError("PPO chose a padded action")
            probabilities = np.exp(aux[:, 2 * k : 3 * k].astype(np.float64))
            if (
                not np.allclose(probabilities.sum(axis=1), 1, atol=2e-5)
                or (probabilities[mask == 0] > 0).any()
            ):
                raise ValueError("Invalid stored behavior distribution")
            episodes, seats, targets = aux[:, 3 * k + 3], aux[:, 3 * k + 4], aux[:, 3 * k + 2]
            if (
                not np.equal(episodes, episodes.astype(int)).all()
                or np.any((episodes < 0) | (episodes >= games))
                or not np.isin(seats, [0, 1, 2, 3]).all()
                or not np.isin(
                    np.round(np.abs(targets), 1), np.array([1.1, 1.2, 1.3], np.float32)
                ).all()
            ):
                raise ValueError("Invalid PPO episode IDs, seats or team returns")
            _, local_episode = np.unique(episodes, return_inverse=True)
            episode_parts.append(
                local_episode + sum(len(np.unique(part)) for part in episode_parts)
            )
            self.parts.append((self.rows, self.rows + rows, features))
            self.rows += rows
            aux_parts.append(aux)
            self.sources.append(
                {
                    "path": str(path),
                    "metadata": metadata,
                    "featuresSHA256": file_sha(path / "features.f32"),
                    "auxSHA256": file_sha(path / "aux.f32"),
                }
            )
            self.initial_weights, self.config = weights, config
        if not self.parts:
            raise ValueError("No PPO buffers")
        self.aux = np.concatenate(aux_parts)
        self.episodes = np.concatenate(episode_parts)
        self.policy_hash = policy_hash
        # Keep each trajectory's sum of policy gradients; dividing by its length changes the win objective.
        self.sample_weights = np.ones(self.rows, np.float32)

    def get_features(self, indices):
        batch = np.empty((len(indices), self.config["k"], FEATURES), np.float32)
        for first, last, features in self.parts:
            selected = (indices >= first) & (indices < last)
            batch[selected] = features[indices[selected] - first]
        return torch.from_numpy(batch)

    def close(self):
        for _, _, features in self.parts:
            features._mmap.close()


def train(args):
    if args.epochs < 1 or args.batch < 1 or args.learning_rate <= 0 or not 0 < args.clip < 1:
        raise ValueError("Invalid PPO training settings")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    dataset = Rollouts(args.datasets)
    k = dataset.config["k"]
    model = ActorCritic(dataset.initial_weights)
    aux = dataset.aux
    reference = torch.from_numpy(aux[:, :k].copy())
    masks = torch.from_numpy(aux[:, k : 2 * k].astype(bool))
    old_log_probs = torch.from_numpy(aux[:, 2 * k : 3 * k].copy())
    chosen = torch.from_numpy(aux[:, 3 * k].astype(np.int64))
    targets = torch.from_numpy(aux[:, 3 * k + 2].copy())
    advantages = aux[:, 3 * k + 2] - aux[:, 3 * k + 1]
    mean = np.average(advantages, weights=dataset.sample_weights)
    deviation = np.sqrt(np.average((advantages - mean) ** 2, weights=dataset.sample_weights))
    advantages = torch.from_numpy(
        ((advantages - mean) / max(float(deviation), 1e-6)).astype(np.float32)
    )
    sample_weights = torch.from_numpy(dataset.sample_weights)
    # Verify the old probabilities against the actual serialized actor before updating.
    audit_indices = np.linspace(0, dataset.rows - 1, min(256, dataset.rows), dtype=int)
    with torch.no_grad():
        actual, values = model(
            dataset.get_features(audit_indices), reference[audit_indices], masks[audit_indices]
        )
        valid_error = (
            (actual - old_log_probs[audit_indices])[masks[audit_indices]].abs().max().item()
        )
        value_error = np.max(np.abs(values.numpy() - aux[audit_indices, 3 * k + 1]))
    if valid_error > 2e-5 or value_error > 2e-5:
        raise ValueError(f"Stored behavior does not match actor: {valid_error}, {value_error}")
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    random = np.random.default_rng(args.seed)
    history, checkpoints = [], []
    for epoch in range(args.epochs):
        order = random.permutation(dataset.rows)
        totals, batches = {}, 0
        stop = False
        for first in range(0, dataset.rows, args.batch):
            indices = order[first : first + args.batch]
            loss, metrics = ppo_loss(
                model,
                dataset.get_features(indices),
                reference[indices],
                masks[indices],
                chosen[indices],
                old_log_probs[indices],
                targets[indices],
                advantages[indices],
                sample_weights[indices],
                clip=args.clip,
                value_weight=0.5,
                entropy_weight=args.entropy,
                reference_kl_weight=args.reference_kl,
            )
            if not torch.isfinite(loss):
                raise ValueError("Nonfinite PPO loss")
            if metrics["oldPolicyKL"].item() > args.max_kl:
                stop = True
                break
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 0.5)
            optimizer.step()
            batches += 1
            for name, value in metrics.items():
                totals[name] = totals.get(name, 0) + value.item()
        metrics = {name: value / max(1, batches) for name, value in totals.items()}
        metrics.update(epoch=epoch + 1, batches=batches, earlyStopKL=stop)
        history.append(metrics)
        checkpoint = output / f"ppo-epoch{epoch + 1}.npz"
        actor = save_actor(checkpoint, model.export(), dataset.config)
        checkpoints.append(
            {
                "file": checkpoint.name,
                "sha256": file_sha(checkpoint),
                "policySHA256": actor["policySHA256"],
            }
        )
        print(json.dumps(metrics), flush=True)
        if stop:
            break
    save_actor(output / "ppo.npz", model.export(), dataset.config)
    report = {
        "algorithm": "Clipped on-policy PPO on frozen proposal action sets",
        "args": vars(args),
        "behaviorPolicySHA256": dataset.policy_hash,
        "config": dataset.config,
        "rows": dataset.rows,
        "episodes": len(np.unique(dataset.episodes)),
        "trainableParameters": sum(parameter.numel() for parameter in model.parameters()),
        "advantages": "Monte Carlo team return minus serialized old critic; globally normalized; no within-episode centering or inverse-trajectory-length weighting",
        "sampling": "Candidate sets, masks, old distributions and critic values are held fixed for all update epochs",
        "behaviorAudit": {
            "maxLogProbabilityError": valid_error,
            "maxValueError": float(value_error),
        },
        "history": history,
        "checkpoints": checkpoints,
        "model": {"file": "ppo.npz", "sha256": file_sha(output / "ppo.npz")},
        "datasets": dataset.sources,
        "elapsedSeconds": time.monotonic() - started,
        "note": "Training losses do not measure playing strength. Evaluate greedy choices on separate deals against unchanged opponents.",
    }
    (output / "training.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {key: value for key, value in report.items() if key not in ("datasets", "history")}
        ),
        flush=True,
    )
    dataset.close()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("datasets", nargs="+")
    parser.add_argument("--output", required=True)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--batch", type=int, default=512)
    parser.add_argument("--learning-rate", type=float, default=0.0003)
    parser.add_argument("--clip", type=float, default=0.2)
    parser.add_argument("--entropy", type=float, default=0.01)
    parser.add_argument("--reference-kl", type=float, default=0.01)
    parser.add_argument("--max-kl", type=float, default=0.03)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--seed", type=int, default=765013)
    train(parser.parse_args())


if __name__ == "__main__":
    main()
