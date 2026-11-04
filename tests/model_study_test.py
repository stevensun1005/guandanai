"""Evidence checks must reject incomplete, mismatched or falsely paired results."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "scripts/update-model-study.py"
spec = importlib.util.spec_from_file_location("model_study", MODULE)
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)


class ModelStudyTests(unittest.TestCase):
    def write(self, path, rows, **overrides):
        manifest = {
            "status": "complete",
            "evaluate": True,
            "games": len(rows),
            "completedGames": len(rows),
            "wins": sum(r["winner"] == r["neuralTeam"] for r in rows),
            "draws": sum(r["winner"] is None for r in rows),
            **overrides,
        }
        (path / "rollout.json").write_text(json.dumps(manifest))
        (path / "matches.jsonl").write_text("\n".join(json.dumps(r) for r in rows))

    def test_draws_stay_in_denominator_and_uncertainty_uses_seeds(self):
        rows = [
            {"seed": 11 + i // 2, "neuralTeam": i % 2, "winner": winner}
            for i, winner in enumerate([0, None, 1, 1])
        ]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.write(path, rows)
            result = study.evaluation(path)
            self.assertEqual((result["wins"], result["draws"], result["losses"]), (2, 1, 1))
            self.assertEqual(result["winRate"], 0.5)
            self.assertEqual(result["pairs"], 2)
            self.assertEqual(sum(r["wins"] for r in result["seedResults"]), 2)

    def test_zero_wins_does_not_produce_zero_uncertainty(self):
        rows = [{"seed": 50 + i // 2, "neuralTeam": i % 2, "winner": 1 - i % 2} for i in range(128)]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.write(path, rows)
            result = study.evaluation(path)
            self.assertEqual(result["clusterHoeffding95CI"][0], 0)
            self.assertGreater(result["clusterHoeffding95CI"][1], 0)

    def test_aggregate_and_incomplete_evidence_are_rejected(self):
        rows = [{"seed": 1, "neuralTeam": team, "winner": 0} for team in [0, 1]]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            for override in [{"wins": 2}, {"status": "running"}, {"completedGames": 1}]:
                self.write(path, rows, **override)
                with self.assertRaises(ValueError):
                    study.evaluation(path)

    def test_legacy_sampling_is_not_reported_as_paired_greedy_evaluation(self):
        rows = [{"seed": i, "neuralTeam": i % 2, "winner": 0} for i in range(4)]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.write(path, rows)
            with self.assertRaisesRegex(ValueError, "team assignments"):
                study.evaluation(path)
            self.write(path, rows, evaluate=False)
            result = study.evaluation(path)
            self.assertFalse(result["greedyProtocol"])
            self.assertIsNone(result["pairs"])
            self.assertIsNone(result["clusterHoeffding95CI"])


if __name__ == "__main__":
    unittest.main()
