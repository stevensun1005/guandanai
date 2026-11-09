"""Belief-search distillation learner: grouping, search-rule check, loss, zero start, fused export,
block split and refusals (synthetic blocks in the distill-generate.mjs format)."""

import importlib.util
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training" / "continuous"))
from residual_export import load_residual, residual_champion, torch_values  # noqa: E402
from value_net import FEATURES, STATE, ValueNet, export_onnx, load_onnx_weights, sha256  # noqa: E402

spec = importlib.util.spec_from_file_location("distill_learner", ROOT / "belief" / "distill-learner.py")
learner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(learner)

BASELINE = ROOT / "models" / "baseline" / "policy.onnx"
BASELINE_SHA = sha256(BASELINE)
CHAMPION = ValueNet(load_onnx_weights(BASELINE)).eval()


def champion_q(x):
    with torch.no_grad():
        return CHAMPION(torch.from_numpy(x.astype(np.float32))).numpy().astype(np.float32)


def synthetic_block(seed, decisions=6, net=2):
    """Decisions with 2-5 candidates (pass last on some), the net-d choice computed from (y, w, c)."""
    rng = np.random.default_rng(seed)
    xs, ys, ws = [], [], []
    for d in range(decisions):
        state = rng.integers(0, 2, STATE)
        n = int(rng.integers(2, 6))
        actions = [rng.integers(0, 2, FEATURES - STATE) | np.eye(1, FEATURES - STATE, rng.integers(54), dtype=np.int64)[0]
                   for _ in range(n)]
        if d % 2:
            actions[-1] = np.zeros(FEATURES - STATE, np.int64)  # pass is always the last candidate
        for a in actions:
            xs.append(np.concatenate([state, a]))
        ys += list(rng.integers(-16, 17, n) / 8)
        ws += list(rng.integers(-8, 9, n))
    x = np.stack(xs).astype(np.int8)
    y = np.asarray(ys, np.float32)
    w = np.asarray(ws, np.int8)
    c = champion_q(x)
    starts = learner.decision_starts(x)
    lengths = np.diff(np.append(starts, len(y)))
    champion = np.array([s + int(np.argmax(c[s:s + k])) for s, k in zip(starts, lengths)])
    w[champion] = 0
    chosen = learner.search_choice(y, w, c, champion, starts, net)
    f = np.zeros(len(y), np.uint8)
    f[champion] |= learner.FLAG_CHAMPION
    f[chosen] |= learner.FLAG_CHOSEN
    return {"x": x, "y": y, "c": c, "w": w, "f": f, "decisions": len(starts)}


def write_block(directory, start, block, span=20, **meta_overrides):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    name = directory / f"b{start}"
    for key, (suffix, _) in learner.FILES.items():
        block[key].tofile(f"{name}.{suffix}")
    meta = {
        "schema": 1, "labels": learner.LABELS, "protocolVersion": learner.PROTOCOL_VERSION, "features": FEATURES,
        "seeds": [start, start + span - 1], "rows": len(block["y"]),
        "stats": {"decisions": block["decisions"]}, "settings": {"worlds": 8, "net": 2},
        "championSHA256": BASELINE_SHA, "beliefSHA256": "b" * 64,
    }
    meta.update(meta_overrides)
    Path(f"{name}.json").write_text(json.dumps(meta), encoding="utf-8")


def ort_decision_values(path, x):
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    starts = learner.decision_starts(x)
    out = []
    for s, e in zip(starts, list(starts[1:]) + [len(x)]):
        rows = x[s:e].astype(np.float32)
        out.append(session.run(["values"], {"state": rows[:1, :STATE], "actions": rows[:, STATE:]})[0][:, 0])
    return np.concatenate(out)


class SearchRuleTest(unittest.TestCase):
    def test_net_d_rule_by_hand(self):
        # Decision 0: champion row 0; row 1 better mean but only w=1 (not allowed); row 2 allowed -> 2.
        # Decision 1: champion row 3; rows 4, 5 allowed and tied on y -> higher champion Q wins (5).
        # Decision 2: champion row 6; row 7 has w=3 but a LOWER mean -> champion kept.
        y = np.array([0.0, 1.0, 0.5, 0.0, 0.75, 0.75, 1.0, 0.5], np.float32)
        w = np.array([0, 1, 2, 0, 4, 2, 0, 3], np.int8)
        c = np.array([0.9, 0.1, 0.2, 0.5, 0.1, 0.3, 0.2, 0.1], np.float32)
        starts = np.array([0, 3, 6])
        champion = np.array([0, 3, 6])
        np.testing.assert_array_equal(learner.search_choice(y, w, c, champion, starts, 2), [2, 5, 6])
        np.testing.assert_array_equal(learner.search_choice(y, w, c, champion, starts, 0), [1, 5, 6])


