"""Publish completed experiment evidence; never change model weights or claim held-out gains."""

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import time

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
SCRIPT_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
PAPER = Path("ai/research/MODEL_STUDY.md")
EVIDENCE = Path("ai/research/evaluation/model-study-progress.json")
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


def continuous_evaluation(path, kind):
    """Audit real paired outcomes, including partial runs, before summarizing them."""
    report = read(path)
    if report.get("kind", kind) != kind:
        raise ValueError("Continuous evaluation kind mismatch")
    pairs = report["pairs"]
    first = report["firstSeed"]
    low, high = (
        (3_600_000_000, 3_700_000_000) if kind == "anchor" else (3_500_000_000, 3_600_000_000)
    )
    if not isinstance(first, int) or not low <= first < high or first + len(pairs) > high:
        raise ValueError("Continuous evaluation seed purpose mismatch")
    scores = []
    for index, pair in enumerate(pairs):
        if (
            pair["seed"] != first + index
            or len(pair["scores"]) != 2
            or any(isinstance(score, bool) or score not in (0, 0.5, 1) for score in pair["scores"])
        ):
            raise ValueError("Continuous evaluation needs complete swapped seed pairs")
        scores.extend(pair["scores"])
    wins, losses, draws = (scores.count(value) for value in (1, 0, 0.5))
    if (wins, losses, draws) != tuple(report[key] for key in ("wins", "losses", "draws")):
        raise ValueError("Continuous aggregate differs from paired outcomes")
    complete = report["status"] == "complete"
    if complete and (not pairs or (kind == "anchor" and len(pairs) != 150)):
        raise ValueError("Incomplete fixed-size anchor check")
    mean = (wins + draws * 0.5) / len(scores) if scores else None
    radius = math.sqrt(math.log(40) / (2 * len(pairs))) if pairs else None
    for model in ("challenger", "champion"):
        value = report[model]["sha256"]
        if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise ValueError("Invalid continuous model fingerprint")
    return {
        "role": "development monitoring; not held-out acceptance",
        "kind": kind,
        "status": report["status"],
        "protocol": report["protocol"],
        "rules": report.get("rules", {"tribute": True, "aFail": "draw"}),
        "metric": "Team match score: win 1, draw 0.5, loss 0",
        "challenger": report["challenger"],
        "champion": report["champion"],
        "pairs": len(pairs),
        "matches": len(scores),
        "wins": wins,
        "losses": losses,
        "draws": draws,
        "seedRange": [first, first + len(pairs) - 1] if pairs else None,
        "meanScore": mean,
        "clusterHoeffding95CI": [max(0, mean - radius), min(1, mean + radius)] if pairs else None,
        "llr": (report.get("test") or {}).get("llr"),
        "decision": report.get("decision") if complete else None,
        "settings": report["settings"],
        "sourceSHA256": report.get("sourceSHA256", {}),
        "recordsSHA256": digest(path),
        "recordsFile": f"{kind}/{path.name}",
        "seedResults": pairs,
    }


def actor_totals(directory, fallback):
    """Sum every actor-<slot>.json, including actors on other machines that share the run folder.

    The supervisor's own status only counts its local slots, so remote sampling would be missing.
    """
    actors = directory / "actors"
    files = sorted(actors.glob("actor-*.json")) if actors.exists() else []
    if not files:
        return dict(fallback), []
    totals = {"matches": 0, "decisions": 0, "rows": 0}
    slots = []
    for path in files:
        try:
            data = read(path)
        except (OSError, ValueError):
            continue
        slots.append(int(path.stem.split("-")[1]))
        for key in totals:
            totals[key] += int(data.get(key) or 0)
    return totals, sorted(slots)


def remote_hosts(directory):
    actors = directory / "actors"
    hosts = {}
    for path in sorted(actors.glob("claim-*.json")) if actors.exists() else []:
        try:
            claim = read(path)
        except (OSError, ValueError):
            continue
        hosts.setdefault(claim.get("host"), []).append(claim.get("slot"))
    return {host: sorted(s for s in slots if s is not None) for host, slots in hosts.items()}


