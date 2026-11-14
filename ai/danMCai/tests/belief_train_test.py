"""Hand-inference network v1 trainer: masked per-copy loss, uniform start, suit symmetry, ONNX parity."""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

import importlib.util

ROOT = Path(__file__).resolve().parents[1]
# Loaded under a unique name: other suites own unrelated modules called `train`.
_spec = importlib.util.spec_from_file_location("danmcai_belief_train", ROOT / "belief" / "train.py")
belief_train = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(belief_train)
FACES, SEATS, TARGETS = belief_train.FACES, belief_train.SEATS, belief_train.TARGETS
BeliefNet, copy_loss, export_onnx = belief_train.BeliefNet, belief_train.copy_loss, belief_train.export_onnx
load_shards, parse, split_by_seed = belief_train.load_shards, belief_train.parse, belief_train.split_by_seed
suit_permutations, top1_hits, train = belief_train.suit_permutations, belief_train.top1_hits, belief_train.train
uniform_log_probs, standardization = belief_train.uniform_log_probs, belief_train.standardization

# Mirrors features.mjs LAYOUT (belief-v1).
LAYOUT = {
    "own": [0, 54],
    "unseen": [54, 108],
    "played": [108, 270],
    "counts": [270, 274],
    "out": [274, 277],
    "level": [277, 290],
    "shapes": [290, 734],
    "passOpponent": [734, 1178],
    "passPartner": [1178, 1208],
    "leads": [1208, 1238],
}
F = 1238
C0 = LAYOUT["counts"][0]


def synthetic(n, seed=0):
    """Rows with consistent targets: unseen block = sum of y over seats, counts = per-seat totals."""
    rng = np.random.default_rng(seed)
    x = np.zeros((n, F), np.uint8)
    y = np.zeros((n, TARGETS), np.uint8)
    for i in range(n):
        unseen = rng.integers(0, 3, FACES)
        for f in range(FACES):
            for _ in range(unseen[f]):
                y[i, f * SEATS + rng.integers(0, SEATS)] += 1
        x[i, 54:108] = unseen
        x[i, C0 + 1 : C0 + 4] = y[i].reshape(FACES, SEATS).sum(0)
        x[i, C0] = 27
        x[i, 290:734] = rng.integers(0, 3, 444)
    return x, y


