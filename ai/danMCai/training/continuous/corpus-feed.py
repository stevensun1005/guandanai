"""Feed finished search-actor blocks of several independent slots into one learner run.

    python ai/danMCai/training/continuous/corpus-feed.py --run=<learner run dir>
        (--slots-root=<dir with slot-<n>/> | --slot=<n>=<actor --out dir> ...)
        [--history=1] [--heldout-mod=10] [--heldout-rest=9] [--interval=60]
        [--deadline=<ISO>] [--max-seconds=<s>] [--stop-file=<path>[,<path>]] [--once=1]

Each slot is one search-actor run (``--out``) whose finished blocks live at
``blocks/bNNNNNN/bNNNNNN-000000000.*`` with ``blocks/bNNNNNN.done.json``. Slots number their blocks
from b000000 each, so the learner names are prefixed with the slot: ``s{slot}-{shard}``.

A block is fed only once its done.json exists and every file it lists is present with the listed
SHA-256 and with the byte size its shard manifest implies. Then:
  * block index mod --heldout-mod != --heldout-rest: the data files are HARD-LINKED into
    ``<run>/shards/`` as ``s{slot}-{shard}.{x.i8,y.f32,e.f32,h.i8,m.u8}`` and a rewritten
    ``s{slot}-{shard}.json`` (a new file, written last and atomically, carrying the source) is
    written beside them; the learner ingests it and may later unlink these names, which leaves the
    block's own files (other links to the same inodes) intact;
  * otherwise the block is held out: it is listed in ``<run>/../heldout.json`` (by default
    ``--heldout=<path>``) and never linked.
Both cases append one line to ``feed.jsonl`` (default beside heldout.json), which is also the
restart state: a block named there is never fed again. With --history=1 a block without schema 2
and historyFeatures 1080 is refused (logged, not fed), so the learner never sees a history-free
block. The feeder never writes, renames or deletes anything inside a slot directory.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

FEATURES = 567
TARGETS = 4
HISTORY = 1080
DATA_SUFFIXES = (".x.i8", ".y.f32", ".e.f32", ".h.i8", ".m.u8")
DONE = re.compile(r"^b(\d{6})\.done\.json$")
SLOT_DIR = re.compile(r"^slot-(\d+)$")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def write_atomic(path, text):
    """Write `path` via a temporary name that does not end in .json (the learner globs *.json)."""
    path = Path(path)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def blocks_dir(slot_dir):
    """The actor's blocks/ directory: directly in the slot dir, or in a child holding run.json."""
    slot_dir = Path(slot_dir)
    if (slot_dir / "blocks").is_dir():
        return slot_dir / "blocks"
    if slot_dir.is_dir():
        for child in sorted(slot_dir.iterdir()):
            if (child / "run.json").exists() and (child / "blocks").is_dir():
                return child / "blocks"
    return None


def expected_sizes(meta):
    rows = int(meta["rows"])
    sizes = {".x.i8": rows * int(meta.get("features", FEATURES)), ".y.f32": rows * TARGETS * 4}
    if meta.get("extraFeatures"):
        sizes[".e.f32"] = rows * int(meta["extraFeatures"]) * 4
    if meta.get("historyFeatures"):
        sizes[".h.i8"] = rows * int(meta["historyFeatures"])
    if meta.get("metaFeatures"):
        sizes[".m.u8"] = rows * int(meta["metaFeatures"])
    return sizes


def check_block(directory, done):
    """(shard manifest dict, {suffix: source path}) if the finished block is complete, else raise."""
    block_dir = directory / done["name"]
    shard = done["shard"]
    listed = done.get("files") or {}
    if f"{shard}.json" not in listed:
        raise ValueError("done.json does not list the shard manifest")
    for name, digest in listed.items():
        path = block_dir / name
        if not path.is_file():
            raise ValueError(f"missing {name}")
        if sha256(path) != digest:
            raise ValueError(f"SHA-256 mismatch for {name}")
    meta = json.loads((block_dir / f"{shard}.json").read_text(encoding="utf-8"))
    sources = {}
    for suffix, size in expected_sizes(meta).items():
        path = block_dir / f"{shard}{suffix}"
        if path.name not in listed:
            raise ValueError(f"{path.name} not listed in done.json")
        if path.stat().st_size != size:
            raise ValueError(f"{path.name} has {path.stat().st_size} bytes, expected {size}")
        sources[suffix] = path
    return meta, sources