def continuous_snapshot(directory):
    config = read(directory / "config.json")
    status = read(directory / "status.json") if (directory / "status.json").exists() else {}
    champion = read(directory / "champion/champion.json")
    gates = [
        continuous_evaluation(p, "gate") for p in sorted((directory / "gate").glob("gate-*.json"))
    ]
    anchors = [
        continuous_evaluation(p, "anchor")
        for p in sorted((directory / "anchor").glob("anchor-*.json"))
    ]
    totals, slots = actor_totals(directory, status.get("totals", {}))
    history = []
    for entry in champion.get("history", []):
        gate = next(
            (g for g in gates if Path(g["recordsFile"]).stem == f"gate-{entry.get('gate', -1):05}"),
            None,
        )
        history.append(
            {
                **entry,
                "sha256": entry.get("sha256")
                or (
                    gate["challenger"]["sha256"]
                    if gate
                    else config["initialSHA256"]
                    if entry.get("reason") == "initial"
                    else None
                ),
            }
        )
    return {
        "role": "development training and monitoring; not held-out acceptance",
        "status": "stopped"
        if status.get("stoppedAt")
        else "running"
        if status.get("running")
        else "initializing",
        "config": config,
        "startedAt": status.get("startedAt", config["createdAt"]),
        "updatedAt": status.get("updatedAt"),
        "stoppedAt": status.get("stoppedAt"),
        "stopReason": status.get("stopReason"),
        "elapsedSeconds": status.get("elapsedSeconds"),
        "totals": totals,
        "actorSlots": slots,
        "remoteActorHosts": remote_hosts(directory),
        "supervisorLocalTotals": status.get("totals", {}),
        "learner": status.get("learner", {}),
        "latest": status.get("latest"),
        "champion": {**champion, "history": history},
        "sourceSHA256": config.get("sourceSHA256", {}),
        "statusSHA256": digest(directory / "status.json") if status else None,
        "eventsSHA256": digest(directory / "events.jsonl")
        if (directory / "events.jsonl").exists()
        else None,
        "gates": gates,
        "anchorChecks": anchors,
        "anchorRegressionStreak": status.get("anchorRegressionStreak", 0),
        "rawEvidence": "Per-seed records remain under the ignored run directory; hashes above identify their exact contents",
    }


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
            name: {"sha256": digest(ROOT / "ai/danMCai/models/baseline" / name)}
            for name in ["policy.onnx", "response.onnx"]
        },
        "runs": {},
        "continuousRuns": {},
    }
    for name, relative in RUNS.items():
        directory = workspace / "ai/danMCai/data/generated" / relative
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
    continuous = workspace / "ai/danMCai/runs"
    if continuous.exists():
        for directory in sorted(continuous.iterdir()):
            if directory.is_dir() and (directory / "config.json").exists():
                result["continuousRuns"][directory.name] = continuous_snapshot(directory)
    return result


def experiments_finished(data):
    return all(r["status"] != "running" for r in data["runs"].values()) and all(
        r["status"] == "stopped" for r in data.get("continuousRuns", {}).values()
    )


