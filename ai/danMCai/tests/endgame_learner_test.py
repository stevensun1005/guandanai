"""The endgame learner starts as an exact champion copy and exports a web-compatible student."""

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training" / "continuous"))
sys.path.insert(0, str(ROOT / "endgame"))
from learner import ORACLE, Learner, OracleValueNet, keep_probability, labels_valid  # noqa: E402
from value_net import FEATURES, ValueNet, export_onnx, load_onnx_weights  # noqa: E402
from rebase import transferred_state  # noqa: E402
from stop_audit import audit as audit_endgame  # noqa: E402

BASELINE = ROOT / "models" / "baseline" / "policy.onnx"


class EndgameLearnerTest(unittest.TestCase):
    def test_stop_audit_checks_export_against_saved_network_and_new_adam_steps(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            self.make_run(run)
            learner = Learner(run)
            learner.replay.add(np.zeros((8, FEATURES), np.int8), np.zeros((8, ORACLE), np.int8), np.ones(8, np.float32))
            learner.train_step()
            learner.save()
            learner.publish()
            result = audit_endgame(run)
            self.assertTrue(result["networkExactlyMatchesCheckpoint"])
            self.assertTrue(result["adamMatchesNewUpdates"])
            self.assertEqual(result["newUpdates"], 1)
            self.assertEqual(result["adamStates"], 13)

    def test_transfer_adds_the_learned_delta_and_keeps_oracle_without_mutating_inputs(self):
        old = {"layers.0.bias": torch.tensor([1., 2.])}
        new = {"layers.0.bias": torch.tensor([3., 5.])}
        trained = {"layers.0.bias": torch.tensor([1.5, 1.]), "oracle_weight": torch.tensor([7.])}
        result = transferred_state(trained, old, new)
        self.assertTrue(torch.equal(result["layers.0.bias"], torch.tensor([3.5, 4.])))
        self.assertTrue(torch.equal(result["oracle_weight"], trained["oracle_weight"]))
        self.assertTrue(torch.equal(transferred_state(trained, old, old)["layers.0.bias"], trained["layers.0.bias"]))
        self.assertTrue(torch.equal(trained["layers.0.bias"], torch.tensor([1.5, 1.])))
        with self.assertRaises(ValueError):
            transferred_state(trained, old, {})

    def test_keep_schedule(self):
        self.assertEqual(keep_probability(0, 100), 1.0)
        self.assertAlmostEqual(keep_probability(50, 100), 0.5)
        self.assertEqual(keep_probability(100, 100), 0.0)
        self.assertEqual(keep_probability(500, 100), 0.0)

    def test_label_kinds(self):
        points = np.array([-3, -1, 2, 3], np.float32)
        averaged = np.array([-2.75, 0.0, 1.125, 3.0], np.float32)
        self.assertTrue(labels_valid(points))
        self.assertFalse(labels_valid(averaged))
        self.assertTrue(labels_valid(averaged, "pimc-mean"))
        self.assertFalse(labels_valid(np.array([3.5], np.float32), "pimc-mean"))
        self.assertFalse(labels_valid(np.array([np.nan], np.float32), "pimc-mean"))
        with self.assertRaises(ValueError):
            labels_valid(points, "unknown")

    def test_initial_network_ignores_oracle_and_equals_champion(self):
        weights = load_onnx_weights(BASELINE)
        base, oracle_net = ValueNet(weights), OracleValueNet(weights)
        x = torch.from_numpy(np.random.default_rng(1).integers(-1, 3, (64, FEATURES)).astype(np.float32))
        o = torch.from_numpy(np.random.default_rng(2).integers(0, 3, (64, ORACLE)).astype(np.float32))
        with torch.no_grad():
            self.assertTrue(torch.equal(base(x), oracle_net(x, o)))
            self.assertTrue(torch.equal(oracle_net(x, o), oracle_net(x, torch.zeros_like(o))))

    def test_student_export_is_the_trunk(self):
        weights = load_onnx_weights(BASELINE)
        net = OracleValueNet(weights)
        with torch.no_grad():
            net.oracle_weight.add_(0.5)
            net.layers[0].bias.add_(0.01)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "student.onnx"
            export_onnx(net.weights(), path)
            exported = load_onnx_weights(path)
        for a, b in zip(exported, net.weights()):
            np.testing.assert_array_equal(a, b)

    def test_prune_keeps_newest_ingested_rows_and_metadata(self):
        import json
        import os

        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / "shards").mkdir()
            (run / "models").mkdir()
            config = {
                "deadline": "2099-01-01T00:00:00Z",
                "champion": {"file": str(BASELINE)},
                "learner": {"device": "cpu", "threads": 1, "seed": 1, "learningRate": 1e-5,
                            "batch": 8, "capacity": 100, "minSamples": 1, "replayRatio": 4,
                            "oracleDecaySteps": 10, "exportSeconds": 600, "keepShardRows": 25},
            }
            (run / "config.json").write_text(json.dumps(config))
            for i in range(4):
                base = run / "shards" / f"s0-{i:06d}"
                np.zeros((10, FEATURES), np.int8).tofile(f"{base}.x.i8")
                np.zeros((10, ORACLE), np.int8).tofile(f"{base}.o.i8")
                np.ones(10, np.float32).tofile(f"{base}.y.f32")
                Path(f"{base}.json").write_text(json.dumps({"rows": 10}))
                os.utime(f"{base}.json", (1000 + i, 1000 + i))
            learner = Learner(run)
            self.assertEqual(learner.ingest(), 40)
            learner.prune()
            remaining = sorted(p.name for p in (run / "shards").glob("*.y.f32"))
            self.assertEqual(remaining, ["s0-000002.y.f32", "s0-000003.y.f32"])
            self.assertEqual(len(list((run / "shards").glob("*.json"))), 4)
            self.assertEqual(learner.pruned_rows, 20)
            learner.save()
            resumed = Learner(run)  # refill must skip pruned shards without failing
            self.assertEqual(resumed.replay.size, 20)

    def make_run(self, run, learning_rate=1e-5, init=None, decay=10):
        import json
        import os

        (run / "shards").mkdir(parents=True)
        (run / "models").mkdir()
        config = {
            "deadline": "2099-01-01T00:00:00Z",
            "champion": {"file": str(BASELINE)},
            "learner": {"device": "cpu", "threads": 1, "seed": 1, "learningRate": learning_rate,
                        "batch": 8, "capacity": 100, "minSamples": 1, "replayRatio": 4,
                        "oracleDecaySteps": decay, "exportSeconds": 600, "keepShardRows": 1000},
        }
        if init:
            config["learner"]["init"] = init
        (run / "config.json").write_text(json.dumps(config))
        rng = np.random.default_rng(7)
        for i in range(2):
            base = run / "shards" / f"s0-{i:06d}"
            rng.integers(-1, 3, (10, FEATURES)).astype(np.int8).tofile(f"{base}.x.i8")
            rng.integers(0, 3, (10, ORACLE)).astype(np.int8).tofile(f"{base}.o.i8")
            rng.choice(np.array([-2, -1, 1, 2], np.float32), 10).tofile(f"{base}.y.f32")
            Path(f"{base}.json").write_text(json.dumps({"rows": 10}))
            os.utime(f"{base}.json", (1000 + i, 1000 + i))

    def test_new_run_starts_from_checkpoint_with_fresh_shard_bookkeeping(self):
        import json
        import shutil

        from value_net import sha256

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            self.make_run(source)
            old = Learner(source)
            old.ingest()
            for _ in range(12):
                old.train_step()
            old.save()
            old.publish()
            checkpoint = source / "learner" / "checkpoint.pt"
            digest = sha256(checkpoint)
            student = json.loads((source / "models" / "latest.json").read_text())

            target = Path(directory) / "target"
            init = {"sha256": digest, "file": "learner/init.pt"}
            self.make_run(target, learning_rate=3e-6, init=init)
            (target / "learner").mkdir()
            shutil.copyfile(checkpoint, target / "learner" / "init.pt")
            new = Learner(target)

            self.assertEqual(new.step, 12)
            for a, b in zip(new.net.state_dict().values(), old.net.state_dict().values()):
                self.assertTrue(torch.equal(a, b))
            self.assertEqual(new.optimizer.param_groups[0]["lr"], 3e-6)
            self.assertEqual(len(new.optimizer.state), len(old.optimizer.state))
            self.assertEqual(keep_probability(new.step, 10), 0.0)
            # The first export is the inherited student itself, byte for byte.
            self.assertEqual(json.loads((target / "models" / "latest.json").read_text()), student)
            # Same shard names as the source run, but nothing counts as already ingested.
            self.assertEqual((new.trained_rows, new.ingested_rows, len(new.ingested)), (0, 0, 0))
            self.assertEqual(new.ingest(), 20)
            self.assertEqual(new.inherited["step"], 12)
            self.assertEqual(new.inherited["trainedRows"], 96)
            self.assertEqual(new.inherited["ingestedRows"], 20)
            self.assertEqual(new.inherited["chain"], [digest])

            new.train_step()
            new.save()
            resumed = Learner(target)  # restarts resume the new run, not the init file
            self.assertEqual(resumed.step, 13)
            self.assertEqual(resumed.inherited, new.inherited)
            self.assertEqual(resumed.optimizer.param_groups[0]["lr"], 3e-6)

    def test_init_checkpoint_sha_mismatch_refuses(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            self.make_run(source)
            Learner(source).save()
            target = Path(directory) / "target"
            self.make_run(target, init={"sha256": "0" * 64, "file": "learner/init.pt"})
            (target / "learner").mkdir()
            (target / "learner" / "init.pt").write_bytes((source / "learner" / "checkpoint.pt").read_bytes())
            with self.assertRaises(RuntimeError):
                Learner(target)


if __name__ == "__main__":
    unittest.main()
