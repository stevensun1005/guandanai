"""Corruption and late-flush checks for read-only stop audits (no Torch dependency)."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("audit_stop", Path(__file__).parents[1] / "tools/audit-continuous-stop.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class StopAuditTests(unittest.TestCase):
    def shard(self, root, name="a00-000000001"):
        metadata = {"rows": 2, "features": 567, "targets": ["roundPoints", "matchResult", "roundIndex", "matchRounds"], "matches": 1}
        (root / f"{name}.json").write_text(json.dumps(metadata))
        (root / f"{name}.x.i8").write_bytes(bytes(2 * 567))
        (root / f"{name}.y.f32").write_bytes(struct.pack("<8f", 3, 1, 0, 2, -1, -1, 1, 2))

    def test_complete_shards_distinguish_retained_and_unconsumed_tail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.shard(root)
            self.shard(root, "a01-000000002")
            result = AUDIT.audit_shards(root, ["a00-000000001.json"])
            self.assertEqual(result["retainedRows"], 4)
            self.assertEqual(result["pendingRows"], 2)
            self.assertEqual(result["pendingShards"], ["a01-000000002.json"])

    def test_truncation_nonfinite_targets_and_unpublished_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.shard(root)
            target = root / "a00-000000001.y.f32"
            target.write_bytes(b"bad")
            with self.assertRaisesRegex(ValueError, "size mismatch"):
                AUDIT.audit_shards(root, [])
            target.write_bytes(struct.pack("<8f", float("nan"), 1, 0, 2, -1, -1, 1, 2))
            with self.assertRaisesRegex(ValueError, "Non-finite"):
                AUDIT.audit_shards(root, [])
            target.write_bytes(struct.pack("<8f", 3, 1, 2, 2, -1, -1, 1, 2))
            with self.assertRaisesRegex(ValueError, "round bounds"):
                AUDIT.audit_shards(root, [])
            self.shard(root)
            orphan = root / "orphan.x.i8"
            orphan.write_bytes(b"unpublished")
            with self.assertRaisesRegex(ValueError, "Orphan"):
                AUDIT.audit_shards(root, [])
            orphan.unlink()
            with self.assertRaisesRegex(ValueError, "missing retained"):
                AUDIT.audit_shards(root, ["missing.json"])

    def test_actor_results_must_match_counters_and_never_repeat_seeds(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            actor = {"slot": 0, "pid": 999999, "matches": 1, "rows": 7, "decisions": 7, "failures": 0, "nextSeed": 3000001, "shardSequence": 2}
            record = {"seed": 1003000000, "decisions": 7}
            (root / "actor-0.json").write_text(json.dumps(actor))
            log = root / "results-0.jsonl"
            log.write_text(json.dumps(record) + "\n")
            self.assertEqual(AUDIT.audit_actor_logs(root, 3000000)[0]["allocatedSeedsWithoutResult"], 0)
            log.write_text((json.dumps(record) + "\n") * 2)
            with self.assertRaisesRegex(ValueError, "Repeated seed"):
                AUDIT.audit_actor_logs(root, 3000000)
            log.write_text(json.dumps({"seed": 1103000000, "decisions": 7}) + "\n")
            with self.assertRaisesRegex(ValueError, "reserved actor block"):
                AUDIT.audit_actor_logs(root, 3000000)
