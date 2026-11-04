"""Parallel full-match actors and progressive complete-network learning; no automatic website writes."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import subprocess
import sys

from full_model import ROOT, sha


def interval(values):
    mean = sum(values) / len(values)
    if len(values) < 2:
        return [mean, mean]
    error = 1.96 * math.sqrt(sum((v - mean) ** 2 for v in values) / (len(values) - 1) / len(values))
    return [mean - error, mean + error]


def outcomes(directory):
    records = [
        json.loads(line)
        for line in (directory / "matches.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    groups = {}
    for row in records:
        groups.setdefault(row["seed"], []).append(row)
    if any(len(rows) != 2 or {x["neuralTeam"] for x in rows} != {0, 1} for rows in groups.values()):
        raise ValueError(
            "Evaluation must retain both team assignments for each independent deal seed"
        )
    paired = {
        seed: sum(x["winner"] == x["neuralTeam"] for x in rows) / 2 for seed, rows in groups.items()
    }
    values = list(paired.values())
    return {
        "matches": len(records),
        "pairs": len(groups),
        "winRate": sum(values) / len(values),
        "winRate95CI": interval(values),
        "drawRate": sum(x["winner"] is None for x in records) / len(records),
    }, paired


def retain_candidate(evaluations):
    """Keep a training parent only when both development arenas support it."""
    return evaluations["rule"]["championGain"] > 0 and evaluations["snapshot"]["championGain"] >= 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--initial", required=True)
    parser.add_argument("--opponent-model", required=True)
    parser.add_argument("--cycles", type=int, default=16)
    parser.add_argument("--matches", type=int, default=192)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--seed", type=int, default=37100104)
    parser.add_argument("--eval-seed", type=int, default=38100104)
    parser.add_argument("--eval-pairs", type=int, default=64)
    parser.add_argument("--eval-every", type=int, default=2)
    parser.add_argument("--epsilon", type=float, default=0.05)
    parser.add_argument("--learning-rate", type=float, default=1e-6)
    parser.add_argument("--anchor-weight", type=float, default=50)
    args = parser.parse_args()
    if (
        not 1 <= args.cycles <= 100
        or not 1 <= args.workers <= 4
        or args.matches < args.workers * 10
        or args.eval_pairs < 2
        or args.eval_every < 1
        or not math.isfinite(args.learning_rate)
        or args.learning_rate <= 0
        or not math.isfinite(args.anchor_weight)
        or args.anchor_weight < 0
        or not 0 <= args.epsilon <= 1
    ):
        raise ValueError("Invalid bounded full-network plan")
    if max(args.seed, args.eval_seed) < min(
        args.seed + args.cycles * args.matches, args.eval_seed + args.eval_pairs
    ):
        raise ValueError("Training and evaluation seeds overlap")
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    initial = Path(args.initial).resolve()
    checkpoint = initial / "full.npz"
    model = initial / "policy.onnx"
    champion_checkpoint, champion_model = checkpoint, model
    champion_results = None
    record = {
        "args": vars(args),
        "status": "running",
        "cycles": [],
        "startedUTC": datetime.now(timezone.utc).isoformat(),
        "publicationPolicy": "Independent full-match gain plus browser verification required; this runner never changes deployed weights",
    }
    env = dict(os.environ, FULL_EPSILON=str(args.epsilon))
    env.pop("PPO_ACTOR", None)

    def save():
        (output / "run.json").write_text(json.dumps(record, indent=2), encoding="utf-8")

    def run(command, log):
        with log.open("w", encoding="utf-8") as stream:
            result = subprocess.run(
                command,
                cwd=ROOT,
                env=env,
                stdout=stream,
                stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        if result.returncode:
            raise RuntimeError(f"Experiment failed; see {log}")

    def evaluate(path, directory, seed, kind):
        command = [
            "node",
            "scripts/collect-matches.mjs",
            f"--matches={args.eval_pairs*2}",
            f"--seed={seed}",
            "--evaluate=1",
            "--inference-script=scripts/full_learning.py",
            f"--model={path}",
            f"--output={directory}",
        ]
        if kind == "snapshot":
            command += [
                "--evaluate-opponent=snapshot",
                f"--opponent-model={Path(args.opponent_model).resolve()}",
            ]
        run(command, directory.with_suffix(".log"))
        return outcomes(directory)

    save()
    try:
        for cycle in range(args.cycles):
            directory = output / f"cycle-{cycle+1:02}"
            directory.mkdir()
            stage = "tail" if cycle < 2 else "middle" if cycle < 4 else "full"
            entry = {
                "cycle": cycle + 1,
                "stage": stage,
                "status": "collecting",
                "behaviorSHA256": sha(model),
                "matchesPlanned": args.matches,
            }
            record["cycles"].append(entry)
            save()
            print(json.dumps(entry), flush=True)
            jobs = []
            offset = 0
            for worker in range(args.workers):
                n = args.matches // args.workers + (worker < args.matches % args.workers)
                data = directory / f"actor-{worker}"
                command = [
                    "node",
                    "scripts/collect-matches.mjs",
                    f"--matches={n}",
                    f"--seed={args.seed+cycle*args.matches+offset}",
                    "--opponent=mixed",
                    f"--opponent-model={Path(args.opponent_model).resolve()}",
                    "--inference-script=scripts/full_learning.py",
                    f"--model={model}",
                    f"--output={data}",
                ]
                jobs.append((command, directory / f"actor-{worker}.log", data))
                offset += n
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                list(pool.map(lambda job: run(job[0], job[1]), jobs))
            entry["status"] = "updating"
            save()
            run(
                [
                    sys.executable,
                    "scripts/train_full_policy.py",
                    *[str(job[2]) for job in jobs],
                    f"--checkpoint={checkpoint}",
                    f"--stage={stage}",
                    f"--learning-rate={args.learning_rate}",
                    f"--extra-learning-rate={args.learning_rate}",
                    f"--anchor={initial / 'full.npz'}",
                    f"--anchor-weight={args.anchor_weight}",
                    f'--output={directory/"model"}',
                ],
                directory / "training.log",
            )
            checkpoint = directory / "model/full.npz"
            model = directory / "model/policy.onnx"
            training = json.loads((directory / "model/training.json").read_text(encoding="utf-8"))
            entry.update(
                model=str(model),
                parameters=training["parameters"],
                trainableParameters=training["trainableParameters"],
                parameterUpdates=training["parameterUpdates"],
            )
            if (cycle + 1) % args.eval_every == 0 or cycle + 1 == args.cycles:
                entry["status"] = "evaluating"
                save()
                initial_results = {}
                for kind in ["rule", "snapshot"]:
                    baseline_dir = output / f"initial-{kind}"
                    if not (baseline_dir / "rollout.json").exists():
                        initial_results[kind] = evaluate(
                            initial / "policy.onnx", baseline_dir, args.eval_seed, kind
                        )
                    else:
                        initial_results[kind] = outcomes(baseline_dir)
                entry["evaluations"] = {}
                if champion_results is None:
                    champion_results = initial_results
                candidate_results = {}
                for kind in ["rule", "snapshot"]:
                    summary, paired = evaluate(
                        model, directory / f"evaluation-{kind}", args.eval_seed, kind
                    )
                    base_summary, base_paired = initial_results[kind]
                    if paired.keys() != base_paired.keys():
                        raise ValueError("Unpaired evaluation seeds")
                    delta = [paired[seed] - base_paired[seed] for seed in paired]
                    champion_paired = champion_results[kind][1]
                    champion_delta = [paired[seed] - champion_paired[seed] for seed in paired]
                    summary.update(
                        initialWinRate=base_summary["winRate"],
                        pairedGain=sum(delta) / len(delta),
                        pairedGain95CI=interval(delta),
                        championGain=sum(champion_delta) / len(champion_delta),
                        championGain95CI=interval(champion_delta),
                    )
                    entry["evaluations"][kind] = summary
                    candidate_results[kind] = summary, paired
                demonstrated = (
                    entry["evaluations"]["rule"]["pairedGain95CI"][0] > 0
                    and entry["evaluations"]["snapshot"]["pairedGain95CI"][0] >= 0
                )
                entry["publicationStatus"] = (
                    "development_gain_requires_new_holdout_and_browser"
                    if demonstrated
                    else "gain_not_demonstrated"
                )
                if retain_candidate(entry["evaluations"]):
                    champion_checkpoint, champion_model = checkpoint, model
                    champion_results = candidate_results
                    entry["trainingSelection"] = "retained_development_champion"
                else:
                    checkpoint, model = champion_checkpoint, champion_model
                    entry["trainingSelection"] = "rolled_back_to_champion"
                entry["nextBehaviorModel"] = str(model)
                record["championModel"] = str(champion_model)
            entry["status"] = "complete"
            save()
            print(
                json.dumps(
                    {
                        "cycle": cycle + 1,
                        "stage": stage,
                        "status": "complete",
                        "trainableParameters": entry["trainableParameters"],
                        "evaluations": entry.get("evaluations"),
                    }
                ),
                flush=True,
            )
        record["status"] = "complete"
    except BaseException as error:
        record["status"] = "failed"
        record["error"] = str(error)
        raise
    finally:
        record["finishedUTC"] = datetime.now(timezone.utc).isoformat()
        save()


if __name__ == "__main__":
    main()
