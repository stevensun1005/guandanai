"""Paired development contrasts for the four-arm study; not a held-out acceptance test."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

from run_full_training import outcomes


def checked(directory):
    manifest = json.loads((directory / "rollout.json").read_text())
    result, pairs = outcomes(directory)
    if (
        manifest["status"] != "complete"
        or result["matches"] != manifest["games"]
        or manifest["completedGames"] != manifest["games"]
    ):
        raise ValueError("Incomplete evaluation cannot enter a comparison")
    if sum(pairs.values()) * 2 != manifest["wins"]:
        raise ValueError("Outcome count disagrees with raw records")
    return result, pairs


def summary(directory, output):
    directory = Path(directory)
    arms = ["a-public-fresh", "b-public-review", "c-private-fresh", "d-private-review"]
    report = {
        "role": "Development, multiple comparisons; descriptive bootstrap intervals, not confirmatory acceptance",
        "seed": 67104,
        "bootstrapReplicates": 5000,
        "target80Validated": False,
        "evaluations": {},
        "initialTrajectorySHA256": {},
    }
    for arm in arms:
        file = directory / arm / "cycle-01/data/matches.jsonl"
        report["initialTrajectorySHA256"][arm] = hashlib.sha256(file.read_bytes()).hexdigest()
    if len(set(report["initialTrajectorySHA256"].values())) != 1:
        raise ValueError("Initial cohorts were not matched")
    for kind in ["rule", "snapshot"]:
        control_run = json.loads((directory / arms[0] / "run.json").read_text())
        cycles = [
            c for c in control_run["cycles"] if c["status"] == "complete" and c.get("evaluations")
        ]
        for cycle in cycles:
            prefix = f"cycle-{cycle['cycle']:02}"
            base, base_values = checked(directory / arms[0] / prefix / f"evaluation-{kind}")
            item = {"control": base, "arms": {}}
            for arm in arms:
                result, pairs = checked(directory / arm / prefix / f"evaluation-{kind}")
                if pairs.keys() != base_values.keys():
                    raise ValueError("Unpaired contrast")
                delta = np.array([pairs[s] - base_values[s] for s in sorted(pairs)])
                rng = np.random.default_rng(67104)
                bootstrap = rng.choice(delta, size=(5000, len(delta)), replace=True).mean(axis=1)
                item["arms"][arm] = {
                    "result": result,
                    "gainVsPublicFresh": float(delta.mean()),
                    "pairedBootstrap95CI": np.quantile(bootstrap, [0.025, 0.975]).tolist(),
                }
            if (directory / f"initial-{kind}/rollout.json").exists():
                item["initialPolicy"] = checked(directory / f"initial-{kind}")[0]
            report["evaluations"][f"{prefix}-{kind}"] = item
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {k: v["arms"] for k, v in report["evaluations"].items() if k.startswith("cycle-04")}
        ),
        flush=True,
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run", required=True)
    p.add_argument("--output", required=True)
    a = p.parse_args()
    summary(a.run, a.output)
