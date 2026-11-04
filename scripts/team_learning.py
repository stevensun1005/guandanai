"""Collect on-policy full-match trajectories, keeping private hands out of the actor."""

import os

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
import json
from pathlib import Path
import sys

import numpy as np

from full_learning import FullEngine
from full_model import sha
from team_model import (
    ACTION,
    CRITIC,
    critic_state,
    critic_value,
    fingerprints,
    load_config,
    load_critic,
    log_probs,
)


class TeamEngine:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.config = load_config(self.directory)
        self.actor = FullEngine(self.directory / "policy.onnx")
        self.anchor = FullEngine(self.config["anchor"])
        if sha(self.config["anchor"]) != self.config["anchorSHA256"]:
            raise ValueError("Anchor changed")
        self.critic = load_critic(self.directory / "critic.npz")
        self.pending = {}
        self.games = self.rows = self.action_rows = 0

    def initialize(self, message):
        self.output = Path(message["output"])
        self.output.mkdir(parents=True, exist_ok=True)
        self.collection = message
        self.random = np.random.default_rng(message["seed"])
        self.states = (self.output / "states.f32").open("xb")
        self.actions = (self.output / "actions.f32").open("xb")
        self.records = (self.output / "decisions.jsonl").open("x", encoding="utf-8")
        self.write_metadata()
        return {"ready": True, "actorObservations": "own hand and public information only"}

    def decide(self, message):
        # Only the public state crosses this call. The separate critic receives private cards below.
        state = message["state"]
        values, raw = self.actor.score(state)
        old = log_probs(values, self.config["temperature"])
        anchor = log_probs(
            values
            if self.actor.model_hash == self.anchor.model_hash
            else self.anchor.score(state)[0],
            self.config["temperature"],
        )
        probability = np.exp(old.astype(np.float64))
        probability /= probability.sum()
        chosen = int(self.random.choice(len(old), p=probability))
        critic = critic_state(state, message.get("criticOnly"), self.config["privilegedCritic"])
        action = np.column_stack([raw[:, 513:620], old, anchor]).astype("<f4")
        self.pending.setdefault(message["episode"], []).append(
            (critic, action, chosen, critic_value(self.critic, critic), message["seat"])
        )
        return {"index": chosen}

    def finish(self, message):
        for state, action, chosen, value, seat in self.pending.pop(message["episode"], []):
            target = 0 if message["winner"] is None else 1 if seat % 2 == message["winner"] else -1
            record = {
                "offset": self.action_rows,
                "count": len(action),
                "chosen": chosen,
                "oldValue": value,
                "target": target,
                "episode": message["episode"],
                "seat": seat,
            }
            np.asarray(state, dtype="<f4").tofile(self.states)
            action.tofile(self.actions)
            self.records.write(json.dumps(record) + "\n")
            self.rows += 1
            self.action_rows += len(action)
        self.games += 1
        for stream in [self.states, self.actions, self.records]:
            stream.flush()
        self.write_metadata()
        return {"storedGames": self.games}

    def write_metadata(self):
        metadata = {
            "kind": "full-team-ppo-buffer",
            "status": "complete"
            if self.games == self.collection["options"]["games"] and not self.pending
            else "collecting",
            "games": self.games,
            "rows": self.rows,
            "actionRows": self.action_rows,
            "publicStateFeatures": 521,
            "criticFeatures": CRITIC,
            "actionFeatures": ACTION,
            "config": self.config,
            "actorSHA256": sha(self.directory / "actor.npz"),
            "criticSHA256": sha(self.directory / "critic.npz"),
            "behaviorDirectory": str(self.directory),
            "sourceSHA256": fingerprints(),
            "collection": self.collection,
        }
        (self.output / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")


def main():
    engine = None
    try:
        for line in sys.stdin:
            try:
                m = json.loads(line)
                if engine is None:
                    engine = TeamEngine(m["model"])
                op = m.get("op")
                if op == "init":
                    result = engine.initialize(m)
                elif op == "decide":
                    result = engine.decide(m)
                elif op == "finish":
                    result = engine.finish(m)
                elif op is None:
                    result = {"values": engine.actor.score(m)[0].tolist()}
                else:
                    raise ValueError("Unsupported team operation")
                print(json.dumps(result), flush=True)
            except Exception as error:
                print(json.dumps({"error": str(error)}), flush=True)
    finally:
        if engine and hasattr(engine, "output"):
            for stream in [engine.states, engine.actions, engine.records]:
                stream.close()


if __name__ == "__main__":
    main()
