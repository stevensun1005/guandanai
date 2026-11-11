"""1,295-wide extras (215 public-belief + 1,080 history, extrasMode public-belief-history).

wrap_initial.py --width=1295 parity (torch and onnxruntime), schema-2 ingestion with the history
kept as int8 and returned as float32, schema-1 refusal, trunkFrozen moving only extra_weight, the
unlink list, and that the 53/215 modes keep their replay layout.

With DANMCAI_PARITY_CHAMPION=<017.onnx> and DANMCAI_PARITY_ROWS=<shard.json>[,...] the wrap parity
also runs on that champion and those rows (1,000 rows, random history), as in window 5's L1 init.
"""
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
import onnxruntime as ort
import torch

HERE = Path(__file__).resolve().parents[1] / "training/continuous"
sys.path.insert(0, str(HERE))
from value_net import EXTRA_WIDTHS, ValueNet, ValueNetExtras, export_onnx, export_onnx_extras  # noqa: E402

spec = importlib.util.spec_from_file_location("history1295_continuous_learner", HERE / "learner.py")
learner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(learner)

ROWS = 64
WIDTH = 1295


def write_shard(directory, stem, rows, seed, schema=2, history=True, meta_features=True, extras=215):
    rng = np.random.default_rng(seed)
    directory = Path(directory)
    rng.integers(0, 3, (rows, 567)).astype(np.int8).tofile(directory / f"{stem}.x.i8")
    y = np.zeros((rows, 4), np.float32)
    y[:, 0] = rng.choice([-3, -2, -1, 1, 2, 3], rows)
    y.tofile(directory / f"{stem}.y.f32")
    rng.random((rows, extras), dtype=np.float32).tofile(directory / f"{stem}.e.f32")
    meta = {"schema": schema, "rows": rows, "features": 567, "extraFeatures": extras}
    if history:
        rng.integers(-1, 3, (rows, 1080)).astype(np.int8).tofile(directory / f"{stem}.h.i8")
        meta["historyFeatures"] = 1080
    if meta_features:
        rng.integers(0, 3, (rows, 3)).astype(np.uint8).tofile(directory / f"{stem}.m.u8")
        meta["metaFeatures"] = 3
    (directory / f"{stem}.json").write_text(json.dumps(meta))
    return meta


def make_run(directory, mode="public-belief-history", width=WIDTH, shard=True, **settings):
    run = Path(directory)
    for name in ("models", "shards"):
        (run / name).mkdir(parents=True)
    torch.manual_seed(20261113)
    export_onnx_extras(ValueNet().weights(), run / "models/v000000000.onnx", None, width)
    (run / "models/latest.json").write_text(json.dumps({"version": "v000000000", "file": "v000000000.onnx"}))
    config = {
        "extrasMode": mode,
        "learner": {
            "device": "cpu", "threads": 1, "batch": 16, "learningRate": 1e-5,
            "extrasLearningRate": 1e-4, "gradClip": 1.0, "capacity": 1000, "minSamples": ROWS,
            "replayRatio": 40, "exportSeconds": 1e9, "targetMatchWeight": 0, "anchorWeight": 0,
            "seed": 20261113, **settings,
        },
    }
    (run / "config.json").write_text(json.dumps(config))
    if shard:
        write_shard(run / "shards", "a00-000000000", ROWS, 7)
    return run


