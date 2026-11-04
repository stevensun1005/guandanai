"""Publish completed experiment evidence; never change model weights or claim held-out gains."""

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
PAPER = Path("docs/MODEL_STUDY.md")
EVIDENCE = Path("docs/evaluation/model-study-progress.json")
START, END = "<!-- experiment-progress:start -->", "<!-- experiment-progress:end -->"
RUNS = {
    "ppo-rule": "full-match-training",
    "ppo-mixed": "match-selfplay-training",
    "full-rejected": "complete-network/training",
    "full-guarded": "complete-network/training-guarded",
    **{
        f"team-{arm}": f"asymmetric-pilot/{arm}"
        for arm in ["a-public-fresh", "b-public-review", "c-private-fresh", "d-private-review"]
    },
    **{
        f"team-extended-{arm}": f"asymmetric-next/{arm}"
        for arm in ["a-public-fresh", "b-public-review", "c-private-fresh", "d-private-review"]
    },
}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def evaluation(directory):
    manifest = read(directory / "rollout.json")
    rows = [
        json.loads(line)
        for line in (directory / "matches.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    if (
        not rows
        or manifest.get("status") != "complete"
        or len(rows) != manifest["completedGames"]
        or len(rows) != manifest["games"]
    ):
        raise ValueError(f"Incomplete evaluation: {directory}")
    pairs = defaultdict(list)
    for row in rows:
        if row["winner"] not in (None, 0, 1) or row["neuralTeam"] not in (0, 1):
            raise ValueError("Invalid team outcome")
        pairs[row["seed"]].append(row)
    paired = not any(
        len(group) != 2 or {r["neuralTeam"] for r in group} != {0, 1} for group in pairs.values()
    )
    greedy = manifest.get("evaluate") is True
    if greedy and not paired:
        raise ValueError("Evaluation needs both team assignments for each seed")
    wins = sum(r["winner"] is not None and r["winner"] == r["neuralTeam"] for r in rows)
    draws = sum(r["winner"] is None for r in rows)
    if wins != manifest["wins"] or draws != manifest["draws"]:
        raise ValueError("Aggregate outcome does not match raw records")
    values = [
        sum(r["winner"] is not None and r["winner"] == r["neuralTeam"] for r in group) / 2
        for group in pairs.values()
    ]
    mean = wins / len(rows)
    # Independent seed clusters, not the two correlated matches within each cluster.
    radius = math.sqrt(math.log(40) / (2 * len(values)))
    return {
        "role": "development; repeatedly reused for selection",
        "greedyProtocol": greedy,
        "matches": len(rows),
        "pairs": len(pairs) if paired else None,
        "wins": wins,
        "draws": draws,
        "losses": len(rows) - wins - draws,
        "winRate": mean,
        "seedRange": [min(pairs), max(pairs)],
        "clusterHoeffding95CI": [max(0, mean - radius), min(1, mean + radius)]
        if paired and greedy
        else None,
        "manifestSHA256": digest(directory / "rollout.json"),
        "recordsSHA256": digest(directory / "matches.jsonl"),
        "opponentSHA256": manifest.get("opponentSHA256"),
        "sourceSHA256": manifest.get("sourceSHA256", {}),
        "seedResults": [
            {
                "seed": seed,
                "matches": len(group),
                "wins": sum(
                    r["winner"] is not None and r["winner"] == r["neuralTeam"] for r in group
                ),
                "draws": sum(r["winner"] is None for r in group),
            }
            for seed, group in sorted(pairs.items())
        ],
    }


def snapshot(workspace):
    result = {
        "schema": 1,
        "reportGeneratorSHA256": SCRIPT_SHA256,
        "metric": "Whole-match team wins / all matches; draws included",
        "finalHeldoutCompleted": False,
        "target80Validated": False,
        "onlineModels": {
            name: {"sha256": digest(ROOT / "ai" / name)}
            for name in ["policy.onnx", "response.onnx"]
        },
        "runs": {},
    }
    for name, relative in RUNS.items():
        directory = workspace / "work/learning" / relative
        run = read(directory / "run.json")
        item = {"status": run["status"], "cycles": [], "plannedCycles": run["args"]["cycles"]}
        for entry in run["cycles"]:
            if entry["status"] != "complete":
                continue
            cycle = directory / f"cycle-{entry['cycle']:02}"
            training = read(cycle / "model/training.json")
            sources = sorted(cycle.glob("actor-*/rollout.json")) or [cycle / "data/rollout.json"]
            manifests = [read(p) for p in sources]
            if any(m["status"] != "complete" for m in manifests):
                raise ValueError("Completed update has incomplete collection evidence")
            record = {
                "cycle": entry["cycle"],
                "stage": entry.get("stage", "small-actor"),
                "matchesUsed": sum(m["completedGames"] for m in manifests),
                "rounds": sum(m["rounds"] for m in manifests),
                "decisions": sum(m["decisions"] for m in manifests),
                "afterFirstOutDecisions": sum(m["afterFirstOutDecisions"] for m in manifests),
                "trainingReportSHA256": digest(cycle / "model/training.json"),
                "trainingSelection": entry.get("trainingSelection"),
                "evaluations": {},
            }
            team = name.startswith("team-")
            checkpoint = cycle / (
                "model/actor.npz"
                if team
                else "model/full.npz"
                if name.startswith("full-")
                else "model/ppo.npz"
            )
            record["checkpointSHA256"] = digest(checkpoint)
            expected = training.get("checkpointSHA256") or training.get("model", {}).get("sha256")
            if not expected or expected != record["checkpointSHA256"]:
                raise ValueError(f"Checkpoint changed after training: {checkpoint}")
            record["trainableParameters"] = training["trainableParameters"]
            if team:
                record["publishedTrainingReportSHA256"] = hashlib.sha256(
                    (cycle / "model/training.json").read_text(encoding="utf-8").encode("utf-8")
                ).hexdigest()
                record.update(
                    actorParameters=training["actorParameters"],
                    criticParameters=training["criticParameters"],
                    reviewMatches=sum(m["reviewMatches"] for m in manifests),
                )
                rows = [
                    json.loads(s) for s in (cycle / "data/matches.jsonl").read_text().splitlines()
                ]
                record["openingProblems"] = [
                    {
                        "seed": r["problemSeed"],
                        "team": r["neuralTeam"],
                        "review": r["review"],
                        "continuationSeed": r["seed"],
                    }
                    for r in rows
                ]
                record["criticSHA256"] = training["criticSHA256"]
                record["actionRows"] = read(sources[0].with_name("metadata.json"))["actionRows"]
            record["hyperparameters"] = {
                k: v
                for k, v in training.get("args", {}).items()
                if k
                in {
                    "epochs",
                    "batch",
                    "learning_rate",
                    "extra_learning_rate",
                    "anchor_weight",
                    "stage",
                    "seed",
                    "threads",
                    "clip",
                    "entropy",
                    "reference_kl",
                    "max_kl",
                }
            }
            record["collectionSeeds"] = [
                {"start": m["seed"], "matches": m["completedGames"]} for m in manifests
            ]
            metadata = read(sources[0].with_name("metadata.json"))
            record["sourceSHA256"] = metadata.get(
                "sourceSHA256",
                {k: v for k, v in metadata.get("config", {}).items() if k.endswith("SHA256")},
            )
            if name.startswith("full-") or team:
                record["parameterChanges"] = {
                    k: v["changed"] for k, v in training["parameterUpdates"].items()
                }
                for kind in entry.get("evaluations", {}):
                    record["evaluations"][kind] = evaluation(cycle / f"evaluation-{kind}")
            elif entry.get("evaluation"):
                record["evaluations"]["rule"] = evaluation(cycle / "evaluation")
            item["cycles"].append(record)
        result["runs"][name] = item
    return result


def progress(data):
    lines = [
        "## 11. 自动同步的完整比赛进展",
        "",
        f"证据快照更新时间：{data['observedUTC']}。下表仅统计已完成更新；采样中、更新中或评测未结束的周期不计入。",
        "",
        "**以下全部为开发集，不是独立验收。** 模型挑选反复使用这些种子，不能据此认定已经达到 80% 或有泛化提升。",
        "",
        "| 实验 | 完成更新 | 用于更新的完整比赛 | 学习决策 | 头游后决策 | 运行状态 |",
        "| --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for name, run in data["runs"].items():
        cycles = run["cycles"]
        totals = [
            sum(c[key] for c in cycles)
            for key in ["matchesUsed", "decisions", "afterFirstOutDecisions"]
        ]
        lines.append(
            f"| `{name}` | {len(cycles)} / {run['plannedCycles']} | {totals[0]} | {totals[1]} | {totals[2]} | `{run['status']}` |"
        )
    lines += [
        "",
        "### 11.1 全部已完成的开发评测",
        "",
        "| 实验／周期 | 更新阶段 | 对手 | 胜／总场 | 平局 | 胜率 | 后续训练选择 |",
        "| --- | --- | --- | ---: | ---: | ---: | --- |",
    ]
    for name, run in data["runs"].items():
        for cycle in run["cycles"]:
            for opponent, e in cycle["evaluations"].items():
                label = "" if e["greedyProtocol"] else "（旧协议，非贪心）"
                selection = cycle["trainingSelection"] or "无自动筛选记录"
                lines.append(
                    f"| `{name}` / {cycle['cycle']:02} | {cycle['stage']} | {opponent}{label} | {e['wins']} / {e['matches']} | {e['draws']} | {e['winRate']:.2%} | `{selection}` |"
                )
    lines += [
        "",
        "表中的 `snapshot` 指该实验冻结的历史对手；各实验的历史对手不保证相同，不能横向直接比较。`ppo-rule` 早期未标记贪心评测的结果保留为旧协议记录，不纳入同协议排名。",
        "",
        "原始逐场记录的 SHA-256、检查点与训练报告 SHA-256、种子范围及聚类区间见[机器可读快照](evaluation/model-study-progress.json)。研究权重见[成果目录](evaluation/model-artifacts.json)和 `ai/experiments/`；原始大型缓冲区仍在本地 `work/`，不能把检查点公开等同于全部训练数据公开。",
        "",
        "自动更新同时保存已完成周期的检查点到 `ai/experiments/asymmetric-pilot/` 和 `ai/experiments/asymmetric-next/`，不修改网页默认模型清单。新留出测试完成后须人工审核结论；脚本不会把开发集峰值自动改写成通过验收。",
    ]
    return "\n".join(lines)


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def update(workspace, publish=False):
    if publish:
        if git("status", "--porcelain"):
            raise RuntimeError("Documentation checkout must be clean before automatic publication")
        git("fetch", "origin", "main")
        git("merge", "--ff-only", "origin/main")
        if digest(__file__) != SCRIPT_SHA256:
            raise RuntimeError("Reporter source changed remotely; restart before publishing")
    data = snapshot(workspace)
    fingerprint = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    previous = read(ROOT / EVIDENCE) if (ROOT / EVIDENCE).exists() else {}
    if previous.get("fingerprint") == fingerprint:
        return False, all(r["status"] != "running" for r in data["runs"].values())
    paper = (ROOT / PAPER).read_text(encoding="utf-8")
    for artifact in data["onlineModels"].values():
        if artifact["sha256"] not in paper:
            raise ValueError(
                "Online artifact changed: manually revise architecture and deployment claims first"
            )
    if paper.count(START) != 1 or paper.count(END) != 1:
        raise ValueError("Paper must contain exactly one generated progress section")
    data.update(fingerprint=fingerprint, observedUTC=datetime.now(timezone.utc).isoformat())
    artifacts = []
    for name, run in data["runs"].items():
        if not name.startswith("team-"):
            continue
        for cycle in run["cycles"]:
            source = (
                workspace / "work/learning" / RUNS[name] / f"cycle-{cycle['cycle']:02}" / "model"
            )
            destination = Path("ai/experiments") / RUNS[name] / f"cycle-{cycle['cycle']:02}"
            (ROOT / destination).mkdir(parents=True, exist_ok=True)
            for file in ["actor.npz", "critic.npz", "policy.onnx"]:
                shutil.copy2(source / file, ROOT / destination / file)
                artifacts.append(str(destination / file))
            (ROOT / destination / "training.json").write_bytes(
                (source / "training.json").read_text(encoding="utf-8").encode("utf-8")
            )
            artifacts.append(str(destination / "training.json"))
            config = read(source / "config.json")
            anchor = Path("ai/experiments") / Path(RUNS[name]).parent / "anchor/policy.onnx"
            (ROOT / anchor).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(config["anchor"], ROOT / anchor)
            if digest(ROOT / anchor) != config["anchorSHA256"]:
                raise ValueError("Experimental anchor changed")
            config["anchor"] = anchor.as_posix()
            (ROOT / destination / "config.json").write_bytes(
                (json.dumps(config, indent=2) + "\n").encode("utf-8")
            )
            artifacts.extend([str(anchor), str(destination / "config.json")])
    (ROOT / EVIDENCE).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    before, tail = paper.split(START)
    _, after = tail.split(END)
    (ROOT / PAPER).write_text(
        before + START + "\n\n" + progress(data) + "\n\n" + END + after, encoding="utf-8"
    )
    subprocess.run(
        [
            "npx.cmd" if __import__("os").name == "nt" else "npx",
            "prettier",
            "--write",
            str(PAPER),
            str(EVIDENCE),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    if publish:
        git("add", str(PAPER), str(EVIDENCE), *artifacts)
        git("commit", "-m", "docs: update completed model experiment evidence")
        git("push", "origin", "HEAD:main")
    print(
        json.dumps({"updated": True, "fingerprint": fingerprint, "published": publish}), flush=True
    )
    return True, all(r["status"] != "running" for r in data["runs"].values())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--watch-minutes", type=int, default=0)
    args = parser.parse_args()
    if not 0 <= args.watch_minutes <= 180:
        raise ValueError("Watch duration must be bounded to 0..180 minutes")
    deadline = time.monotonic() + args.watch_minutes * 60
    while True:
        try:
            changed, finished = update(args.workspace.resolve(), args.publish)
        except (json.JSONDecodeError, FileNotFoundError) as error:
            if not args.watch_minutes:
                raise
            print(json.dumps({"waitingForEvidence": type(error).__name__}), flush=True)
            changed = finished = (
                False  # A collector may be between writing its manifest and final record.
            )
        if not args.watch_minutes or finished or time.monotonic() >= deadline:
            if args.watch_minutes and not finished:
                raise SystemExit("Watch deadline reached; some experiments are still pending")
            break
        time.sleep(60)
