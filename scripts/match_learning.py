"""Full-match team-return PPO: learn through first-out and subsequent rounds."""

import json
import os
import sys

import numpy as np

from ppo_learning import PPOEngine, policy_outputs, policy_sha, file_sha
from policy_learning import ROOT


def match_features(state):
    match = state["match"]
    team = state["p"] % 2
    other = 1 - team
    order = match.get("previousOrder")
    double = order is not None and order[0] % 2 == order[1] % 2
    return np.array(
        [
            match["levels"][team] / 14,
            match["levels"][other] / 14,
            match["aFails"][team] / 3,
            match["aFails"][other] / 3,
            float(match["lvlTeam"] == team),
            min(match["round"], 100) / 100,
            float(double and order[0] % 2 == team),
            float(double and order[0] % 2 == other),
        ],
        dtype=np.float32,
    )


class MatchEngine(PPOEngine):
    def __init__(self, proposal, actor=None, k=4, temperature=0.15):
        super().__init__(proposal, actor=actor, k=k, temperature=temperature)
        if self.config["features"] == 565:
            for branch in ("actor", "critic"):
                self.weights[f"{branch}_w0"] = np.concatenate(
                    (self.weights[f"{branch}_w0"], np.zeros((8, 64), np.float32))
                )
        self.config.update(
            features=573,
            objective="full-match",
            reward="Terminal match team victory +1, defeat -1, rule-defined draw 0",
            recording="All non-forced decisions in every round, including after first-out",
            afterFirstFinish="Actor continues; partner placement affects subsequent match state",
        )
        self.config["matchEncoderSHA256"] = file_sha(__file__)
        self.config["matchRulesSHA256"] = file_sha(ROOT / "src/core/match.js")
        self.config["matchSimulationSHA256"] = file_sha(ROOT / "scripts/lib/match-simulation.mjs")
        self.policy_hash = policy_sha(self.weights, self.config)
        self.collector_sha = file_sha(__file__)

    def prepare(self, state):
        # Build the existing 565 public/private-own features before appending public match state.
        indices, features, reference, mask = super().prepare(state)
        extension = np.repeat(match_features(state)[None, :], self.config["k"], axis=0)
        extension[mask == 0] = 0
        return indices, np.concatenate((features, extension), axis=1), reference, mask

    def decide(self, message):
        indices, features, reference, mask = self.prepare(message["state"])
        log_probs, value = policy_outputs(self.weights, features, reference, mask)
        probability = np.exp(log_probs.astype(np.float64))
        probability /= probability.sum()
        slot = int(self.random.choice(len(mask), p=probability))
        self.pending.setdefault(message["episode"], []).append(
            {
                "features": features,
                "reference": reference,
                "mask": mask,
                "log_probs": log_probs,
                "slot": slot,
                "value": value,
                "seat": message["seat"],
            }
        )
        return {"index": int(indices[slot]), "policySHA256": self.policy_hash}

    def finish(self, message):
        transitions = self.pending.pop(message["episode"], [])
        for row in transitions:
            target = (
                0
                if message["winner"] is None
                else (1 if row["seat"] % 2 == message["winner"] else -1)
            )
            np.asarray(row["features"], dtype="<f4").tofile(self.feature_stream)
            np.concatenate(
                (
                    row["reference"],
                    row["mask"],
                    row["log_probs"],
                    [row["slot"], row["value"], target, message["episode"], row["seat"]],
                )
            ).astype("<f4").tofile(self.aux_stream)
        self.feature_stream.flush()
        self.aux_stream.flush()
        self.rows += len(transitions)
        self.games += 1
        self.write_metadata()
        return {"stored": len(transitions), "matches": self.games}

    def score(self, state):
        indices, features, reference, mask = self.prepare(state)
        log_probs, _ = policy_outputs(self.weights, features, reference, mask)
        scores = np.full(len(state["actions"]), -1e9, np.float32)
        scores[indices] = log_probs[: len(indices)]
        return scores


def main():
    engine = None
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if engine is None:
                engine = MatchEngine(
                    message.get("model")
                    or os.environ.get("GUANDAN_POLICY_MODEL")
                    or "ai/policy.onnx",
                    actor=os.environ.get("PPO_ACTOR"),
                )
            op = message.get("op")
            if op == "init":
                result = engine.initialize(message)
            elif op == "decide":
                result = engine.decide(message)
            elif op == "finish":
                result = engine.finish(message)
            elif op is None:
                result = {"values": engine.score(message).tolist()}
            else:
                raise ValueError("Unknown full-match operation")
            print(json.dumps(result, separators=(",", ":")), flush=True)
        except Exception as error:
            print(json.dumps({"error": str(error)}), flush=True)
    if engine:
        engine.close()


if __name__ == "__main__":
    main()
