"""Prepare a NEW Windows continuation from a verified Mac snapshot; never starts training."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess

from transfer import digest, verify


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def prepare(snapshot, project, destination, actors=4, provider="dml"):
    snapshot, project, destination = (Path(p).resolve() for p in (snapshot, project, destination))
    if destination.exists():
        raise FileExistsError("Destination must be new; never overwrite Windows or Mac runs")
    if not destination.is_relative_to(project / "ai/danMCai/runs"):
        raise ValueError("Use a new ignored ai/danMCai/runs subdirectory")
    if not 1 <= actors <= 8 or provider not in ["cpu", "dml"]:
        raise ValueError("Use 1..8 samplers and cpu/dml inference")
    manifest = verify(snapshot)
    source = snapshot / manifest["sourceRun"]
    config = json.loads((source / "config.json").read_text())
    latest = json.loads((source / "models/latest.json").read_text())
    champion = json.loads((source / "champion/champion.json").read_text())
    if not json.loads((source / "status.json").read_text()).get("stoppedAt"):
        raise ValueError("Stopped source required")
    if json.loads((source / "learner/status.json").read_text()).get("state") != "stopped":
        raise ValueError("Stopped learner required")
    checkpoint_sha = digest(source / "learner/checkpoint.pt")
    source_shas = json.loads(subprocess.check_output(
        ["node", "--input-type=module", "-e",
         "import {sourceHashes} from './ai/danMCai/training/continuous/sources.mjs'; "
         "console.log(JSON.stringify(sourceHashes()))"], cwd=project, text=True))
    if digest(project / "ai/danMCai/models/baseline/policy.onnx") != digest(source / "models/anchor.onnx"):
        raise ValueError("Repository P0 differs from archived anchor")
    if digest(source / "models" / latest["file"]) != latest["sha256"]:
        raise ValueError("Latest model SHA mismatch")
    if digest(source / "champion/champion.onnx") != champion["sha256"]:
        raise ValueError("Champion model SHA mismatch")
    actor_offset, evaluation_offset = 6_000_000, 600
    for p in (source / "actors").glob("actor-*.json"):
        if json.loads(p.read_text())["nextSeed"] >= actor_offset:
            raise ValueError("Windows return seed block is not fresh")
    old_status = json.loads((source / "status.json").read_text())
    if max(old_status.get("gateIndex", 0), old_status.get("anchorIndex", 0)) >= evaluation_offset:
        raise ValueError("Windows return evaluation block is not fresh")
    # Copy only replay/model state into a distinct run. Historical logs/config/schedule/STOP
    # remain in the verified snapshot, without pretending the old Mac window is restartable.
    destination.mkdir(parents=True)
    for name in ["models", "champion", "league", "shards"]:
        shutil.copytree(source / name, destination / name, copy_function=shutil.copy2)
    for name in ["learner", "actors", "logs", "gate", "anchor"]:
        (destination / name).mkdir(exist_ok=True)
    shutil.copy2(source / "learner/checkpoint.pt", destination / "learner/checkpoint.pt")
    now = datetime.now(timezone.utc).isoformat()
    parent = {
        "kind": "mac-to-windows-prepared-continuation", "createdAtUTC": now,
        "snapshotManifestSHA256": digest(snapshot / "manifest.json"),
        "checkpointSHA256": checkpoint_sha, "latest": latest, "champion": champion,
        "sourceConfigSHA256": digest(source / "config.json"),
        "sourceScheduleSHA256": digest(source / "schedule.json"),
        "newTrainingStarted": False, "optimizerUpdatesExecuted": 0,
        "note": "Matched final learner/Adam, not champion+final Adam; no new duration or window granted by preparation",
    }
    config.update({
        "createdAt": now, "sourceSHA256": source_shas,
        "sourceHashConvention": "UTF-8 text with CRLF normalized to LF",
        "initial": "ai/danMCai/models/baseline/policy.onnx",
        "actors": actors, "actorSeedOffset": actor_offset,
        "evaluationBlockOffset": evaluation_offset, "actorImplementation": "fast",
        "fastActor": {"games": 8, "provider": provider},
        "resourceBudget": {"reserveGB": 4, "resumeGB": 5},
        "parent": parent,
        "protocolHistory": [{"at": now, "reason": "Prepared Windows return; new source/device/seed protocol, no training yet",
                             "parentProtocolHistory": config.get("protocolHistory", [])}],
    })
    config["learner"].update({"device": "cuda:0", "threads": 1, "seed": 20261107})
    if config.get("gateSchedule"):
        config["gateSchedule"].update({"minNewStep": latest["step"], "activatedAt": now})
    write(destination / "config.json", config)
    write(destination / "migration.json", parent)
    for slot in range(actors):
        prefix = f"a{slot:02}-"
        sequences = [int(p.stem[len(prefix):]) for p in (destination / "shards").glob(prefix + "*.json")]
        write(destination / f"actors/actor-{slot}.json", {
            "slot": slot, "nextSeed": actor_offset,
            "shardSequence": max([0, *[s + 1 for s in sequences]]),
        })
    write(destination / "status.json", {
        "running": False, "preparedAtUTC": now, "elapsedSeconds": 0,
        "gateIndex": evaluation_offset, "anchorIndex": evaluation_offset,
        "lastAnchorAt": int(datetime.now(timezone.utc).timestamp() * 1000),
        "lastSnapshotAt": 0, "gates": [], "anchorChecks": [],
        "preparationOnly": True, "parentStep": latest["step"],
    })
    result = {
        "preparedRun": str(destination), "sourceRun": manifest["sourceRun"],
        "latest": latest["version"], "champion": champion["version"],
        "checkpointSHA256": digest(destination / "learner/checkpoint.pt"),
        "sourceCheckpointSHA256": checkpoint_sha, "replayShards": len(list((destination / "shards").glob("*.json"))),
        "actorSeedOffset": actor_offset, "evaluationBlockOffset": evaluation_offset,
        "deviceForLaterAuthorizedStart": "cuda:0", "optimizerUpdatesExecuted": 0,
        "started": False, "scheduleCreated": False,
    }
    write(destination / "PREPARED-NOT-STARTED.json", result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--actors", type=int, default=4)
    parser.add_argument("--provider", choices=["cpu", "dml"], default="dml")
    args = parser.parse_args()
    print(json.dumps(prepare(args.snapshot, args.project, args.run, args.actors, args.provider)))
