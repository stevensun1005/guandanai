"""Read-only audit of a stopped continuous run; never starts a learner or modifies its data."""

import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def audit_shards(directory, counted, inherited_absent=()):
    directory = Path(directory)
    manifests = {}
    expected = set()
    for path in sorted(directory.glob("*.json")):
        meta = read(path)
        rows = meta["rows"]
        require(isinstance(rows, int) and rows > 0, f"Invalid rows: {path.name}")
        require(meta["features"] == 567, f"Wrong encoding width: {path.name}")
        require(meta["targets"] == ["roundPoints", "matchResult", "roundIndex", "matchRounds"],
                f"Wrong target layout: {path.name}")
        x = path.with_suffix(".x.i8")
        y = path.with_suffix(".y.f32")
        require(x.is_file() and y.is_file(), f"Missing shard companion: {path.name}")
        require(x.stat().st_size == rows * 567, f"Feature size mismatch: {path.name}")
        require(y.stat().st_size == rows * 16, f"Target size mismatch: {path.name}")
        for points, outcome, index, rounds in struct.iter_unpack("<4f", y.read_bytes()):
            require(all(math.isfinite(v) for v in [points, outcome, index, rounds]),
                    f"Non-finite targets: {path.name}")
            require(points in [-3, -2, -1, 0, 1, 2, 3] and outcome in [-1, 0, 1],
                    f"Invalid reward components: {path.name}")
            require(index.is_integer() and rounds.is_integer() and 0 <= index < rounds <= 200,
                    f"Invalid round bounds: {path.name}")
        manifests[path.name] = {"rows": rows, "matches": meta["matches"]}
        expected.update([path.name, x.name, y.name])
    actual = {p.name for p in directory.iterdir() if p.is_file()}
    require(actual == expected, f"Orphan or temporary shard files: {sorted(actual ^ expected)}")
    require(manifests, "No replay shards retained")
    absent = set(counted) - manifests.keys()
    require(absent <= set(inherited_absent), "Checkpoint references missing retained shards")
    pending = {name: meta for name, meta in manifests.items() if name not in counted}
    return {
        "manifests": manifests,
        "shards": len(manifests),
        "retainedRows": sum(m["rows"] for m in manifests.values()),
        "pendingShards": list(pending),
        "pendingRows": sum(m["rows"] for m in pending.values()),
        "allCompanionsAndLengthsValid": True,
        "allTargetsFiniteAndWithinProtocol": True,
        "inheritedCountedNamesAlreadyAbsentAtHandoff": sorted(absent),
    }


def audit_actor_logs(directory, seed_offset):
    actors = []
    for path in sorted(Path(directory).glob("actor-*.json")):
        actor = read(path)
        seen = set()
        matches = decisions = failures = 0
        results = Path(directory) / f"results-{actor['slot']}.jsonl"
        with results.open(encoding="utf-8") as stream:
            for line in stream:
                require(line.endswith("\n"), f"Incomplete results line: {results.name}")
                record = json.loads(line)
                base = 1_000_000_000 + actor["slot"] * 50_000_000
                require(isinstance(record["seed"], int) and
                        base + seed_offset <= record["seed"] < base + actor["nextSeed"],
                        f"Seed outside reserved actor block: {results.name}")
                require(record["seed"] not in seen, f"Repeated seed: {results.name}")
                seen.add(record["seed"])
                if "error" in record:
                    failures += 1
                else:
                    matches += 1
                    decisions += record["decisions"]
        require(matches == actor["matches"] and decisions == actor["rows"] == actor["decisions"],
                f"Actor counters disagree with results log: {path.name}")
        require(failures == actor["failures"], f"Actor failures disagree: {path.name}")
        actors.append({
            "slot": actor["slot"], "pid": actor["pid"], "matches": matches,
            "decisions": decisions, "failures": failures, "nextSeed": actor["nextSeed"],
            "shardSequence": actor["shardSequence"], "uniqueLoggedSeeds": len(seen),
            "allocatedSeedsWithoutResult": actor["nextSeed"] - seed_offset - len(seen),
        })
    require(actors, "No actor state files")
    return actors


