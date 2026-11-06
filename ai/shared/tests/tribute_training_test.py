"""Specialist learning/export mechanics; synthetic labels are not strength evidence."""

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

import numpy as np
import onnxruntime as ort
import torch

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT / "ai/shared/tribute"))
from train import fit, load_groups, TributeNet  # noqa: E402
from inherit import inherit  # noqa: E402


def fixture(run):
    (run / "protocol.json").write_text(
        json.dumps({"kind": "test", "deadlineEpochSeconds": time.time() + 300})
    )
    protocol = hashlib.sha256((run / "protocol.json").read_bytes()).hexdigest()
    rng = np.random.default_rng(12)
    for split, count in [("train", 8), ("development", 4)]:
        folder = run / "data" / split
        folder.mkdir(parents=True)
        for i in range(count):
            x = rng.integers(0, 3, (4, 389), dtype=np.int8).tobytes()
            y = np.array([-3, -1, 1, 3], np.float32).tobytes()
            stem = folder / f"case-{i}"
            Path(str(stem) + ".x.i8").write_bytes(x)
            Path(str(stem) + ".y.f32").write_bytes(y)
            Path(str(stem) + ".json").write_text(
                json.dumps(
                    {
                        "rows": 4,
                        "head": i % 2,
                        "baseline": 0,
                        "protocolSHA": protocol,
                        "xSHA256": hashlib.sha256(x).hexdigest(),
                        "ySHA256": hashlib.sha256(y).hexdigest(),
                    }
                )
            )


class TributeTrainingTests(unittest.TestCase):
    def test_explicit_protocol_migration_preserves_parent_and_resumes_optimizer(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory) / "parent"
            parent.mkdir()
            fixture(parent)
            before = fit(parent, "cpu", epochs=2)
            checkpoint = parent / "learner/latest.pt"
            original = checkpoint.read_bytes()
            target = Path(directory) / "successor"
            target.mkdir()
            fixture(target)
            protocol = json.loads((target / "protocol.json").read_text())
            protocol["lineage"] = {
                "parentRun": str(parent),
                "checkpointSHA256": hashlib.sha256(original).hexdigest(),
                "parentProtocolSHA256": hashlib.sha256(
                    (parent / "protocol.json").read_bytes()
                ).hexdigest(),
            }
            (target / "protocol.json").write_text(json.dumps(protocol))
            digest = hashlib.sha256((target / "protocol.json").read_bytes()).hexdigest()
            for meta_file in (target / "data").glob("*/*.json"):
                meta = json.loads(meta_file.read_text())
                meta["protocolSHA"] = digest
                meta_file.write_text(json.dumps(meta))
            report = inherit(target)
            self.assertTrue(report["allModelAndOptimizerTensorsPreserved"])
            self.assertEqual(checkpoint.read_bytes(), original)
            after = fit(target, "cpu", epochs=2)
            self.assertEqual(after["step"], before["step"] + 2)
            self.assertEqual(after["trainingGroups"], 8)

    def check_device(self, device):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            fixture(run)
            result = fit(run, device, epochs=3)
            self.assertEqual(result["device"], device)
            self.assertGreater(result["newUpdates"], 0)
            net = TributeNet()
            saved = torch.load(run / "learner/best.pt", map_location="cpu", weights_only=True)
            net.load_state_dict(saved["model"])
            x = np.random.default_rng(4).integers(0, 3, (7, 389)).astype(np.float32)
            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            options.inter_op_num_threads = 1
            session = ort.InferenceSession(
                str(run / "learner/best.onnx"),
                sess_options=options,
                providers=["CPUExecutionProvider"],
            )
            actual = session.run(None, {"features": x})[0]
            with torch.no_grad():
                expected = net(torch.from_numpy(x)).numpy()
            np.testing.assert_allclose(actual, expected, atol=1e-5, rtol=1e-5)
            resumed = fit(run, device, epochs=1)
            self.assertGreater(resumed["step"], result["step"])

    def test_cpu_fit_export_and_optimizer_resume(self):
        self.check_device("cpu")

    @unittest.skipUnless(torch.cuda.is_available(), "CUDA/ROCm hardware required")
    def test_real_gpu_fit_export_and_optimizer_resume(self):
        self.check_device("cuda:0")

    def test_changed_protocol_is_not_silently_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            fixture(run)
            (run / "protocol.json").write_text('{"changed":true}')
            with self.assertRaisesRegex(ValueError, "protocol mismatch"):
                load_groups(run, "train")


if __name__ == "__main__":
    unittest.main()
