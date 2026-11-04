"""Run bounded, sequential local policy updates with fresh games and development evaluation."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--proposal", required=True)
    parser.add_argument("--actor")
    parser.add_argument("--objective", choices=["round", "full-match"], default="round")
    parser.add_argument("--cycles", type=int, default=8)
    parser.add_argument("--games", type=int, default=1000)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--k", type=int, choices=[2, 4], default=2)
    parser.add_argument("--temperature", type=float, default=0.15)
    parser.add_argument("--opponent-model")
    parser.add_argument("--opponent", choices=["rule", "mixed", "self"], default="rule")
    parser.add_argument("--eval-every", type=int, default=2)
    parser.add_argument("--eval-pairs", type=int, default=300)
    parser.add_argument("--eval-seed", type=int, default=21200104)
    args = parser.parse_args()
    if not 1 <= args.cycles <= 100 or not 1 <= args.games <= 10000 or args.eval_every < 1:
        raise ValueError("Invalid bounded training plan")
    if max(args.seed, args.eval_seed) < min(
        args.seed + args.cycles * args.games, args.eval_seed + args.eval_pairs
    ):
        raise ValueError("Training and evaluation seed ranges overlap")
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    proposal = Path(args.proposal).resolve()
    actor = str(Path(args.actor).resolve()) if args.actor else None
    record = {
        "args": vars(args),
        "status": "running",
        "cycles": [],
        "startedUTC": datetime.now(timezone.utc).isoformat(),
    }

    def save():
        (output / "run.json").write_text(json.dumps(record, indent=2), encoding="utf-8")

    def run(command, log, env):
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
            raise RuntimeError(f"Command failed ({result.returncode}); see {log}")

    save()
    try:
        for cycle in range(args.cycles):
            directory = output / f"cycle-{cycle + 1:02}"
            directory.mkdir()
            env = dict(os.environ, PPO_K=str(args.k), PPO_TEMPERATURE=str(args.temperature))
            env.pop("PPO_ACTOR", None)
            if actor:
                env["PPO_ACTOR"] = actor
            entry = {
                "cycle": cycle + 1,
                "seed": args.seed + cycle * args.games,
                "actorBefore": actor,
                "status": "collecting",
            }
            record["cycles"].append(entry)
            save()
            print(json.dumps(entry), flush=True)
            if args.objective == "full-match":
                collect = [
                    "node",
                    "scripts/collect-matches.mjs",
                    f"--matches={args.games}",
                    f"--opponent={args.opponent}",
                    f"--seed={entry['seed']}",
                    f"--model={proposal}",
                    f"--output={directory / 'data'}",
                ]
            else:
                collect = [
                    "node",
                    "scripts/collect-policy.mjs",
                    f"--games={args.games}",
                    f"--seed={entry['seed']}",
                    f"--opponent={args.opponent}",
                    "--epsilon=0",
                    "--inference-script=scripts/ppo_learning.py",
                    f"--model={proposal}",
                    f"--output={directory / 'data'}",
                ]
            if args.objective == "full-match" and args.opponent_model:
                collect.append(f"--opponent-model={Path(args.opponent_model).resolve()}")
            run(collect, directory / "collection.log", env)
            entry["status"] = "updating"
            save()
            run(
                [
                    sys.executable,
                    "scripts/train_ppo.py",
                    str(directory / "data"),
                    "--output",
                    str(directory / "model"),
                ],
                directory / "training.log",
                env,
            )
            actor = str(directory / "model/ppo.npz")
            entry["actorAfter"] = actor
            if (cycle + 1) % args.eval_every == 0 or cycle + 1 == args.cycles:
                entry["status"] = "evaluating"
                save()
                env.pop("PPO_ACTOR", None)
                if args.objective == "full-match":
                    run(
                        [
                            "node",
                            "scripts/collect-matches.mjs",
                            f"--matches={args.eval_pairs * 2}",
                            f"--seed={args.eval_seed}",
                            "--evaluate=1",
                            f"--model={actor}",
                            f"--output={directory / 'evaluation'}",
                        ],
                        directory / "evaluation.log",
                        env,
                    )
                    entry["evaluation"] = json.loads(
                        (directory / "evaluation/rollout.json").read_text(encoding="utf-8")
                    )
                    entry["evaluation"]["winRate"] = (
                        entry["evaluation"]["wins"] / entry["evaluation"]["completedGames"]
                    )
                    entry["evaluation"]["metric"] = (
                        "Whole-match team wins / all matches, including draws"
                    )
                else:
                    run(
                        [
                            "node",
                            "scripts/evaluate-trained.mjs",
                            f"--pairs={args.eval_pairs}",
                            f"--seed={args.eval_seed}",
                            "--opponent=rule",
                            "--inference-script=scripts/ppo_learning.py",
                            f"--model={actor}",
                            f"--output={directory / 'evaluation'}",
                        ],
                        directory / "evaluation.log",
                        env,
                    )
                    entry["evaluation"] = json.loads(
                        (directory / "evaluation/summary.json").read_text(encoding="utf-8")
                    )
            entry["status"] = "complete"
            save()
            print(
                json.dumps(
                    {
                        "cycle": cycle + 1,
                        "status": "complete",
                        "actor": actor,
                        "developmentWinRate": entry.get("evaluation", {}).get("winRate"),
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