class BeliefTrainTest(unittest.TestCase):
    def test_warm_start_preserves_probabilities_and_normalization(self):
        torch.manual_seed(29)
        x, _ = synthetic(6)
        original = BeliefNet(F, C0, np.arange(F, dtype=np.float32) / F,
                             np.full(F, .5, np.float32), hidden=32).eval()
        torch.nn.init.normal_(original.l3.weight, std=.02)
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "base.onnx"
            export_onnx(original, file)
            student = BeliefNet(F, C0, np.zeros(F), np.ones(F), hidden=32).eval()
            belief_train.load_initial_onnx(student, file)
            xt = torch.tensor(x, dtype=torch.float32)
            torch.testing.assert_close(original(xt), student(xt), atol=0, rtol=0)
            optimizer = torch.optim.AdamW(student.parameters())
            self.assertEqual(len(optimizer.state), 0)
            optimizer.zero_grad()
            student(xt).mean().backward()
            optimizer.step()
            checkpoint = Path(directory) / "checkpoint.pt"
            torch.save({"state":student.state_dict(),"optimizer":optimizer.state_dict(),
                        "step":1,"counts_offset":C0,"hidden":32},checkpoint)
            restored = BeliefNet(F,C0,np.zeros(F),np.ones(F),hidden=32).eval()
            adam = torch.optim.AdamW(restored.parameters())
            saved = belief_train.load_initial_checkpoint(restored,adam,checkpoint,"cpu")
            self.assertEqual(saved["step"],1)
            self.assertEqual(len(adam.state),6)
            torch.testing.assert_close(student(xt),restored(xt),atol=0,rtol=0)

    def test_loss_is_per_copy_and_masks_faces_without_unseen_copies(self):
        torch.manual_seed(0)
        lp = torch.log_softmax(torch.randn(2, FACES, SEATS), dim=2)
        y = torch.zeros(2, TARGETS)
        y[0, 3 * SEATS + 1] = 2
        y[1, 7 * SEATS + 0] = 1
        expected = -(2 * lp[0, 3, 1] + lp[1, 7, 0]) / 3
        self.assertAlmostEqual(copy_loss(lp, y).item(), expected.item(), places=6)
        # Changing predictions for faces with no unseen copy does not change the loss.
        lp2 = lp.clone()
        lp2[0, 10] = torch.log_softmax(torch.randn(SEATS), 0)
        self.assertAlmostEqual(copy_loss(lp2, y).item(), expected.item(), places=6)
        # Ties share top-1 credit.
        flat = torch.zeros(1, FACES, SEATS)
        yy = torch.zeros(1, TARGETS)
        yy[0, 0] = 3
        self.assertAlmostEqual(top1_hits(flat, yy).item(), 1.0, places=6)

    def test_untrained_network_is_the_uniform_baseline(self):
        x, _ = synthetic(16)
        mean, scale = np.zeros(F, np.float32), np.ones(F, np.float32)
        net = BeliefNet(F, C0, mean, scale, hidden=32).eval()
        xt = torch.as_tensor(x, dtype=torch.float32)
        with torch.no_grad():
            torch.testing.assert_close(net(xt), uniform_log_probs(xt, C0), atol=1e-5, rtol=0)
        # A seat with no cards gets (numerically) zero probability.
        xt[:, C0 + 2] = 0
        with torch.no_grad():
            self.assertLess(net(xt).exp()[:, :, 1].max().item(), 1e-20)

    def test_suit_permutations_relabel_the_deal_consistently(self):
        x_maps, y_maps = suit_permutations(LAYOUT, F)
        self.assertEqual(x_maps.shape, (6, F))
        self.assertEqual(y_maps.shape, (6, TARGETS))
        for xm, ym in zip(x_maps, y_maps):
            self.assertEqual(sorted(xm), list(range(F)))
            self.assertEqual(sorted(ym), list(range(TARGETS)))
            # Hearts (slot 0, home of the wild level card), jokers and suitless blocks stay fixed.
            for f in list(range(0, 52, 4)) + [52, 53]:
                self.assertEqual(xm[f], f)
                self.assertEqual(ym[f * SEATS], f * SEATS)
            np.testing.assert_array_equal(xm[270:], np.arange(270, F))
        self.assertTrue(any((xm == np.arange(F)).all() for xm in x_maps))
        x, y = synthetic(8, 3)
        for xm, ym in zip(x_maps, y_maps):
            xp, yp = x[:, xm], y[:, ym]
            np.testing.assert_array_equal(xp[:, 54:108], yp.reshape(-1, FACES, SEATS).sum(2))
            # Each face keeps its rank: only the suit slot moves.
            for f in range(FACES):
                g = int(np.flatnonzero(xm[:54] == f)[0])
                self.assertEqual(g // 4, f // 4)

    def test_chunked_standardization_matches_numpy(self):
        x, _ = synthetic(50, 7)
        rows = np.arange(3, 47)
        mean, scale = standardization(x, rows, chunk=7)
        sub = x[rows].astype(np.float64)
        np.testing.assert_allclose(mean, sub.mean(0), rtol=1e-6, atol=1e-6)
        np.testing.assert_allclose(scale, 1 / np.maximum(sub.std(0), 1), rtol=1e-5, atol=1e-6)

    def test_split_is_by_seed(self):
        meta = np.array([[s, 0, 0, 50] for s in [10, 10, 11, 20, 20, 21, 30]], np.uint32)
        val = split_by_seed(meta, val_mod=10)
        self.assertEqual(val.tolist(), [True, True, False, True, True, False, True])
        val = split_by_seed(meta, val_seeds=(20, 21))
        self.assertEqual(val.tolist(), [False, False, False, True, True, True, False])

    def test_onnx_export_matches_torch(self):
        import onnxruntime

        x, _ = synthetic(12, 5)
        rng = np.random.default_rng(1)
        mean = rng.random(F).astype(np.float32)
        scale = (0.5 + rng.random(F)).astype(np.float32)
        net = BeliefNet(F, C0, mean, scale, hidden=24).eval()
        with torch.no_grad():
            for p in net.parameters():
                p.add_(0.05 * torch.randn_like(p))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "belief.onnx"
            export_onnx(net, path)
            session = onnxruntime.InferenceSession(str(path), providers=["CPUExecutionProvider"])
            got = session.run(["probs"], {"features": x.astype(np.float32)})[0]
        with torch.no_grad():
            want = net(torch.as_tensor(x, dtype=torch.float32)).exp().numpy()
        self.assertEqual(got.shape, (12, FACES, SEATS))
        np.testing.assert_allclose(got, want, atol=2e-6)
        np.testing.assert_allclose(got.sum(2), 1, atol=1e-5)

    def test_end_to_end_on_shards_with_seed_split(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "gen"
            data.mkdir()
            # Development-range seeds exceed 2^31: they must survive the uint32 meta exactly.
            base = 3_838_129_900
            run = {"featureVersion": "belief-v1", "features": F, "layout": LAYOUT, "seeds": [base, base + 19]}
            (data / "run.json").write_text(json.dumps(run))
            for start in (base, base + 10):
                x, y = synthetic(30, start % 1000)
                m = np.array([[start + i % 10, i, 0, 50] for i in range(30)], np.uint32)
                x.tofile(data / f"b{start}.x.u8")
                y.tofile(data / f"b{start}.y.u8")
                m.tofile(data / f"b{start}.m.u32")
                (data / f"b{start}.json").write_text(
                    json.dumps({"rows": 30, "features": F, "seeds": [start, start + 9]})
                )
            x, y, meta, loaded = load_shards([data])
            self.assertEqual(x.shape, (60, F))
            self.assertEqual(loaded["layout"], LAYOUT)
            self.assertEqual(int(meta[:, 0].min()), base)
            self.assertEqual(int(split_by_seed(meta).sum()), 6)  # seeds base and base + 10
            out = Path(directory) / "model"
            report = train(parse([f"--data={data}", f"--out={out}", "--max-steps=5", "--batch=16",
                                  "--hidden=16", "--device=cpu", "--eval-every=2"]))
            self.assertEqual(report["steps"], 5)
            self.assertEqual(report["valSeeds"], 2)  # seeds base and base + 10
            self.assertEqual(report["dataProtocols"][0]["seeds"], [base, base + 19])
            self.assertTrue((out / "belief.onnx").exists())
            self.assertEqual(report["initialValidation"]["modelLogLossPerCopy"],
                             report["initialValidation"]["uniformLogLossPerCopy"])
            # Rows whose seed lies outside the block range (e.g. wrapped by a narrower type) are refused.
            m = np.fromfile(data / f"b{base + 10}.m.u32", np.uint32).reshape(30, 4)
            m[0, 0] = (base + 10) - 2**32 + 2**32 // 2
            m.tofile(data / f"b{base + 10}.m.u32")
            with self.assertRaises(ValueError):
                load_shards([data])
            # Truncated shards are refused.
            (data / f"b{base + 10}.y.u8").write_bytes(b"\0")
            with self.assertRaises(ValueError):
                load_shards([data])


if __name__ == "__main__":
    unittest.main()
