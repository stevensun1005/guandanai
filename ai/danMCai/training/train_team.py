"""Full-actor PPO with a capacity-matched public or privileged training-only critic."""

import os

os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import argparse
import json
from pathlib import Path
import shutil

import numpy as np
import torch
from torch import nn

from full_model import ROOT, WIDTH, load_parameters, save_parameters, export_model, sha
from train_full_policy import CompleteNetwork
from team_model import (
    CRITIC,
    CRITIC_DIMS,
    STORED_ACTION,
    fingerprints,
    load_config,
    load_critic,
    save_critic,
)


class Critic(nn.Module):
    def __init__(self, weights):
        super().__init__()
        self.layers = nn.ModuleList([nn.Linear(a, b) for a, b in zip(CRITIC_DIMS, CRITIC_DIMS[1:])])
        with torch.no_grad():
            for i, layer in enumerate(self.layers):
                layer.weight.copy_(torch.from_numpy(weights[f"w{i}"].T.copy()))
                layer.bias.copy_(torch.from_numpy(weights[f"b{i}"]))

    def forward(self, x):
        for i, layer in enumerate(self.layers):
            x = torch.tanh(layer(x)) if i < 2 else layer(x)
        return x.squeeze(-1)

    def export(self):
        return {
            k: v.detach().numpy().copy()
            for i, layer in enumerate(self.layers)
            for k, v in [(f"w{i}", layer.weight.T), (f"b{i}", layer.bias)]
        }


class Buffer:
    def __init__(self, path):
        self.path = Path(path)
        self.meta = json.loads((self.path / "metadata.json").read_text())
        m = self.meta
        outer = json.loads((self.path / "rollout.json").read_text())
        if (
            m["kind"] != "full-team-ppo-buffer"
            or m["status"] != "complete"
            or outer["status"] != "complete"
            or m["games"] != outer["completedGames"]
            or m["games"] != outer["games"]
        ):
            raise ValueError("Incomplete on-policy team buffer")
        for path, expected in m["sourceSHA256"].items():
            if sha(ROOT / path) != expected:
                raise ValueError(f"Training source changed: {path}")
        behavior = Path(m["behaviorDirectory"])
        if (
            sha(behavior / "actor.npz") != m["actorSHA256"]
            or sha(behavior / "critic.npz") != m["criticSHA256"]
        ):
            raise ValueError("Behavior checkpoint changed")
        if (self.path / "states.f32").stat().st_size != m["rows"] * CRITIC * 4 or (
            self.path / "actions.f32"
        ).stat().st_size != m["actionRows"] * STORED_ACTION * 4:
            raise ValueError("Truncated team buffer")
        self.states = np.memmap(
            self.path / "states.f32", mode="r", dtype="<f4", shape=(m["rows"], CRITIC)
        )
        self.actions = np.memmap(
            self.path / "actions.f32", mode="r", dtype="<f4", shape=(m["actionRows"], STORED_ACTION)
        )
        self.records = [
            json.loads(s) for s in (self.path / "decisions.jsonl").read_text().splitlines()
        ]
        outcomes = {
            r["episode"]: r["winner"]
            for r in (
                json.loads(line) for line in (self.path / "matches.jsonl").read_text().splitlines()
            )
        }
        if set(outcomes) != set(range(m["games"])):
            raise ValueError("Missing full-match outcomes")
        if len(self.records) != m["rows"] or not len(self.records):
            raise ValueError("Invalid decision count")
        offset = 0
        for r in self.records:
            if (
                r["offset"] != offset
                or r["count"] < 1
                or not 0 <= r["chosen"] < r["count"]
                or r["target"] not in (-1, 0, 1)
                or not 0 <= r["episode"] < m["games"]
                or r["seat"] not in range(4)
                or not np.isfinite(r["oldValue"])
            ):
                raise ValueError("Invalid trajectory record")
            expected = (
                0
                if outcomes[r["episode"]] is None
                else 1
                if r["seat"] % 2 == outcomes[r["episode"]]
                else -1
            )
            if r["target"] != expected:
                raise ValueError("Learning target differs from full-match team outcome")
            offset += r["count"]
        if (
            offset != m["actionRows"]
            or not np.isfinite(self.states).all()
            or not np.isfinite(self.actions).all()
        ):
            raise ValueError("Invalid action offsets or nonfinite features")
        if not m["config"]["privilegedCritic"] and np.any(self.states[:, 521:] != 0):
            raise ValueError("Public control has private critic inputs")

    def batch(self, indices):
        critic = torch.from_numpy(np.array(self.states[indices], copy=True))
        raw = []
        old = []
        anchor = []
        chosen = []
        counts = []
        for i in indices:
            r = self.records[i]
            a = np.array(self.actions[r["offset"] : r["offset"] + r["count"]], copy=True)
            x = np.empty((len(a), WIDTH), np.float32)
            x[:, :513] = self.states[i, :513]
            x[:, 513:620] = a[:, :107]
            x[:, 620:] = self.states[i, 513:521]
            raw.append(x)
            old.append(torch.from_numpy(a[:, 107]))
            anchor.append(torch.from_numpy(a[:, 108]))
            chosen.append(r["chosen"])
            counts.append(len(a))
        return torch.from_numpy(np.concatenate(raw)), critic, old, anchor, chosen, counts


def distributions(actor, raw, counts, temperature):
    return [
        torch.log_softmax(v, dim=0)
        for v in torch.split(actor(raw).squeeze(-1) / temperature, counts)
    ]


