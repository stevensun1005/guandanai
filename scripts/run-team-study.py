"""Bounded four-arm study: full public actor, public/private critic, fresh/opening-review curriculum."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from full_model import ROOT, load_parameters, export_model, sha
from team_model import initialize_critic, save_critic

ARMS = {
    "a-public-fresh": (False, False),
    "b-public-review": (False, True),
    "c-private-fresh": (True, False),
    "d-private-review": (True, True),
}


def collection_plan(base, cycle, games, review, previous):
    hard = [r for r in previous if r["opponent"] != "self" and r["winner"] != r["neuralTeam"]]
    hard = sorted(hard, key=lambda r: (r["winner"] is not None, r["problemSeed"]), reverse=True)[
        :1000
    ]
    result = []
    for i in range(games):
        item = hard[(i // 2) % len(hard)] if review and hard and i % 2 == 0 else None
        result.append(
            {
                "problemSeed": item["problemSeed"] if item else base + cycle * games + i,
                "continuationSeed": base + 200000 + cycle * games + i,
                "team": item["neuralTeam"] if item else i % 2,
                "mode": item["opponent"] if item else ["self", "snapshot", "rule"][i % 3],
                "review": item is not None,
            }
        )
    return result


def execute(command, log):
    env = dict(os.environ)
    env.pop("PPO_ACTOR", None)
    with Path(log).open("w", encoding="utf-8") as stream:
        r = subprocess.run(
            command,
            cwd=ROOT,
            env=env,
            stdout=stream,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    if r.returncode:
        raise RuntimeError(f"Experiment failed: {log}")


def read(path):
    return json.loads(Path(path).read_text())


def main(args):
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    initial = Path(args.initial).resolve()
    opponent = Path(args.opponent_model).resolve()
    if (
        args.seed + args.cycles * args.games >= args.eval_seed
        or args.seed + 200000 + args.cycles * args.games >= args.eval_seed
    ):
        raise ValueError("Training, continuation and evaluation seeds overlap")
    paths = {}
    records = {}
    model = {}
    history = {name: [] for name in ARMS}
    anchor = initial / "policy.onnx"
    for name, (private, review) in ARMS.items():
        directory = output / name
        directory.mkdir()
        paths[name] = directory
        start = directory / "initial"
        start.mkdir()
        shutil.copy2(initial / "full.npz", start / "actor.npz")
        export_model(start / "policy.onnx", load_parameters(start / "actor.npz")[0])
        save_critic(start / "critic.npz", initialize_critic())
        (start / "config.json").write_text(
            json.dumps(
                {
                    "kind": "full-actor-asymmetric-ppo",
                    "privilegedCritic": private,
                    "temperature": 0.03,
                    "anchor": str(anchor),
                    "anchorSHA256": sha(anchor),
                },
                indent=2,
            )
        )
        model[name] = start
        records[name] = {
            "args": vars(args),
            "arm": name,
            "privilegedCritic": private,
            "openingReview": review,
            "status": "running",
            "cycles": [],
            "startedUTC": datetime.now(timezone.utc).isoformat(),
            "publication": "Research only; publish checkpoints separately from default web model",
        }

    def save():
        for name in ARMS:
            (paths[name] / "run.json").write_text(
                json.dumps(records[name], indent=2), encoding="utf-8"
            )

    save()
    try:
        for cycle in range(args.cycles):
            jobs = []
            for name, (_, review) in ARMS.items():
                d = paths[name] / f"cycle-{cycle+1:02}"
                d.mkdir()
                plan = collection_plan(args.seed, cycle, args.games, review, history[name])
                (d / "plan.json").write_text(json.dumps(plan, indent=2))
                records[name]["cycles"].append(
                    {
                        "cycle": cycle + 1,
                        "stage": "full-public-actor",
                        "status": "collecting",
                        "initialActorSHA256": sha(model[name] / "actor.npz"),
                    }
                )
                command = [
                    "node",
                    "scripts/collect-team.mjs",
                    f'--plan={d / "plan.json"}',
                    f'--output={d / "data"}',
                    f"--model={model[name]}",
                    f"--opponent-model={opponent}",
                    f"--seed={args.seed+400000+cycle*args.games}",
                ]
                jobs.append((name, command, d))
            save()
            print(
                json.dumps(
                    {
                        "cycle": cycle + 1,
                        "phase": "four-arm collection",
                        "matchesPerArm": args.games,
                    }
                ),
                flush=True,
            )
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda j: execute(j[1], j[2] / "collection.log"), jobs))
            if cycle == 0 and len({sha(j[2] / "data/matches.jsonl") for j in jobs}) != 1:
                raise ValueError(
                    "Matched initial actors produced different trajectories; inspect information boundaries"
                )
            for name, _, d in jobs:
                records[name]["cycles"][-1]["status"] = "updating"
            save()
            with ThreadPoolExecutor(max_workers=2) as pool:
                list(
                    pool.map(
                        lambda j: execute(
                            [
                                sys.executable,
                                "scripts/train_team.py",
                                str(j[2] / "data"),
                                f'--output={j[2]/"model"}',
                                f"--epochs={args.epochs}",
                            ],
                            j[2] / "training.log",
                        ),
                        jobs,
                    )
                )
            for name, _, d in jobs:
                model[name] = d / "model"
                history[name] += [
                    json.loads(s) for s in (d / "data/matches.jsonl").read_text().splitlines()
                ]
                records[name]["cycles"][-1]["status"] = (
                    "evaluating"
                    if (cycle + 1) % args.eval_every == 0 or cycle + 1 == args.cycles
                    else "complete"
                )
            save()
            if (cycle + 1) % args.eval_every == 0 or cycle + 1 == args.cycles:
                evaluation_jobs = []
                for name, _, d in jobs:
                    for kind in ["rule", "snapshot"]:
                        command = [
                            "node",
                            "scripts/collect-matches.mjs",
                            f"--matches={args.eval_pairs*2}",
                            f"--seed={args.eval_seed}",
                            "--evaluate=1",
                            "--inference-script=scripts/full_learning.py",
                            f'--model={model[name]/"policy.onnx"}',
                            f'--output={d/ ("evaluation-"+kind)}',
                        ]
                        if kind == "snapshot":
                            command += [
                                "--evaluate-opponent=snapshot",
                                f"--opponent-model={opponent}",
                            ]
                        evaluation_jobs.append((command, d / f"evaluation-{kind}.log"))
                with ThreadPoolExecutor(max_workers=4) as pool:
                    list(pool.map(lambda j: execute(j[0], j[1]), evaluation_jobs))
                for name, _, d in jobs:
                    records[name]["cycles"][-1].update(
                        status="complete",
                        evaluations={
                            k: {
                                "wins": read(d / f"evaluation-{k}/rollout.json")["wins"],
                                "matches": args.eval_pairs * 2,
                            }
                            for k in ["rule", "snapshot"]
                        },
                    )
            save()
            print(json.dumps({"cycle": cycle + 1, "phase": "complete"}), flush=True)
        for name in ARMS:
            records[name]["status"] = "complete"
    except BaseException as error:
        for name in ARMS:
            records[name].update(status="failed", error=str(error))
        raise
    finally:
        save()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output", required=True)
    p.add_argument("--initial", required=True)
    p.add_argument("--opponent-model", required=True)
    p.add_argument("--cycles", type=int, default=2)
    p.add_argument("--games", type=int, default=16)
    p.add_argument("--epochs", type=int, default=2)
    p.add_argument("--seed", type=int, default=61000104)
    p.add_argument("--eval-seed", type=int, default=62000104)
    p.add_argument("--eval-pairs", type=int, default=16)
    p.add_argument("--eval-every", type=int, default=2)
    a = p.parse_args()
    if (
        not 1 <= a.cycles <= 32
        or not 6 <= a.games <= 1000
        or a.eval_pairs < 2
        or a.eval_every < 1
        or not 1 <= a.epochs <= 4
    ):
        raise ValueError("Invalid bounded study")
    main(a)