class GroupingTest(unittest.TestCase):
    def test_dataset_groups_and_checks_manifests(self):
        with tempfile.TemporaryDirectory() as directory:
            block = synthetic_block(1)
            write_block(directory, 1000, block)
            data = learner.Dataset([(Path(directory), "b1000")], BASELINE_SHA)
            self.assertEqual(data.decisions, block["decisions"])
            self.assertEqual(data.rows, len(block["y"]))
            self.assertTrue((data.lengths >= 2).all())
            np.testing.assert_array_equal(data.chosen_row, (block["f"] & 2) > 0)
            self.assertEqual(int(data.deviation.sum()), int(sum(
                (data.chosen != data.champion))))
            rows, segment = data.rows_of(np.array([2, 0]))
            first = np.arange(data.starts[2], data.starts[2] + data.lengths[2])
            np.testing.assert_array_equal(rows[: len(first)], first)
            np.testing.assert_array_equal(segment, np.repeat([0, 1], [data.lengths[2], data.lengths[0]]))

    def test_refuses_inconsistent_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            block = synthetic_block(2)
            write_block(directory, 1000, block, stats={"decisions": block["decisions"] + 1})
            with self.assertRaisesRegex(ValueError, "manifest says"):
                learner.Dataset([(directory, "b1000")])
            bad = dict(block, f=block["f"].copy())
            d0 = learner.decision_starts(block["x"])
            k = d0[1] - d0[0]
            row = d0[0] + int(np.flatnonzero(bad["f"][: k] & 2)[0])
            bad["f"][row] &= ~np.uint8(2)
            bad["f"][d0[0] + (row - d0[0] + 1) % k] |= np.uint8(2)
            write_block(directory, 1020, bad)
            with self.assertRaisesRegex(ValueError, "search rule"):
                learner.Dataset([(directory, "b1020")])
            write_block(directory, 1040, block, championSHA256="0" * 64)
            with self.assertRaisesRegex(ValueError, "generated with champion"):
                learner.Dataset([(directory, "b1040")], BASELINE_SHA)
            write_block(directory, 1060, block, labels="pimc-mean")
            with self.assertRaisesRegex(ValueError, "unexpected label kind"):
                learner.Dataset([(directory, "b1060")])
            moved = dict(block, f=block["f"].copy())
            first = d0[0] + int(np.flatnonzero(moved["f"][:k] & 1)[0])
            moved["f"][first] &= ~np.uint8(1)
            moved["f"][d0[0] + (first - d0[0] + 1) % k] |= np.uint8(1)  # champion flag off the argmax
            write_block(directory, 1100, moved)
            with self.assertRaisesRegex(ValueError, "argmax of the stored champion Q"):
                learner.Dataset([(directory, "b1100")])
            wide = dict(block, y=np.full_like(block["y"], 3.5))
            write_block(directory, 1080, wide)
            with self.assertRaisesRegex(ValueError, "signed round points"):
                learner.Dataset([(directory, "b1080")])

    def test_only_blocks_with_a_manifest_are_listed(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            write_block(directory, 1020, synthetic_block(3))
            write_block(directory, 1000, synthetic_block(4))
            synthetic_block(5)["x"].tofile(directory / "b1040.x.i8")  # a block still being written
            (directory / "run.json").write_text("{}")
            self.assertEqual([b[1] for b in learner.list_blocks([directory])], ["b1000", "b1020"])
            self.assertEqual([b[1] for b in learner.list_blocks([directory], 1)], ["b1000"])


class SplitTest(unittest.TestCase):
    def test_split_is_disjoint_and_by_seed_block(self):
        metas = [{"seeds": [s, s + 19]} for s in range(4264011000, 4264011000 + 40 * 20, 20)]
        train, val = learner.split_blocks(metas, 10, 0)
        self.assertEqual(sorted(train + val), list(range(40)))
        self.assertFalse(set(train) & set(val))
        self.assertEqual(val, [i for i, m in enumerate(metas) if (m["seeds"][0] // 20) % 10 == 0])
        self.assertEqual(len(val), 4)
        # The assignment of a block does not depend on which other blocks exist (growing data dirs).
        _, val_half = learner.split_blocks(metas[:20], 10, 0)
        self.assertEqual(val_half, [i for i in val if i < 20])

    def test_overlapping_seed_ranges_are_refused(self):
        with self.assertRaisesRegex(ValueError, "overlap"):
            learner.split_blocks([{"seeds": [100, 119]}, {"seeds": [110, 129]}], 10, 0)


class LossTest(unittest.TestCase):
    def test_loss_matches_a_hand_computation(self):
        # Decision 0 (deviation): rows 0-2, champion row 0, search chose row 2.
        # Decision 1 (agreement): rows 3-4, champion = chosen = row 3, champion lead 0.005 < m0.
        f = torch.tensor([0.1, -0.2, 0.05, 0.02, -0.01], requires_grad=True)
        c = torch.tensor([1.0, 0.7, 0.8, 0.5, 0.495])
        chosen = torch.tensor([False, False, True, True, False])
        segment = torch.tensor([0, 0, 0, 1, 1])
        deviation = torch.tensor([True, False])
        loss, parts = learner.distill_loss(f, c, chosen, segment, deviation, 2, keep_weight=10.0, margin=0.125,
                                           champion_margin=0.05, deviation_weight=2.0, champion_weight=3.0)
        q = (c + f).detach().numpy().astype(np.float64)
        fv = f.detach().numpy().astype(np.float64)
        keep0 = (fv[:3] ** 2).mean()
        keep1 = (fv[3:] ** 2).mean()
        dev_hinge = max(0.0, 0.125 + max(q[0], q[1]) - q[2]) ** 2
        agree_hinge = max(0.0, 0.05 + q[4] - q[3]) ** 2
        expected = ((10 * keep0 + 2 * dev_hinge) + (10 * keep1 + 3 * agree_hinge)) / 2
        self.assertAlmostEqual(float(loss.detach()), expected, places=6)
        self.assertAlmostEqual(float(parts["deviationHinge"].detach()), dev_hinge, places=6)
        self.assertAlmostEqual(float(parts["championHinge"].detach()), agree_hinge, places=6)
        self.assertEqual((int(parts["deviationActive"]), int(parts["championActive"])), (1, 1))
        loss.backward()
        # Gradient = keep part 10 * 2 f_i / n_d / D (D = 2 decisions) plus the hinge part.
        keep_grad = 10 * 2 * fv / np.array([3, 3, 3, 2, 2]) / 2
        hinge_grad = f.grad.numpy() - keep_grad
        self.assertAlmostEqual(hinge_grad[1], 0, places=6)  # row 1 is not the strongest other
        self.assertLess(hinge_grad[2], 0)  # the search's choice is pushed up
        self.assertGreater(hinge_grad[0], 0)  # the strongest other (the champion move) is pushed down
        self.assertAlmostEqual(hinge_grad[2], -2 * 2 * np.sqrt(dev_hinge) / 2, places=5)
        self.assertLess(hinge_grad[3], 0)  # agreement: champion pulled above the runner-up by m0
        self.assertGreater(hinge_grad[4], 0)

    def test_zero_residual_is_a_zero_loss_point_where_search_agrees(self):
        f = torch.zeros(3)
        loss, parts = learner.distill_loss(f, torch.tensor([1.0, 0.5, 0.2]), torch.tensor([True, False, False]),
                                           torch.zeros(3, dtype=torch.long), torch.tensor([False]), 1)
        self.assertEqual(float(loss), 0.0)
        self.assertEqual(int(parts["championActive"]), 0)


class TrainingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.data = self.dir / "data"
        for k in range(10):  # block 0 (seed 4264011000) validates under the default split
            write_block(self.data, 4264011000 + 20 * k, synthetic_block(100 + k, decisions=8))
        self.common = ["--data", str(self.data), "--champion", str(BASELINE), "--device", "cpu", "--threads", "1",
                       "--batch-decisions", "8", "--log-every", "2", "--expect-champion-sha256", BASELINE_SHA]

    def tearDown(self):
        self.tmp.cleanup()

    def test_short_run_exports_fused_final_step_equal_to_champion_plus_residual(self):
        summary = learner.train(learner.parse(self.common + ["--out", str(self.dir / "a"), "--steps", "6",
                                                             "--lr", "1e-3", "--seed", "7"]))
        self.assertEqual((summary["step"], summary["stopReason"]), (6, "steps"))
        self.assertEqual([e["step"] for e in summary["losses"]], [2, 4, 6])
        self.assertEqual(summary["data"]["validation"]["names"], ["b4264011000"])
        self.assertEqual(len(summary["data"]["train"]["names"]), 9)
        self.assertFalse(set(summary["data"]["train"]["names"]) & set(summary["data"]["validation"]["names"]))
        step0 = summary["validation"]["step0"]
        self.assertEqual((step0["agreesWithChampion"], step0["studentDeviates"]), (1.0, 0.0))
        self.assertEqual(step0["matchesSearchOnAgreement"], 1.0)
        self.assertLess(summary["champion"]["maxAbsDiffToStoredQ"], 1e-4)
        self.assertLess(summary["export"]["fused"]["maxAbsDiffToChampionPlusResidual"], 1e-4)
        self.assertIn("distill-learner.py", summary["sources"])
        self.assertIn("residual-learner.py", summary["sources"])
        residual = load_residual(self.dir / "a" / "residual.npz")
        self.assertGreater(np.abs(residual[-2]).max(), 0)
        self.assertEqual(residual_champion(self.dir / "a" / "residual.npz"), BASELINE_SHA)
        x = synthetic_block(999)["x"]
        reference = torch_values(load_onnx_weights(BASELINE), residual, x)
        np.testing.assert_allclose(ort_decision_values(self.dir / "a" / "fused.onnx", x), reference, atol=1e-4)

    def test_zero_steps_is_exactly_the_champion(self):
        summary = learner.train(learner.parse(self.common + ["--out", str(self.dir / "z"), "--steps", "0"]))
        self.assertEqual(summary["step"], 0)
        residual = load_residual(self.dir / "z" / "residual.npz")
        self.assertFalse(residual[-2].any() or residual[-1].any())
        export_onnx(load_onnx_weights(BASELINE), self.dir / "champion.onnx")
        x = synthetic_block(98)["x"]
        np.testing.assert_array_equal(ort_decision_values(self.dir / "z" / "fused.onnx", x),
                                      ort_decision_values(self.dir / "champion.onnx", x))

    def test_refusals_stop_and_deadline(self):
        out = self.dir / "used"
        out.mkdir()
        (out / "notes.txt").write_text("x")
        with self.assertRaisesRegex(SystemExit, "not an empty directory"):
            learner.train(learner.parse(self.common + ["--out", str(out), "--steps", "0"]))
        self.assertEqual(sorted(p.name for p in out.iterdir()), ["notes.txt"])
        with self.assertRaisesRegex(SystemExit, "expected"):
            learner.train(learner.parse(self.common + ["--out", str(self.dir / "e"), "--expect-champion-sha256", "0" * 64]))
        stop = self.dir / "STOP"
        stop.touch()
        # A stale STOP or a passed deadline refuses to start (no step-0 "finished" champion copy).
        with self.assertRaisesRegex(SystemExit, "STOP file already exists"):
            learner.train(learner.parse(self.common + ["--out", str(self.dir / "s"), "--steps", "5", "--stop-file", str(stop)]))
        self.assertFalse((self.dir / "s").exists())
        with self.assertRaisesRegex(SystemExit, "deadline has already passed"):
            learner.train(learner.parse(self.common + ["--out", str(self.dir / "d"), "--steps", "5",
                                                       "--deadline", str(time.time() - 1)]))
        self.assertFalse((self.dir / "d").exists())
        # A STOP that appears mid-run stops after the current step and exports that final step.
        stop.unlink()
        original = learner.cosine_lr

        def touch_then_lr(*a):
            stop.touch()
            return original(*a)

        learner.cosine_lr = touch_then_lr
        try:
            s = learner.train(learner.parse(self.common + ["--out", str(self.dir / "s"), "--steps", "5",
                                                           "--stop-file", str(stop)]))
        finally:
            learner.cosine_lr = original
        self.assertEqual((s["step"], s["stopReason"]), (1, "STOP"))
        self.assertTrue((self.dir / "s" / "fused.onnx").exists())
        other = self.dir / "other"
        write_block(other, 4264011010, synthetic_block(7))  # overlaps block 4264011000..019
        with self.assertRaisesRegex(SystemExit, "overlap"):
            learner.train(learner.parse(self.common + ["--data", str(other), "--out", str(self.dir / "o"), "--steps", "0"]))
        with self.assertRaisesRegex(SystemExit, "No training or validation blocks"):
            learner.train(learner.parse(self.common + ["--out", str(self.dir / "v"), "--steps", "0", "--val-modulo", "1000", "--val-remainder", "999"]))


if __name__ == "__main__":
    unittest.main()
