"""Frozen-proposal categorical rollout collection and local policy inference."""

import os

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import hashlib
import json
from pathlib import Path
import sys
import time

import numpy as np

from policy_learning import ROOT, RolloutEngine
from policy_features import POLICY_EXTRA_FEATURES, encode_policy_extras

FEATURES = 512 + POLICY_EXTRA_FEATURES
PARAMETERS = tuple(
    f"{branch}_{name}" for branch in ("actor", "critic") for name in ("w0", "b0", "w1", "b1")
)


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def initialize_weights(seed=765013):
    random = np.random.default_rng(seed)
    weights = {}
    for branch in ("actor", "critic"):
        weights[f"{branch}_w0"] = (
            random.standard_normal((FEATURES, 64)) / np.sqrt(FEATURES)
        ).astype(np.float32)
        weights[f"{branch}_b0"] = np.zeros(64, np.float32)
        weights[f"{branch}_w1"] = np.zeros((64, 1), np.float32)
        weights[f"{branch}_b1"] = np.zeros(1, np.float32)
    return weights


def validate_weights(weights):
    width = weights["actor_w0"].shape[0]
    if width not in (FEATURES, FEATURES + 8):
        raise ValueError("Unsupported PPO feature width")
    shapes = ((width, 64), (64,), (64, 1), (1,)) * 2
    if set(weights) != set(PARAMETERS):
        raise ValueError("Invalid PPO weight names")
    for name, shape in zip(PARAMETERS, shapes):
        value = weights[name]
        if value.dtype != np.float32 or value.shape != shape or not np.isfinite(value).all():
            raise ValueError(f"Invalid PPO weights: {name}")


def policy_sha(weights, config):
    digest = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(",", ":")).encode())
    for name in PARAMETERS:
        digest.update(name.encode())
        digest.update(np.asarray(weights[name], dtype="<f4").tobytes())
    return digest.hexdigest()


def save_actor(path, weights, config):
    validate_weights(weights)
    metadata = {
        "kind": "guandan-ppo",
        "schema": 1,
        "config": config,
        "policySHA256": policy_sha(weights, config),
    }
    np.savez(path, **weights, metadata=np.array(json.dumps(metadata, sort_keys=True)))
    return metadata


def load_actor(path):
    with np.load(path, allow_pickle=False) as archive:
        metadata = json.loads(str(archive["metadata"]))
        weights = {name: archive[name].copy() for name in PARAMETERS}
    validate_weights(weights)
    config = metadata["config"]
    if metadata.get("kind") != "guandan-ppo" or metadata.get("schema") != 1:
        raise ValueError("Unsupported PPO checkpoint")
    if config.get("features") != weights["actor_w0"].shape[0] or config.get("k") not in (2, 4):
        raise ValueError("Incompatible PPO features or candidate count")
    if not np.isfinite(config["temperature"]) or config["temperature"] <= 0:
        raise ValueError("Invalid PPO temperature")
    if metadata["policySHA256"] != policy_sha(weights, config):
        raise ValueError("PPO parameter fingerprint mismatch")
    return weights, config, metadata


def network(weights, branch, features):
    return (
        np.tanh(features @ weights[f"{branch}_w0"] + weights[f"{branch}_b0"])
        @ weights[f"{branch}_w1"]
        + weights[f"{branch}_b1"]
    )


def policy_outputs(weights, features, reference_logits, mask):
    """The critic depends on the entire proposal set, never the selected action."""
    mask = np.asarray(mask, dtype=bool)
    if not mask.any():
        raise ValueError("PPO decision has no legal candidate")
    logits = reference_logits.astype(np.float64) + network(weights, "actor", features).reshape(-1)
    logits[~mask] = -1e9
    maximum = logits[mask].max()
    normalizer = maximum + np.log(np.exp(logits[mask] - maximum).sum())
    log_probs = (logits - normalizer).astype(np.float32)
    log_probs[~mask] = -1e9
    pooled = features[mask].mean(axis=0)
    value = float(network(weights, "critic", pooled).item())
    if not np.isfinite(log_probs).all() or not np.isfinite(value):
        raise ValueError("Nonfinite PPO outputs")
    return log_probs, value