class History1295Test(unittest.TestCase):
    def test_registered_width_and_zero_projection_matches_base(self):
        self.assertEqual(EXTRA_WIDTHS, (53, 215, 1295))
        self.assertEqual(learner.EXTRA_WIDTH["public-belief-history"], 1295)
        torch.manual_seed(3)
        weights = ValueNet().weights()
        base, student = ValueNet(weights), ValueNetExtras(weights, WIDTH)
        x = torch.rand(9, 567)
        with torch.no_grad():
            np.testing.assert_array_equal(base(x).numpy(), student(x, torch.rand(9, WIDTH) * 3 - 1).numpy())

    def test_wrap_initial_1295_parity_in_torch_and_onnxruntime(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            torch.manual_seed(5)
            export_onnx(ValueNet().weights(), d / "champion.onnx")
            write_shard(d, "b000000-000000000", 300, 11, schema=1, history=False, meta_features=False)
            cases = [(str(d / "champion.onnx"), str(d / "b000000-000000000.json"), 200)]
            if os.environ.get("DANMCAI_PARITY_CHAMPION") and os.environ.get("DANMCAI_PARITY_ROWS"):
                cases.append((os.environ["DANMCAI_PARITY_CHAMPION"], os.environ["DANMCAI_PARITY_ROWS"], 1000))
            for champion, rows, n in cases:
                out, report = d / f"wrapped-{n}.onnx", d / f"parity-{n}.json"
                done = subprocess.run(
                    [sys.executable, str(HERE / "wrap_initial.py"), f"--champion={champion}", f"--out={out}",
                     "--width=1295", f"--check-rows={rows}", f"--check-n={n}", f"--check-out={report}"],
                    capture_output=True, text=True)
                self.assertEqual(done.returncode, 0, done.stderr + done.stdout)
                record = json.loads(report.read_text())
                parity = record["parity"]
                self.assertTrue(parity["pass"])
                self.assertEqual(parity["rows"], n)
                self.assertEqual(parity["historySource"], ["random"])
                self.assertLessEqual(parity["torchMaxAbsDiff"], 1e-6)
                self.assertLessEqual(parity["ortMaxAbsDiff"], 1e-6)
                self.assertEqual(parity["projectionMaxAbs"], 0.0)
                self.assertGreater(parity["extrasNonzeroFraction"], 0.5)
                session = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
                extras = next(i for i in session.get_inputs() if i.name == "extras")
                self.assertEqual(extras.shape[1], WIDTH)
                self.assertEqual(record["sha256"], hashlib.sha256(out.read_bytes()).hexdigest())
            bad = subprocess.run(
                [sys.executable, str(HERE / "wrap_initial.py"), f"--champion={d / 'champion.onnx'}",
                 f"--out={d / 'x.onnx'}", "--width=1295", "--expect-sha=" + "0" * 64],
                capture_output=True, text=True)
            self.assertNotEqual(bad.returncode, 0)

    def test_schema2_shard_is_ingested_with_history_as_float32_columns(self):
        with tempfile.TemporaryDirectory() as d:
            run = make_run(d)
            stem = run / "shards/a00-000000000"
            e = np.fromfile(f"{stem}.e.f32", np.float32).reshape(ROWS, 215)
            h = np.fromfile(f"{stem}.h.i8", np.int8).reshape(ROWS, 1080)
            trainer = learner.Learner(run)
            self.assertEqual((trainer.extra_width, trainer.history_width, trainer.stored_extra_width), (1295, 1080, 215))
            self.assertEqual(trainer.ingest(), ROWS)
            self.assertEqual(trainer.replay.h.dtype, np.int8)
            self.assertEqual(trainer.replay.e.shape, (1000, 215))
            x, _, extras = trainer.replay.batch(50)
            self.assertEqual(extras.shape, (50, WIDTH))
            self.assertEqual(extras.dtype, np.float32)
            # Each batch row is the stored row's e followed by its history, aligned with x.
            stored_x = np.fromfile(f"{stem}.x.i8", np.int8).reshape(ROWS, 567)
            for row, ext in zip(x, extras):
                i = int(np.flatnonzero((stored_x == row).all(axis=1))[0])
                np.testing.assert_array_equal(ext[:215], e[i])
                np.testing.assert_array_equal(ext[215:], h[i].astype(np.float32))

    def test_schema1_or_history_free_shards_are_refused(self):
        for kwargs in ({"schema": 1, "history": False}, {"schema": 1, "history": True}, {"schema": 2, "history": False}):
            with tempfile.TemporaryDirectory() as d:
                run = make_run(d, shard=False)
                write_shard(run / "shards", "a00-000000000", ROWS, 7, **kwargs)
                with self.assertRaises(ValueError):
                    learner.Learner(run).ingest()
        with tempfile.TemporaryDirectory() as d:  # out-of-range history values
            run = make_run(d)
            np.full((ROWS, 1080), 3, np.int8).tofile(run / "shards/a00-000000000.h.i8")
            with self.assertRaises(ValueError):
                learner.Learner(run).ingest()
        with tempfile.TemporaryDirectory() as d:  # a 215-wide initial model in history mode
            run = make_run(d, width=215)
            with self.assertRaises(ValueError):
                learner.Learner(run)

    def test_twenty_trunk_frozen_steps_change_only_extra_weight(self):
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as d:
            run = make_run(d, trunkFrozen=True)
            trainer = learner.Learner(run)
            self.assertEqual([g["lr"] for g in trainer.optimizer.param_groups], [1e-5, 1e-4])
            trunk = [w.copy() for w in trainer.net.weights()]
            trainer.loop(max_steps=20)
            self.assertEqual(trainer.step, 20)
            for a, b in zip(trunk, trainer.net.weights()):
                np.testing.assert_array_equal(a, b)
            projection = trainer.net.extra_weight.detach().numpy()
            self.assertGreater(np.count_nonzero(projection[:215]), 0)
            self.assertGreater(np.count_nonzero(projection[215:]), 0)
            latest = json.loads((run / "models/latest.json").read_text())
            self.assertEqual(latest["version"], "v000000020")
            session = ort.InferenceSession(str(run / "models" / latest["file"]), providers=["CPUExecutionProvider"])
            values = session.run(["values"], {"state": np.zeros((1, 513), np.float32),
                                              "actions": np.zeros((2, 54), np.float32),
                                              "extras": np.ones((2, WIDTH), np.float32)})[0]
            self.assertEqual(values.shape, (2, 1))
            start = json.loads((run / "learner/log.jsonl").read_text().splitlines()[0])
            self.assertEqual((start["extrasWidth"], start["historyWidth"], start["trunkFrozen"]), (1295, 1080, True))
            resumed = learner.Learner(run)
            self.assertEqual(resumed.step, 20)

    def test_consumed_shards_lose_their_history_and_meta_files(self):
        with tempfile.TemporaryDirectory() as d:
            run = make_run(d, shard=False, capacity=ROWS)
            for i in range(3):
                write_shard(run / "shards", f"a00-00000000{i}", ROWS, i)
                os.utime(run / f"shards/a00-00000000{i}.json", (1000 + i, 1000 + i))
            trainer = learner.Learner(run)
            trainer.ingest()
            names = sorted(p.name for p in (run / "shards").iterdir())
            self.assertEqual([n for n in names if n.startswith("a00-000000000.") or n.startswith("a00-000000001.")], [])
            self.assertEqual(len([n for n in names if n.startswith("a00-000000002.")]), 6)

    def test_extras_free_and_215_replays_keep_their_layout(self):
        plain = learner.Replay(10, 1)
        plain.add(np.ones((4, 567), np.int8), np.ones((4, 4), np.float32))
        self.assertEqual(len(plain.batch(3)), 2)
        self.assertIsNone(plain.h)
        belief = learner.Replay(10, 1, 215)
        belief.add(np.ones((4, 567), np.int8), np.ones((4, 4), np.float32), np.ones((4, 215), np.float32))
        x, y, e = belief.batch(3)
        self.assertEqual(e.shape, (3, 215))
        self.assertIsNone(belief.h)
        with self.assertRaises(ValueError):
            learner.Replay(10, 1, 0, 1080)
        history = learner.Replay(5, 2, 215, 1080)
        with self.assertRaises(ValueError):
            history.add(np.ones((4, 567), np.int8), np.ones((4, 4), np.float32), np.ones((4, 215), np.float32))
        # Ring wrap keeps x / e / h aligned.
        x = np.repeat(np.arange(9, dtype=np.int8)[:, None], 567, axis=1)
        y = np.repeat(np.arange(9, dtype=np.float32)[:, None], 4, axis=1)
        e = np.repeat(np.arange(9, dtype=np.float32)[:, None], 215, axis=1)
        h = np.repeat((np.arange(9) % 3).astype(np.int8)[:, None], 1080, axis=1)
        history.add(x, y, e, h)
        a, b, c = history.batch(100)
        np.testing.assert_array_equal(a[:, 0], c[:, 0])
        np.testing.assert_array_equal(c[:, 215], (a[:, 0] % 3).astype(np.float32))
        self.assertGreaterEqual(int(a[:, 0].min()), 4)


if __name__ == "__main__":
    unittest.main()