def train(args):
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    data = Buffer(args.data)
    behavior = Path(data.meta["behaviorDirectory"])
    config = load_config(behavior)
    before, _ = load_parameters(behavior / "actor.npz")
    actor = CompleteNetwork(before)
    actor.unfreeze("full")
    critic = Critic(load_critic(behavior / "critic.npz"))
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    optimizer = torch.optim.Adam(
        [
            {"params": actor.parameters(), "lr": args.learning_rate},
            {"params": critic.parameters(), "lr": 0.0003},
        ]
    )
    target = torch.tensor([r["target"] for r in data.records], dtype=torch.float32)
    old_value = torch.tensor([r["oldValue"] for r in data.records], dtype=torch.float32)
    advantage = target - old_value
    advantage = (advantage - advantage.mean()) / advantage.std(unbiased=False).clamp_min(1e-6)
    max_log_error = max_value_error = 0.0
    with torch.no_grad():
        for start in range(0, len(target), args.batch):
            ids = np.arange(start, min(start + args.batch, len(target)))
            raw, state, old, anchor, chosen, counts = data.batch(ids)
            pred = distributions(actor, raw, counts, config["temperature"])
            max_log_error = max(
                max_log_error, max(float((p - o).abs().max()) for p, o in zip(pred, old))
            )
            max_value_error = max(
                max_value_error, float((critic(state) - old_value[ids]).abs().max())
            )
    if max_log_error > 2e-3 or max_value_error > 1e-4:
        raise ValueError("Buffer does not match serialized actor and critic")
    rng = np.random.default_rng(args.seed)
    history = []
    early = False
    for epoch in range(args.epochs):
        losses = []
        kls = []
        for ids in np.array_split(
            rng.permutation(len(target)), max(1, int(np.ceil(len(target) / args.batch)))
        ):
            raw, state, old, anchor, chosen, counts = data.batch(ids)
            pred = distributions(actor, raw, counts, config["temperature"])
            new_chosen = torch.stack([p[c] for p, c in zip(pred, chosen)])
            old_chosen = torch.stack([p[c] for p, c in zip(old, chosen)])
            ratio = (new_chosen - old_chosen).exp()
            adv = advantage[ids]
            policy = -torch.minimum(ratio * adv, ratio.clamp(0.9, 1.1) * adv).mean()
            value = ((critic(state) - target[ids]) ** 2).mean()
            entropy = torch.stack([-(p.exp() * p).sum() for p in pred]).mean()
            anchor_kl = torch.stack(
                [(p.exp() * (p - a)).sum() for p, a in zip(pred, anchor)]
            ).mean()
            old_kl = torch.stack([(o.exp() * (o - p)).sum() for p, o in zip(pred, old)]).mean()
            if float(old_kl.detach()) > 0.02:
                early = True
                break
            loss = policy + 0.5 * value - 0.001 * entropy + 0.05 * anchor_kl
            if not torch.isfinite(loss):
                raise ValueError("Nonfinite asymmetric PPO loss")
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(actor.parameters(), 1)
            nn.utils.clip_grad_norm_(critic.parameters(), 1)
            optimizer.step()
            losses.append(float(loss.detach()))
            kls.append(float(old_kl.detach()))
        history.append(
            {
                "epoch": epoch + 1,
                "meanLoss": sum(losses) / len(losses) if losses else None,
                "maxOldKL": max(kls, default=None),
                "earlyStop": early,
            }
        )
        print(json.dumps(history[-1]), flush=True)
        if early:
            break
    updated = actor.export()
    save_parameters(output / "actor.npz", updated, algorithm="full-actor-asymmetric-ppo")
    export_model(output / "policy.onnx", updated)
    save_critic(output / "critic.npz", critic.export())
    shutil.copy2(behavior / "config.json", output / "config.json")
    report = {
        "algorithm": "All-candidate full-actor PPO with separate training-only critic",
        "trainableParameters": sum(p.numel() for p in [*actor.parameters(), *critic.parameters()]),
        "actorParameters": sum(p.numel() for p in actor.parameters()),
        "criticParameters": sum(p.numel() for p in critic.parameters()),
        "rows": len(target),
        "games": data.meta["games"],
        "checkpointSHA256": sha(output / "actor.npz"),
        "criticSHA256": sha(output / "critic.npz"),
        "modelSHA256": sha(output / "policy.onnx"),
        "bufferSHA256": {
            p: sha(data.path / p)
            for p in ["states.f32", "actions.f32", "decisions.jsonl", "metadata.json"]
        },
        "sourceSHA256": {**fingerprints(), "ai/danMCai/training/train_team.py": sha(__file__)},
        "parameterUpdates": {
            k: {"changed": int(np.count_nonzero(updated[k] != before[k]))} for k in before
        },
        "behaviorAudit": {
            "maxLogProbabilityError": max_log_error,
            "maxCriticValueError": max_value_error,
        },
        "config": config,
        "args": vars(args),
        "history": history,
        "publication": "Experimental checkpoint; no match improvement inferred from optimization loss",
    }
    (output / "training.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("data")
    p.add_argument("--output", required=True)
    p.add_argument("--epochs", type=int, default=2)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--learning-rate", type=float, default=1e-6)
    p.add_argument("--threads", type=int, default=4)
    p.add_argument("--seed", type=int, default=61004)
    a = p.parse_args()
    if (
        a.epochs < 1
        or a.batch < 1
        or a.threads < 1
        or not np.isfinite(a.learning_rate)
        or a.learning_rate <= 0
    ):
        raise ValueError("Invalid PPO settings")
    train(a)
