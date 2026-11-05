"""Public full-network actor; a separate, training-only state-value critic."""

import json
from pathlib import Path

import numpy as np

from full_model import ROOT, cards_array, encode, sha, source_hashes
from match_learning import match_features

PUBLIC = 521
CRITIC = 683
ACTION = 107
STORED_ACTION = 109  # cards, action extras, old log probability, anchor log probability
CRITIC_DIMS = [CRITIC, 256, 128, 1]


def public_state(state):
    return np.r_[encode(state), match_features(state)].astype(np.float32)


def critic_state(state, privileged, use_private):
    result = np.zeros(CRITIC, np.float32)
    result[:PUBLIC] = public_state(state)
    if not use_private:
        return result
    hands = privileged.get("hands") if isinstance(privileged, dict) else None
    if not isinstance(hands, list) or len(hands) != 4:
        raise ValueError("Missing training-only current hands")
    if any(len(h) != n for h, n in zip(hands, state["counts"])) or set(hands[state["p"]]) != set(
        state["hand"]
    ):
        raise ValueError("Critic hand sizes do not match public observation")
    seen = [i for row in state["log"] for i in row.get("cards") or []]
    ids = [i for hand in hands for i in hand] + seen
    if len(ids) != 108 or set(ids) != set(range(108)):
        raise ValueError("Critic current hands violate physical card conservation")
    for offset in range(1, 4):
        result[PUBLIC + (offset - 1) * 54 : PUBLIC + offset * 54] = cards_array(
            hands[(state["p"] + offset) % 4]
        )
    return result


def initialize_critic(seed=61004):
    rng = np.random.default_rng(seed)
    weights = {}
    for i, (a, b) in enumerate(zip(CRITIC_DIMS, CRITIC_DIMS[1:])):
        weights[f"w{i}"] = (
            (rng.standard_normal((a, b)) / np.sqrt(a)).astype(np.float32)
            if i < 2
            else np.zeros((a, b), np.float32)
        )
        weights[f"b{i}"] = np.zeros(b, np.float32)
    return weights


def save_critic(path, weights):
    np.savez(
        path,
        **weights,
        metadata=np.array(
            json.dumps({"kind": "training-only-team-critic", "dimensions": CRITIC_DIMS})
        ),
    )


def load_critic(path):
    with np.load(path, allow_pickle=False) as archive:
        meta = json.loads(str(archive["metadata"]))
        if meta != {"kind": "training-only-team-critic", "dimensions": CRITIC_DIMS}:
            raise ValueError("Incompatible training critic")
        weights = {k: archive[k].copy() for i in range(3) for k in [f"w{i}", f"b{i}"]}
    for i, (a, b) in enumerate(zip(CRITIC_DIMS, CRITIC_DIMS[1:])):
        if (
            weights[f"w{i}"].shape != (a, b)
            or weights[f"b{i}"].shape != (b,)
            or any(
                v.dtype != np.float32 or not np.isfinite(v).all()
                for k, v in weights.items()
                if k.endswith(str(i))
            )
        ):
            raise ValueError("Invalid critic parameters")
    return weights


def critic_value(weights, state):
    x = state
    for i in range(3):
        x = x @ weights[f"w{i}"] + weights[f"b{i}"]
        if i < 2:
            x = np.tanh(x)
    return float(x.item())


def log_probs(values, temperature):
    x = np.asarray(values, np.float64) / temperature
    normalizer = np.max(x) + np.log(np.exp(x - np.max(x)).sum())
    return (x - normalizer).astype(np.float32)


def fingerprints():
    paths = ["ai/danMCai/training/team_model.py", "ai/danMCai/training/team_learning.py", "ai/danMCai/data/tools/collect-team.mjs"]
    return {**source_hashes(), **{p: sha(ROOT / p) for p in paths}}


def load_config(directory):
    directory = Path(directory).resolve()
    config = json.loads((directory / "config.json").read_text())
    if config.get("kind") != "full-actor-asymmetric-ppo" or not 0 < config["temperature"] <= 1:
        raise ValueError("Invalid team model configuration")
    return config