class Feeder:
    def __init__(self, args):
        self.run = Path(args.run)
        self.shards = self.run / "shards"
        self.shards.mkdir(parents=True, exist_ok=True)
        self.heldout_path = Path(args.heldout) if args.heldout else self.run.parent / "heldout.json"
        self.log_path = Path(args.feed_log) if args.feed_log else self.heldout_path.parent / "feed.jsonl"
        self.slots_root = Path(args.slots_root) if args.slots_root else None
        self.fixed = {}
        for item in args.slot or []:
            number, _, path = item.partition("=")
            self.fixed[int(number)] = Path(path)
        if not self.slots_root and not self.fixed:
            raise SystemExit("Give --slots-root or at least one --slot=<n>=<dir>")
        self.history = bool(int(args.history))
        self.mod, self.rest = int(args.heldout_mod), int(args.heldout_rest)
        self.seen = set()
        self.skipped = {}
        self.heldout = []
        if self.log_path.exists():
            for line in self.log_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                record = json.loads(line)
                if record.get("use") in ("train", "heldout", "refused"):
                    self.seen.add((record["slot"], record["block"]))
                if record.get("use") == "heldout":
                    self.heldout.append(record)

    def slots(self):
        found = dict(self.fixed)
        if self.slots_root and self.slots_root.is_dir():
            for child in self.slots_root.iterdir():
                match = SLOT_DIR.match(child.name)
                if match and child.is_dir():
                    found.setdefault(int(match.group(1)), child)
        return dict(sorted(found.items()))

    def append(self, record):
        record = {"t": time.time(), "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **record}
        with open(self.log_path, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")
        return record

    def write_heldout(self):
        write_atomic(self.heldout_path, json.dumps({
            "rule": f"block index mod {self.mod} == {self.rest} (every slot); by block, so by deal",
            "blocks": self.heldout,
            "rows": sum(b["rows"] for b in self.heldout),
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }, indent=2) + "\n")

    def feed_block(self, slot, directory, done):
        meta, sources = check_block(directory, done)
        name = f"s{slot}-{done['shard']}"
        base = {"slot": slot, "block": done["block"], "name": done["name"], "shard": done["shard"],
                "source": str(directory / done["name"]), "rows": int(meta["rows"]),
                "seeds": done.get("seeds"), "rounds": done.get("rounds"),
                "schema": meta.get("schema", 1), "files": done["files"]}
        if self.history and (meta.get("schema") != 2 or meta.get("historyFeatures") != HISTORY):
            return self.append({**base, "use": "refused", "reason": "history mode needs schema 2 + historyFeatures 1080"})
        if done["block"] % self.mod == self.rest:
            record = self.append({**base, "use": "heldout",
                                  "manifest": str(directory / done["name"] / f"{done['shard']}.json")})
            self.heldout.append(record)
            self.write_heldout()
            return record
        for suffix, source in sources.items():
            target = self.shards / f"{name}{suffix}"
            if target.exists():
                # A restart after a link and before the manifest: keep it only if it is this file.
                if not os.path.samefile(target, source):
                    raise ValueError(f"{target} exists and is not a link of {source}")
                continue
            os.link(source, target)
        rewritten = {**meta, "feed": {"slot": slot, "block": done["block"], "source": str(directory / done["name"]),
                                      "sourceManifest": f"{done['shard']}.json",
                                      "sourceManifestSHA256": done["files"][f"{done['shard']}.json"]}}
        write_atomic(self.shards / f"{name}.json", json.dumps(rewritten, indent=2))
        return self.append({**base, "use": "train", "learnerName": name, "linked": sorted(sources)})

    def poll(self):
        fed = []
        for slot, slot_dir in self.slots().items():
            directory = blocks_dir(slot_dir)
            if directory is None:
                continue
            for entry in sorted(directory.iterdir()):
                match = DONE.match(entry.name)
                if not match or (slot, int(match.group(1))) in self.seen:
                    continue
                try:
                    done = json.loads(entry.read_text(encoding="utf-8"))
                    record = self.feed_block(slot, directory, done)
                except (OSError, ValueError, KeyError) as error:
                    # Not complete (or damaged): retried on every poll, logged once per reason.
                    key = (slot, int(match.group(1)))
                    if self.skipped.get(key) != str(error):
                        self.skipped[key] = str(error)
                        self.append({"slot": slot, "block": key[1], "use": "skipped", "reason": str(error)})
                    continue
                self.seen.add((slot, int(match.group(1))))
                fed.append(record)
        return fed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--slots-root", default="")
    parser.add_argument("--slot", action="append")
    parser.add_argument("--history", default="0")
    parser.add_argument("--heldout-mod", default="10")
    parser.add_argument("--heldout-rest", default="9")
    parser.add_argument("--heldout", default="")
    parser.add_argument("--feed-log", default="")
    parser.add_argument("--interval", type=float, default=60)
    parser.add_argument("--deadline", default="")
    parser.add_argument("--max-seconds", type=float, default=0)
    parser.add_argument("--stop-file", default="")
    parser.add_argument("--once", default="0")
    args = parser.parse_args()
    feeder = Feeder(args)
    stops = [Path(p) for p in args.stop_file.split(",") if p]
    deadline = datetime.fromisoformat(args.deadline.replace("Z", "+00:00")).timestamp() if args.deadline else None
    started = time.time()
    feeder.append({"use": "start", "pid": os.getpid(), "run": str(feeder.run), "history": feeder.history,
                   "slots": {str(k): str(v) for k, v in feeder.slots().items()},
                   "heldout": f"mod {feeder.mod} == {feeder.rest}"})
    reason = "once"
    while True:
        fed = feeder.poll()
        print(json.dumps({"fed": len(fed), "seen": len(feeder.seen)}), flush=True)
        if int(args.once):
            break
        reason = None
        next_poll = time.time() + args.interval
        while time.time() < next_poll and reason is None:
            if any(p.exists() for p in stops):
                reason = "stop-file"
            elif deadline and time.time() >= deadline:
                reason = "deadline"
            elif args.max_seconds and time.time() - started >= args.max_seconds:
                reason = "max-seconds"
            else:
                time.sleep(min(1.0, args.interval))
        if reason:
            feeder.poll()
            break
    feeder.append({"use": "stop", "reason": reason, "seen": len(feeder.seen)})


if __name__ == "__main__":
    sys.exit(main())