class PPOEngine:
    def __init__(self, proposal, actor=None, k=2, temperature=0.15):
        if Path(proposal).suffix == ".npz":
            if actor is not None:
                raise ValueError("Specify one PPO actor checkpoint")
            actor = proposal
            proposal = None
        if actor:
            self.weights, self.config, _ = load_actor(actor)
            expected = Path(self.config["proposalPath"]).resolve()
            proposal = expected if proposal is None else Path(proposal).resolve()
            if file_sha(proposal) != self.config["proposalSHA256"]:
                raise ValueError("Frozen PPO proposal changed")
            if file_sha(ROOT / "ai/danMCai/training/policy_features.py") != self.config["featuresSHA256"]:
                raise ValueError("PPO feature encoder changed")
        else:
            if k not in (2, 4) or not np.isfinite(temperature) or temperature <= 0:
                raise ValueError("Use K=2 or K=4 and a positive temperature")
            proposal = Path(proposal).resolve()
            self.weights = initialize_weights()
            self.config = {
                "features": FEATURES,
                "k": k,
                "temperature": float(temperature),
                "proposalPath": str(proposal),
                "proposalSHA256": file_sha(proposal),
                "featuresSHA256": file_sha(ROOT / "ai/danMCai/training/policy_features.py"),
                "referenceEncoderSHA256": file_sha(ROOT / "ai/danMCai/reference/numpy_engine.py"),
                "candidateSelection": "stable descending frozen-proposal score, first K",
                "reward": "team win sign * (1 + 0.1 * upgrade points)",
                "recording": "non-forced neural decisions before the first player finishes",
                "afterFirstFinish": "frozen proposal greedy; no actor or sampling",
            }
        if file_sha(ROOT / "ai/danMCai/reference/numpy_engine.py") != self.config["referenceEncoderSHA256"]:
            raise ValueError("PPO reference encoder changed")
        self.proposal = RolloutEngine(proposal)
        self.policy_hash = policy_sha(self.weights, self.config)
        self.pending = {}
        self.rows = self.games = 0
        self.output = None
        self.started = time.monotonic()
        self.collector_sha = file_sha(__file__)

    def prepare(self, state):
        scores, hidden, extras = self.proposal.score(state)
        k = self.config["k"]
        indices = np.argsort(-scores, kind="stable")[:k]
        features = np.zeros((k, FEATURES), np.float32)
        reference = np.zeros(k, np.float32)
        mask = np.zeros(k, np.float32)
        for slot, index in enumerate(indices):
            extra = extras[index] if extras is not None else encode_policy_extras(state, int(index))
            features[slot] = np.concatenate((hidden[index], extra))
            reference[slot] = (scores[index] - scores[indices[0]]) / self.config["temperature"]
            mask[slot] = 1
        return indices, features, reference, mask

    def initialize(self, message):
        if self.output is not None:
            raise ValueError("Collector already initialized")
        self.output = Path(message["output"])
        self.output.mkdir(parents=True, exist_ok=True)
        if any(
            (self.output / name).exists()
            for name in ("features.f32", "aux.f32", "behavior.npz", "metadata.json")
        ):
            raise ValueError("PPO output directory already contains training data")
        self.feature_stream = (self.output / "features.f32").open("xb")
        self.aux_stream = (self.output / "aux.f32").open("xb")
        self.random = np.random.default_rng(message["seed"])
        self.collection = message
        self.expected_games = message.get("options", {}).get("games")
        save_actor(self.output / "behavior.npz", self.weights, self.config)
        self.write_metadata()
        return {
            "ready": True,
            "policySHA256": self.policy_hash,
            "config": self.config,
            "behavior": "on-policy masked categorical sampling; epsilon is not used",
        }

    def decide(self, message):
        if self.output is None:
            raise ValueError("Initialize PPO collection first")
        state = message["state"]
        if any(count == 0 for count in state["counts"]):
            scores, _, _ = self.proposal.score(state)
            return {
                "index": int(np.argmax(scores)),
                "frozenEnding": True,
                "policySHA256": self.policy_hash,
            }
        indices, features, reference, mask = self.prepare(state)
        old_log_probs, old_value = policy_outputs(self.weights, features, reference, mask)
        probability = np.exp(old_log_probs.astype(np.float64))
        probability /= probability.sum()
        slot = int(self.random.choice(len(mask), p=probability))
        if all(count > 0 for count in state["counts"]):
            self.pending.setdefault(message["episode"], []).append(
                {
                    "features": features,
                    "reference": reference,
                    "mask": mask,
                    "log_probs": old_log_probs,
                    "slot": slot,
                    "value": old_value,
                    "seat": message["seat"],
                }
            )
        return {
            "index": int(indices[slot]),
            "oldLogProbability": float(old_log_probs[slot]),
            "oldValue": old_value,
            "policySHA256": self.policy_hash,
        }

    def finish(self, message):
        episode = message["episode"]
        if not isinstance(episode, int) or not 0 <= episode < 2**24:
            raise ValueError("Episode ID must fit float32 exactly")
        transitions = self.pending.pop(episode, [])
        for row in transitions:
            target = (1 if row["seat"] % 2 == message["winner"] else -1) * (
                1 + 0.1 * message["points"]
            )
            np.asarray(row["features"], dtype="<f4").tofile(self.feature_stream)
            np.concatenate(
                (
                    row["reference"],
                    row["mask"],
                    row["log_probs"],
                    [row["slot"], row["value"], target, episode, row["seat"]],
                )
            ).astype("<f4").tofile(self.aux_stream)
        self.feature_stream.flush()
        self.aux_stream.flush()
        self.rows += len(transitions)
        self.games += 1
        self.write_metadata()
        return {"stored": len(transitions), "rows": self.rows, "games": self.games}

    def write_metadata(self):
        complete = (
            self.expected_games is not None
            and self.games == self.expected_games
            and not self.pending
        )
        metadata = {
            "schema": 1,
            "kind": "guandan-ppo-rollout",
            "status": "complete" if complete else "collecting",
            "rows": self.rows,
            "games": self.games,
            "features": self.config["features"],
            "k": self.config["k"],
            "auxFloats": 3 * self.config["k"] + 5,
            "auxLayout": [
                "reference_logits[K]",
                "legal_mask[K]",
                "old_log_probs[K]",
                "chosen_slot",
                "old_value",
                "return",
                "episode",
                "seat",
            ],
            "policySHA256": self.policy_hash,
            "config": self.config,
            "behavior": "on-policy masked categorical; no epsilon exploration",
            "collection": self.collection,
            "collectorSHA256": self.collector_sha,
            "elapsedSeconds": time.monotonic() - self.started,
        }
        (self.output / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    def score(self, state):
        if any(count == 0 for count in state["counts"]):
            return self.proposal.score(state)[0]
        indices, features, reference, mask = self.prepare(state)
        log_probs, _ = policy_outputs(self.weights, features, reference, mask)
        scores = np.full(len(state["actions"]), -1e9, np.float32)
        scores[indices] = log_probs[: len(indices)]
        return scores

    def close(self):
        if self.output is not None:
            self.feature_stream.close()
            self.aux_stream.close()


def main():
    engine = None
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if engine is None:
                proposal = (
                    message.get("model")
                    or os.environ.get("GUANDAN_POLICY_MODEL")
                    or ROOT / "ai/danMCai/models/baseline/policy.onnx"
                )
                engine = PPOEngine(
                    proposal,
                    actor=os.environ.get("PPO_ACTOR"),
                    k=int(os.environ.get("PPO_K", "2")),
                    temperature=float(os.environ.get("PPO_TEMPERATURE", ".15")),
                )
            op = message.get("op")
            if op == "init":
                result = engine.initialize(message)
            elif op == "decide":
                result = engine.decide(message)
            elif op == "finish":
                result = engine.finish(message)
            elif op is None:
                result = {
                    "values": engine.score(message).tolist(),
                    "policySHA256": engine.policy_hash,
                }
            else:
                raise ValueError(f"Unknown PPO operation: {op}")
            print(json.dumps(result, separators=(",", ":")), flush=True)
        except Exception as error:
            print(json.dumps({"error": str(error)}), flush=True)
    if engine is not None:
        engine.close()


if __name__ == "__main__":
    main()
