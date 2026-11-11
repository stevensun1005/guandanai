"""corpus-feed.py: slot-prefixed hard links, held-out blocks, history refusal, restart state, and
that the learner's deletion of a fed shard leaves the block's own files and SHA-256 intact."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import torch

TESTS = Path(__file__).resolve().parent
HERE = TESTS.parents[0] / "training/continuous"
FEED = HERE / "corpus-feed.py"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(TESTS))
from value_net import ValueNet, export_onnx_extras  # noqa: E402
from history1295_learner_test import write_shard  # noqa: E402

spec = importlib.util.spec_from_file_location("corpus_feed_learner", HERE / "learner.py")
learner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(learner)

ROWS = 40


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_block(slot_dir, block, seed, **kwargs):
    """A finished search-actor block: blocks/bNNNNNN/bNNNNNN-000000000.* + blocks/bNNNNNN.done.json."""
    name = f"b{block:06d}"
    directory = Path(slot_dir) / "blocks" / name
    directory.mkdir(parents=True)
    write_shard(directory, f"{name}-000000000", ROWS, seed, **kwargs)
    files = {p.name: sha(p) for p in sorted(directory.iterdir())}
    done = {"block": block, "name": name, "shard": f"{name}-000000000", "seeds": [seed, seed + 1],
            "rounds": 2, "rowsWritten": ROWS, "files": files}
    (Path(slot_dir) / "blocks" / f"{name}.done.json").write_text(json.dumps(done))
    return done


def feed(run, *extra):
    done = subprocess.run([sys.executable, str(FEED), f"--run={run}", "--once=1", *extra],
                          capture_output=True, text=True)
    if done.returncode:
        raise AssertionError(done.stderr + done.stdout)
    return done


def log(run):
    return [json.loads(line) for line in (Path(run).parent / "feed.jsonl").read_text().splitlines()]


def learner_run(run, capacity):
    for name in ("models", "shards"):
        (run / name).mkdir(parents=True, exist_ok=True)
    torch.manual_seed(1)
    export_onnx_extras(ValueNet().weights(), run / "models/v000000000.onnx", None, 1295)
    (run / "models/latest.json").write_text(json.dumps({"version": "v000000000", "file": "v000000000.onnx"}))
    (run / "config.json").write_text(json.dumps({"extrasMode": "public-belief-history", "learner": {
        "device": "cpu", "threads": 1, "batch": 8, "learningRate": 1e-5, "extrasLearningRate": 1e-4,
        "trunkFrozen": True, "gradClip": 1.0, "capacity": capacity, "minSamples": 1, "replayRatio": 8,
        "exportSeconds": 1e9, "targetMatchWeight": 0, "anchorWeight": 0, "seed": 20261113}}))


class CorpusFeedTest(unittest.TestCase):
    def test_two_slots_with_the_same_block_names_both_arrive(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            slots = d / "C2"
            for slot in (0, 1):
                for block in (0, 1):
                    write_block(slots / f"slot-{slot}", block, 100 * slot + block)
            run = d / "L1/run"
            learner_run(run, 1000)
            feed(run, f"--slots-root={slots}", "--history=1")
            names = sorted(p.name for p in (run / "shards").glob("*.json"))
            self.assertEqual(names, [f"s{s}-b00000{b}-000000000.json" for s in (0, 1) for b in (0, 1)])
            for s in (0, 1):
                for suffix in (".x.i8", ".y.f32", ".e.f32", ".h.i8", ".m.u8"):
                    linked = run / "shards" / f"s{s}-b000000-000000000{suffix}"
                    source = slots / f"slot-{s}/blocks/b000000/b000000-000000000{suffix}"
                    self.assertTrue(os.path.samefile(linked, source))
            meta = json.loads((run / "shards/s1-b000000-000000000.json").read_text())
            self.assertEqual((meta["schema"], meta["historyFeatures"], meta["feed"]["slot"]), (2, 1080, 1))
            # Every row of all four blocks reaches the learner's replay.
            trainer = learner.Learner(run)
            self.assertEqual(trainer.ingest(), 4 * ROWS)
            self.assertEqual(trainer.replay.size, 4 * ROWS)
            # A second poll (a restart) feeds nothing again.
            feed(run, f"--slots-root={slots}", "--history=1")
            self.assertEqual(sum(r.get("use") == "train" for r in log(run)), 4)

    def test_heldout_blocks_are_listed_not_linked_and_schema1_is_refused_in_history_mode(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            slot = d / "C2/slot-3"
            for block in (8, 9, 19):
                write_block(slot, block, block)
            write_block(slot, 10, 10, schema=1, history=False, meta_features=False)
            run = d / "L1/run"
            feed(run, f"--slot=3={slot}", "--history=1")
            self.assertEqual(sorted(p.name for p in (run / "shards").glob("*.json")), ["s3-b000008-000000000.json"])
            heldout = json.loads((d / "L1/heldout.json").read_text())
            self.assertEqual(sorted(b["block"] for b in heldout["blocks"]), [9, 19])
            self.assertEqual(heldout["rows"], 2 * ROWS)
            uses = {r["block"]: r["use"] for r in log(run) if "block" in r}
            self.assertEqual(uses, {8: "train", 9: "heldout", 19: "heldout", 10: "refused"})
            # Without --history the schema-1 block is fed (the L1-215 fallback).
            run2 = d / "L1b/run"
            feed(run2, f"--slot=3={slot}")
            self.assertTrue((run2 / "shards/s3-b000010-000000000.json").exists())
            self.assertFalse((run2 / "shards/s3-b000010-000000000.h.i8").exists())

    def test_incomplete_block_waits_and_feeds_once_complete(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            slot = d / "slot-0"
            done = write_block(slot, 0, 1)
            source = slot / "blocks/b000000/b000000-000000000.h.i8"
            good = source.read_bytes()
            source.write_bytes(good[:-1080])
            run = d / "L1/run"
            feed(run, f"--slot=0={slot}")
            self.assertEqual(list((run / "shards").iterdir()), [])
            self.assertEqual([r["use"] for r in log(run) if "block" in r], ["skipped"])
            source.write_bytes(good)
            feed(run, f"--slot=0={slot}")
            self.assertEqual(sha(run / "shards/s0-b000000-000000000.h.i8"), done["files"]["b000000-000000000.h.i8"])

    def test_learner_deletion_of_fed_shards_keeps_block_files_and_shas(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            slot = d / "C2/slot-0"
            dones = [write_block(slot, block, block) for block in range(3)]
            run = d / "L1/run"
            learner_run(run, ROWS)  # capacity of one block: the two older fed shards are unlinked
            for block in range(3):
                feed(run, f"--slot=0={slot}")
                manifest = run / f"shards/s0-b00000{block}-000000000.json"
                if manifest.exists():
                    os.utime(manifest, (2000 + block, 2000 + block))
            trainer = learner.Learner(run)
            self.assertEqual(trainer.ingest(), 3 * ROWS)
            left = sorted(p.name for p in (run / "shards").iterdir())
            self.assertTrue(all(name.startswith("s0-b000002-") for name in left), left)
            self.assertEqual(len(left), 6)
            for done in dones:
                directory = slot / "blocks" / done["name"]
                self.assertEqual({p.name: sha(p) for p in directory.iterdir()}, done["files"])
                for p in directory.iterdir():
                    # Data files of the still-fed block have the learner's link too; the block's
                    # own .json is never linked (the learner gets a rewritten copy).
                    linked = done["block"] == 2 and p.suffix != ".json"
                    self.assertEqual(p.stat().st_nlink, 2 if linked else 1)
            # Restart: the deleted shards are not fed again.
            feed(run, f"--slot=0={slot}")
            self.assertEqual(sorted(p.name for p in (run / "shards").iterdir()), left)

    def test_requires_a_slot(self):
        with tempfile.TemporaryDirectory() as d:
            done = subprocess.run([sys.executable, str(FEED), f"--run={d}/run", "--once=1"],
                                  capture_output=True, text=True)
            self.assertNotEqual(done.returncode, 0)

    def test_stop_file_ends_the_loop(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            write_block(d / "slot-0", 0, 1)
            (d / "STOP").write_text("")
            done = subprocess.run([sys.executable, str(FEED), f"--run={d}/L1/run", f"--slot=0={d}/slot-0",
                                   "--interval=30", f"--stop-file={d}/STOP"], capture_output=True, text=True, timeout=20)
            self.assertEqual(done.returncode, 0, done.stderr)
            records = log(d / "L1/run")
            self.assertEqual(records[-1], {**records[-1], "use": "stop", "reason": "stop-file"})
            self.assertTrue((d / "L1/run/shards/s0-b000000-000000000.json").exists())


if __name__ == "__main__":
    unittest.main()