def publication_signal(workspace):
    """Read small completion records; avoid rehashing all historical checkpoints every minute."""
    signal = {}
    for name, relative in RUNS.items():
        path = workspace / "ai/danMCai/data/generated" / relative / "run.json"
        if path.exists():
            run = read(path)
            signal[name] = {
                "status": run["status"],
                "completed": [c["cycle"] for c in run["cycles"] if c["status"] == "complete"],
            }
    continuous = workspace / "ai/danMCai/runs"
    if continuous.exists():
        for directory in sorted(continuous.iterdir()):
            if not directory.is_dir() or not (directory / "config.json").exists():
                continue
            status = read(directory / "status.json") if (directory / "status.json").exists() else {}
            champion = read(directory / "champion/champion.json")
            completed = []
            for kind in ("gate", "anchor"):
                for path in sorted((directory / kind).glob(f"{kind}-*.json")):
                    if read(path)["status"] in ("complete", "stopped"):
                        completed.append((kind, path.name, digest(path)))
            signal[f"continuous/{directory.name}"] = {
                "stoppedAt": status.get("stoppedAt"),
                "stopReason": status.get("stopReason"),
                "champion": [champion.get("version"), champion.get("sha256")],
                "completed": completed,
            }
    return signal


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
        "原始逐场记录的 SHA-256、检查点与训练报告 SHA-256、种子范围及聚类区间见[机器可读快照](evaluation/model-study-progress.json)。研究权重见[成果目录](evaluation/model-artifacts.json)和 `ai/danMCai/models/experiments/`；原始大型缓冲区仍在本地 `ai/danMCai/workspace/`，不能把检查点公开等同于全部训练数据公开。",
        "",
        "自动更新只写研究报告和证据 JSON，不再复制或提交权重。历史已归档检查点保留；新权重留在本地，需要公开时通过 Release 附件及 SHA-256 索引归档。网页默认模型清单不变。",
    ]
    if data.get("continuousRuns"):
        lines += [
            "",
            "### 11.2 持续训练与锚点监控（开发用途）",
            "",
            "胜／负／平按实际完成的成对比赛统计；得分为胜 1、平 0.5、负 0，不等于胜率。未完成检查不用于冠军晋升或连续退步停止。区间按种子簇计算，不提供反复监控的整体误报保证。",
            "",
        ]
        for name, run in data["continuousRuns"].items():
            totals, learner = run["totals"], run["learner"] or {}
            hours = (
                f"{run['elapsedSeconds'] / 3600:.3f}"
                if run["elapsedSeconds"] is not None
                else "尚无累计计时"
            )
            lines += [
                f"#### `{name}`",
                "",
                f"状态 `{run['status']}`；累计运行 {hours} 小时；采样 {totals.get('matches', 0)} 场、{totals.get('decisions', 0)} 个决策；学习器 {learner.get('step', 0)} 步。停止原因：`{run['stopReason'] or '无'}`。",
                "",
                f"当前冠军 `{run['champion']['version']}`，SHA-256 `{run['champion']['sha256']}`；含初始版本共 {len(run['champion']['history'])} 条冠军历史，完整指纹与配置见 JSON。",
                "",
                "| 类型 | 挑战者／对手 SHA | 完成状态 | 对数 | 胜／负／平 | 得分 | 种子簇 95% 区间 | LLR | 结论 |",
                "| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- |",
            ]
            for kind, checks in [("门控", run["gates"]), ("锚点", run["anchorChecks"])]:
                for check in checks:
                    score = f"{check['meanScore']:.4f}" if check["meanScore"] is not None else "—"
                    ci = check["clusterHoeffding95CI"]
                    bounds = f"[{ci[0]:.4f}, {ci[1]:.4f}]" if ci else "—"
                    identities = " / ".join(
                        f"`{check[side].get('version') or Path(check[side]['file']).stem}` ({check[side]['sha256'][:12]})"
                        for side in ("challenger", "champion")
                    )
                    lines.append(
                        f"| {kind} | {identities} | `{check['status']}` | {check['pairs']} | {check['wins']}/{check['losses']}/{check['draws']} | {score} | {bounds} | {check['llr'] if check['llr'] is not None else '—'} | `{check['decision'] or '未完成'}` |"
                    )
            lines += [
                "",
                "最新模型与初始 P0 的锚点检查固定 150 对；连续两次完整检查的 Hoeffding 区间上限低于 0.5 时停止。采样含探索，对局统计不能当作棋力验收。",
                "",
            ]
    return "\n".join(lines)


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def publication_checks():
    npm = "npm.cmd" if __import__("os").name == "nt" else "npm"
    for command in (
        [npm, "test"],
        [npm, "run", "format:check"],
        [sys.executable, "-m", "unittest", "discover", "-s", "web/tests", "-p", "model_study_test.py"],
        [sys.executable, "ai/danMCai/tests/continuous_learner_test.py"],
    ):
        subprocess.run(command, cwd=ROOT, check=True, capture_output=True)
    allowed = {PAPER.as_posix(), EVIDENCE.as_posix()}
    if set(git("diff", "--name-only").splitlines()) - allowed or git(
        "ls-files", "--others", "--exclude-standard"
    ):
        raise RuntimeError("Publication checks found unrelated changes; refusing to stage them")
    if any((ROOT / file).stat().st_size > 5_000_000 for file in (PAPER, EVIDENCE)):
        raise RuntimeError(
            "Evidence is too large for automatic Git publication; archive raw records separately"
        )


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
        return False, experiments_finished(data)
    paper = (ROOT / PAPER).read_text(encoding="utf-8")
    for artifact in data["onlineModels"].values():
        if artifact["sha256"] not in paper:
            raise ValueError(
                "Online artifact changed: manually revise architecture and deployment claims first"
            )
    if paper.count(START) != 1 or paper.count(END) != 1:
        raise ValueError("Paper must contain exactly one generated progress section")
    data.update(fingerprint=fingerprint, observedUTC=datetime.now(timezone.utc).isoformat())
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
        publication_checks()
        git("add", str(PAPER), str(EVIDENCE))
        git("commit", "-m", "web/docs: update completed model experiment evidence")
        git("push", "origin", "HEAD:main")
    print(
        json.dumps({"updated": True, "fingerprint": fingerprint, "published": publish}), flush=True
    )
    return True, experiments_finished(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--watch-minutes", type=int, default=0)
    parser.add_argument("--interval-seconds", type=int, default=60)
    args = parser.parse_args()
    if not 0 <= args.watch_minutes <= 1500:
        raise ValueError("Watch duration must be bounded to 0..1500 minutes")
    if not 30 <= args.interval_seconds <= 3600:
        raise ValueError("Report interval must be bounded to 30..3600 seconds")
    deadline = time.monotonic() + args.watch_minutes * 60
    last_signal = None
    last_update = float("-inf")
    finished = False
    while True:
        try:
            signal = publication_signal(args.workspace.resolve()) if args.watch_minutes else None
            now = time.monotonic()
            if (
                not args.watch_minutes
                or signal != last_signal
                or now - last_update >= args.interval_seconds
                or now >= deadline
            ):
                changed, finished = update(args.workspace.resolve(), args.publish)
                last_signal = signal
                last_update = time.monotonic()
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
        time.sleep(min(60, args.interval_seconds, max(0, deadline - time.monotonic())))
