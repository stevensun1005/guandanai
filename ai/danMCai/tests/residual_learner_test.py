"""Endgame residual student: decision grouping, keep/reject loss, zero start and fused export."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training" / "continuous"))
from residual_export import (  # noqa: E402
    fused_onnx,
    load_residual,
    residual_champion,
    save_residual,
    torch_values,
    zero_output_residual,
)
from value_net import FEATURES, STATE, ValueNet, export_onnx, load_onnx_weights  # noqa: E402

spec = importlib.util.spec_from_file_location("residual_learner", ROOT / "endgame" / "residual-learner.py")
learner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(learner)

BASELINE = ROOT / "models" / "baseline" / "policy.onnx"


def row(state, action):
    x = np.zeros(FEATURES, np.int8)
    x[:STATE] = state
    x[STATE:] = action
    return x


def synthetic_rows(seed=0):
    """Three decisions: A (two plays + pass), A again (two plays), B (two plays, no pass)."""
    rng = np.random.default_rng(seed)
    a, b = rng.integers(0, 2, STATE), rng.integers(0, 2, STATE)
    play = lambda: rng.integers(0, 2, FEATURES - STATE) | np.eye(1, FEATURES - STATE, rng.integers(54), dtype=np.int64)[0]
    pass_ = np.zeros(FEATURES - STATE, np.int64)
    rows = [row(a, play()), row(a, play()), row(a, pass_), row(a, play()), row(a, play()), row(b, play()), row(b, play())]
    return np.stack(rows)


def write_shard(directory, name, x, y, decisions):
    x.astype(np.int8).tofile(directory / f"{name}.x.i8")
    np.zeros((len(y), 162), np.int8).tofile(directory / f"{name}.o.i8")
    np.asarray(y, np.float32).tofile(directory / f"{name}.y.f32")
    (directory / f"{name}.json").write_text(
        json.dumps({"labels": "pimc-mean", "rows": len(y), "stats": {"decisions": decisions}}), encoding="utf-8"
    )


def ort_values(path, x):
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    out = []
    for r in x.astype(np.float32):
        out.append(session.run(["values"], {"state": r[None, :STATE], "actions": r[None, STATE:]})[0][0, 0])
    return np.array(out, np.float32)


class GroupingTest(unittest.TestCase):
    def test_new_decision_after_pass_even_with_the_same_state(self):
        np.testing.assert_array_equal(learner.decision_starts(synthetic_rows()), [0, 3, 5])

    def test_keep_set_is_strictly_within_a_quarter_point_of_the_best(self):
        y = np.array([1.0, 0.875, 0.75, -1.0, 0.5, 0.5, 2.0, 2.0], np.float32)
        keep, informative = learner.keep_mask(y, np.array([0, 4, 6]))
        np.testing.assert_array_equal(keep, [True, True, False, False, True, True, True, True])
        np.testing.assert_array_equal(informative, [True, False, False])

    def test_dataset_checks_manifest_counts_and_labels(self):
        x = synthetic_rows()
        y = np.array([1, 0, -1, 0.5, 0.5, 2, -2], np.float32)
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            write_shard(directory, "s0-000000", x, y, 3)
            data = learner.Dataset(directory, ["s0-000000"])
            self.assertEqual((data.rows, data.decisions), (7, 3))
            np.testing.assert_array_equal(data.lengths, [3, 2, 2])
            np.testing.assert_array_equal(data.informative, [True, False, True])
            rows, segment = data.rows_of(np.array([2, 0]))
            np.testing.assert_array_equal(rows, [5, 6, 0, 1, 2])
            np.testing.assert_array_equal(segment, [0, 0, 1, 1, 1])
            write_shard(directory, "s0-000001", x, y, 4)
            with self.assertRaisesRegex(ValueError, "manifest says 4"):
                learner.Dataset(directory, ["s0-000001"])
            write_shard(directory, "s0-000002", x, np.full(7, 3.5, np.float32), 3)
            with self.assertRaisesRegex(ValueError, "signed round points"):
                learner.Dataset(directory, ["s0-000002"])


class LossTest(unittest.TestCase):
    def test_grouped_loss_matches_a_hand_computation(self):
        # Decision 0 informative: rows 0, 1 kept, row 2 rejected. Decision 1 silent.
        f = torch.tensor([0.1, -0.2, 0.3, 0.05, -0.05], requires_grad=True)
        c = torch.tensor([1.0, 0.8, 0.9, 0.0, 0.2])
        keep = torch.tensor([True, True, False, True, True])
        segment = torch.tensor([0, 0, 0, 1, 1])
        informative = torch.tensor([True, False])
        loss, parts = learner.residual_loss(f, c, keep, segment, informative, 2)
        q = (c + f).detach().numpy()
        keep0 = (0.1**2 + 0.2**2) / 2
        hinge = max(0.0, 0.125 + q[2] - min(q[0], q[1])) ** 2
        silent = (0.05**2 + 0.05**2) / 2
        self.assertAlmostEqual(float(loss.detach()), ((keep0 + hinge) + silent) / 2, places=6)
        self.assertAlmostEqual(float(parts["reject"].detach()), hinge, places=6)
        self.assertEqual(int(parts["activeHinges"]), 1)
        loss.backward()
        self.assertGreater(float(f.grad[2]), 0)  # the rejected move is pushed down
        self.assertLess(float(f.grad[1]), 0)  # the lowest kept move is pushed up (and toward 0)

    def test_champion_is_a_zero_loss_point_when_it_already_separates(self):
        f = torch.zeros(3)
        c = torch.tensor([1.0, 0.5, 0.2])
        loss, _ = learner.residual_loss(
            f, c, torch.tensor([True, True, False]), torch.zeros(3, dtype=torch.long), torch.tensor([True]), 1
        )
        self.assertEqual(float(loss), 0.0)

    def test_cosine_schedule(self):
        self.assertAlmostEqual(learner.cosine_lr(0, 100, 5e-5, 5e-6), 5e-5)
        self.assertAlmostEqual(learner.cosine_lr(100, 100, 5e-5, 5e-6), 5e-6)
        self.assertAlmostEqual(learner.cosine_lr(50, 100, 5e-5, 5e-6), 2.75e-5)


class ExportTest(unittest.TestCase):
    def setUp(self):
        self.champion = load_onnx_weights(BASELINE)
        self.x = np.random.default_rng(3).integers(-1, 3, (40, FEATURES)).astype(np.int8)

    def test_residual_starts_at_exactly_zero(self):
        residual = ValueNet(zero_output_residual(self.champion))
        champion = ValueNet(self.champion)
        x = torch.from_numpy(self.x.astype(np.float32))
        with torch.no_grad():
            self.assertTrue(torch.equal(residual(x), torch.zeros(len(x))))
            self.assertTrue(torch.equal(champion(x) + residual(x), champion(x)))

    def test_fused_graph_equals_champion_plus_residual(self):
        rng = np.random.default_rng(5)
        residual = [(w + rng.normal(0, 0.05, w.shape)).astype(np.float32) for w in zero_output_residual(self.champion)]
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            save_residual(residual, directory / "r.npz")
            for a, b in zip(load_residual(directory / "r.npz"), residual):
                np.testing.assert_array_equal(a, b)
            fused_onnx(self.champion, residual, directory / "fused.onnx")
            reference = torch_values(self.champion, residual, self.x)
            self.assertGreater(np.abs(reference - torch_values(self.champion, zero_output_residual(self.champion), self.x)).max(), 1e-3)
            np.testing.assert_allclose(ort_values(directory / "fused.onnx", self.x), reference, atol=1e-4)
            fused_onnx(self.champion, zero_output_residual(self.champion), directory / "zero.onnx")
            export_onnx(self.champion, directory / "champion.onnx")
            np.testing.assert_array_equal(ort_values(directory / "zero.onnx", self.x), ort_values(directory / "champion.onnx", self.x))
            with self.assertRaises(ValueError):
                load_onnx_weights(directory / "fused.onnx")  # never mistaken for a plain champion file


class TrainingTest(unittest.TestCase):
    def test_short_run_exports_the_final_step_and_zero_steps_is_the_champion(self):
        rng = np.random.default_rng(11)
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            shards = directory / "shards"
            shards.mkdir()
            for slot in (0, 6):
                x = np.concatenate([synthetic_rows(slot * 10 + k) for k in range(4)])
                y = rng.choice([-1.0, -0.5, 0.0, 0.25, 1.0, 2.0], len(x)).astype(np.float32)
                write_shard(shards, f"s{slot}-000000", x, y, len(learner.decision_starts(x)))
            common = ["--shards", str(shards), "--champion", str(BASELINE), "--device", "cpu", "--threads", "1",
                      "--train-slots", "0", "--batch-decisions", "8", "--log-every", "2"]
            summary = learner.train(learner.parse(common + ["--out", str(directory / "a"), "--steps", "4", "--seed", "7"]))
            self.assertEqual(summary["step"], 4)
            self.assertEqual(summary["stopReason"], "steps")
            self.assertEqual([e["step"] for e in summary["losses"]], [2, 4])
            self.assertTrue((directory / "a" / "fused.onnx").exists())
            self.assertEqual(summary["validation"]["step0"]["differsFromChampion"], 0.0)
            zero = learner.train(learner.parse(common + ["--out", str(directory / "z"), "--steps", "0"]))
            self.assertEqual(zero["step"], 0)
            residual = load_residual(directory / "z" / "residual.npz")
            self.assertFalse(residual[-2].any() or residual[-1].any())
            x = synthetic_rows(99)
            export_onnx(load_onnx_weights(BASELINE), directory / "champion.onnx")
            np.testing.assert_array_equal(ort_values(directory / "z" / "fused.onnx", x), ort_values(directory / "champion.onnx", x))
            self.assertEqual(residual_champion(directory / "a" / "residual.npz"), summary["champion"]["sha256"])
            self.assertIn("residual-learner.py", summary["sources"])
            # A finished (or STOPped) run directory is never overwritten by a new run.
            before = (directory / "a" / "fused.onnx").read_bytes()
            with self.assertRaisesRegex(SystemExit, "already holds"):
                learner.train(learner.parse(common + ["--out", str(directory / "a"), "--steps", "0"]))
            self.assertEqual((directory / "a" / "fused.onnx").read_bytes(), before)
            (directory / "s").mkdir()
            (directory / "s" / "STOP").touch()
            with self.assertRaisesRegex(SystemExit, "STOP"):
                learner.train(learner.parse(common + ["--out", str(directory / "s"), "--steps", "2"]))

    def test_validation_deal_seeds_must_not_overlap_training(self):
        with tempfile.TemporaryDirectory() as directory:
            shards = Path(directory)
            for slot, seeds in ((0, [100, 199]), (6, [150, 250])):
                x = synthetic_rows(slot)
                write_shard(shards, f"s{slot}-000000", x, np.zeros(len(x)), len(learner.decision_starts(x)))
                meta = json.loads((shards / f"s{slot}-000000.json").read_text())
                (shards / f"s{slot}-000000.json").write_text(json.dumps({**meta, "slot": slot, "seeds": seeds}))
            args = ["--shards", str(shards), "--champion", str(BASELINE), "--device", "cpu", "--train-slots", "0"]
            with self.assertRaisesRegex(SystemExit, "deal seeds overlap"):
                learner.train(learner.parse(args + ["--out", str(shards / "out"), "--steps", "0"]))
            meta = json.loads((shards / "s6-000000.json").read_text())
            (shards / "s6-000000.json").write_text(json.dumps({**meta, "slot": 5}))
            with self.assertRaisesRegex(ValueError, "does not match the file name"):
                learner.Dataset(shards, ["s6-000000"])


class ExportCliTest(unittest.TestCase):
    def test_export_refuses_a_residual_trained_against_another_champion(self):
        champion = load_onnx_weights(BASELINE)
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            save_residual(zero_output_residual(champion), directory / "r.npz", champion_sha256="0" * 64)
            result = subprocess.run(
                [sys.executable, str(ROOT / "training" / "continuous" / "residual_export.py"), "export",
                 "--champion", str(BASELINE), "--residual", str(directory / "r.npz"), "--out", str(directory / "f.onnx")],
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("trained against champion", result.stderr)
            self.assertFalse((directory / "f.onnx").exists())


if __name__ == "__main__":
    unittest.main()