def audit(run, frozen_source, inherited_run=None):
    run, frozen_source = Path(run).resolve(), Path(frozen_source).resolve()
    status, learner = read(run / "status.json"), read(run / "learner/status.json")
    require(status.get("stoppedAt") and not status.get("running"), "Supervisor has not stopped")
    require(learner["state"] == "stopped", "Learner has not saved and stopped")
    config, schedule, stop = read(run / "config.json"), read(run / "schedule.json"), read(run / "STOP")
    require(stop.get("reason") == "authorized-time-limit", "Unexpected stop cause")
    require(stop.get("deadlineUTC") == schedule["deadlineUTC"], "Deadline provenance mismatch")
    start = datetime.datetime.fromisoformat(schedule["startUTC"].replace("Z", "+00:00"))
    deadline = datetime.datetime.fromisoformat(schedule["deadlineUTC"].replace("Z", "+00:00"))
    require((deadline - start).total_seconds() == 86400 and not schedule["restartExtendsDeadline"],
            "Schedule was not one fixed 24h window")
    for name, expected in config["sourceSHA256"].items():
        data = (frozen_source / name).read_bytes().replace(b"\r\n", b"\n")
        require(hashlib.sha256(data).hexdigest() == expected, f"Frozen source mismatch: {name}")

    # Load only CPU copies. No optimizer step, publishing, ingest or training loop is executed.
    import numpy as np
    import torch
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(frozen_source / "ai/danMCai/training/continuous"))
    from value_net import ValueNet, load_onnx_weights
    checkpoint = torch.load(run / "learner/checkpoint.pt", weights_only=True, map_location="cpu")
    latest, champion = read(run / "models/latest.json"), read(run / "champion/champion.json")
    require(checkpoint["step"] == latest["step"] == learner["step"], "Final step disagreement")
    require(checkpoint["trainedRows"] == latest["trainedRows"] == learner["trainedRows"],
            "Final trained-row disagreement")
    require(checkpoint["ingestedRows"] == latest["ingestedRows"] == learner["ingestedRows"],
            "Final ingested-row disagreement")
    require(sha(run / "models" / latest["file"]) == latest["sha256"], "Final export SHA mismatch")
    require(sha(run / "champion/champion.onnx") == champion["sha256"], "Champion SHA mismatch")
    net = ValueNet(load_onnx_weights(run / "models" / latest["file"]))
    expected_weights = net.weights()
    net.load_state_dict(checkpoint["model"])
    require(all(np.array_equal(a, b) for a, b in zip(net.weights(), expected_weights)),
            "Checkpoint weights differ from final ONNX")
    optimizer = torch.optim.Adam(net.parameters(), lr=config["learner"]["learningRate"])
    optimizer.load_state_dict(checkpoint["optimizer"])
    require(len(optimizer.state) == len(list(net.parameters())), "Adam state missing")
    adam_steps = []
    for parameter, state in optimizer.state.items():
        for key in ["exp_avg", "exp_avg_sq"]:
            require(state[key].shape == parameter.shape and torch.isfinite(state[key]).all().item(),
                    f"Invalid Adam tensor: {key}")
        adam_steps.append(float(state["step"]))
    require(all(step == checkpoint["step"] for step in adam_steps), "Adam step disagreement")

    inherited_absent = set()
    inherited_checkpoint_sha = None
    if inherited_run:
        inherited_run = Path(inherited_run).resolve()
        inherited_checkpoint_sha = sha(inherited_run / "learner/checkpoint.pt")
        require(inherited_checkpoint_sha == config["parent"]["checkpointSHA256"],
                "Inherited bookkeeping checkpoint SHA mismatch")
        inherited = torch.load(inherited_run / "learner/checkpoint.pt", weights_only=True, map_location="cpu")
        inherited_absent = set(inherited["countedShards"]) - {p.name for p in (inherited_run / "shards").glob("*.json")}
    shards = audit_shards(run / "shards", checkpoint["countedShards"], inherited_absent)
    actors = audit_actor_logs(run / "actors", config["actorSeedOffset"])
    pids = [status["pid"], learner["pid"], *[a["pid"] for a in actors]]
    alive = []
    for pid in pids:
        try:
            os.kill(pid, 0)
            alive.append(pid)
        except ProcessLookupError:
            pass
    require(not alive, f"Training processes still alive: {alive}")
    require(sum(a["matches"] for a in actors) == status["totals"]["matches"], "Final match totals differ")
    require(sum(a["decisions"] for a in actors) == status["totals"]["rows"] == status["totals"]["decisions"],
            "Final sample totals differ")
    bad_shards = []
    for line in (run / "learner/log.jsonl").read_text().splitlines():
        record = json.loads(line)
        if record.get("event") == "bad-shard":
            bad_shards.append(record)
    require(not bad_shards, "Learner reported invalid shards")
    return {
        "schema": 1, "kind": "Read-only final continuous-run audit", "passed": True,
        "observedAtUTC": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "run": str(run), "schedule": schedule, "scheduleSHA256": sha(run / "schedule.json"),
        "STOP": stop, "statusStopReason": status.get("stopReason"),
        "supervisorStoppedAt": status["stoppedAt"], "trainingProcessesExited": pids,
        "sourceSHA256": config["sourceSHA256"], "latest": latest, "champion": champion,
        "checkpoint": {"sha256": sha(run / "learner/checkpoint.pt"), "step": checkpoint["step"],
                       "trainedRows": checkpoint["trainedRows"], "ingestedRows": checkpoint["ingestedRows"],
                       "modelMatchesONNX": True, "adamStates": len(adam_steps), "adamSteps": sorted(set(adam_steps)),
                       "countedShards": len(checkpoint["countedShards"])},
        "replay": shards, "actors": actors, "totals": status["totals"],
        "reconstructedReplayRows": min(config["learner"]["capacity"], shards["retainedRows"]),
        "historicallyEvictedRowsRecovered": False,
        "checkpointIncludesReplayRingOrRandomState": False,
        "badShardEvents": bad_shards, "optimizerUpdatesExecutedByAudit": 0,
        "inheritedBookkeepingCheckpointSHA256": inherited_checkpoint_sha,
        "limit": "Validates completed saved data and retained replay; does not recover evicted raw samples or prove playing strength.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--frozen-source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--inherited-run")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    require(not output.is_relative_to(Path(args.run).resolve()), "Audit output must be outside source run")
    result = audit(args.run, args.frozen_source, args.inherited_run)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": True, "step": result["checkpoint"]["step"], "retainedRows": result["replay"]["retainedRows"], "pendingRows": result["replay"]["pendingRows"]}))
