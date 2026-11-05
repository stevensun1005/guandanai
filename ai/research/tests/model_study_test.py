"""Evidence checks must reject incomplete, mismatched or falsely paired results."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

MODULE = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file()) / "ai/research/tools/update-model-study.py"
spec = importlib.util.spec_from_file_location("model_study", MODULE)
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)


class ModelStudyTests(unittest.TestCase):
    def test_publication_signal_ignores_sampling_ticks_and_triggers_on_completed_results(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            directory = workspace / "ai/local/runs/main"
            directory.mkdir(parents=True)
            report, target = self.continuous_fixture(directory)
            report["status"] = "running"
            target.write_text(json.dumps(report))
            initial = study.publication_signal(workspace)
            status_path = directory / "status.json"
            status = json.loads(status_path.read_text())
            status["totals"]["matches"] += 100
            status["learner"]["step"] += 50
            status_path.write_text(json.dumps(status))
            self.assertEqual(study.publication_signal(workspace), initial)
            report["status"] = "complete"
            target.write_text(json.dumps(report))
            completed = study.publication_signal(workspace)
            self.assertNotEqual(completed, initial)
            self.assertEqual(study.publication_signal(workspace), completed)
            report["status"] = "stopped"
            target.write_text(json.dumps(report))
            interrupted = study.publication_signal(workspace)
            self.assertNotEqual(interrupted, completed)
            status.update(stoppedAt="2026-11-04T01:00:00Z", stopReason="anchor-regression")
            status_path.write_text(json.dumps(status))
            self.assertNotEqual(study.publication_signal(workspace), interrupted)

    def test_continuous_totals_include_remote_actor_slots(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "run"
            directory.mkdir()
            self.continuous_fixture(directory)
            actors = directory / "actors"
            actors.mkdir()
            for slot, matches in ((0, 5), (1, 4), (9, 6)):
                (actors / f"actor-{slot}.json").write_text(
                    json.dumps({"matches": matches, "decisions": 10 * matches, "rows": 9})
                )
            (actors / "claim-9.json").write_text(json.dumps({"slot": 9, "host": "laptop"}))
            snapshot = study.continuous_snapshot(directory)
            self.assertEqual(snapshot["totals"], {"matches": 15, "decisions": 150, "rows": 27})
            self.assertEqual(snapshot["actorSlots"], [0, 1, 9])
            self.assertEqual(snapshot["remoteActorHosts"], {"laptop": [9]})
            self.assertEqual(snapshot["supervisorLocalTotals"]["matches"], 7)

    def continuous_fixture(self, directory):
        for child in ("gate", "anchor", "champion"):
            (directory / child).mkdir()
        config = {
            "createdAt": "2026-11-04T00:00:00Z",
            "initialSHA256": "a" * 64,
            "sourceSHA256": {"encoder": "b" * 64},
        }
        (directory / "config.json").write_text(json.dumps(config))
        (directory / "status.json").write_text(
            json.dumps(
                {
                    "running": ["learner"],
                    "elapsedSeconds": 60,
                    "totals": {"matches": 7, "decisions": 99},
                    "learner": {"step": 3},
                }
            )
        )
        (directory / "champion/champion.json").write_text(
            json.dumps(
                {
                    "version": "v0",
                    "sha256": "a" * 64,
                    "history": [{"version": "v0", "reason": "initial"}],
                }
            )
        )
        pairs = [{"seed": 3_600_000_000 + i, "scores": [0, 0.5]} for i in range(150)]
        report = {
            "kind": "anchor",
            "status": "complete",
            "pairs": pairs,
            "firstSeed": 3_600_000_000,
            "wins": 0,
            "losses": 150,
            "draws": 150,
            "protocol": "greedy paired network",
            "settings": {"minPairs": 150, "maxPairs": 150},
            "challenger": {"file": "candidate.onnx", "sha256": "c" * 64},
            "champion": {"file": "anchor.onnx", "sha256": "a" * 64},
            "decision": "regression",
        }
        target = directory / "anchor/anchor-00000.json"
        target.write_text(json.dumps(report))
        return report, target

    def test_continuous_snapshot_reports_real_counts_hashes_and_nonacceptance_role(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.continuous_fixture(directory)
            run = study.continuous_snapshot(directory)
            check = run["anchorChecks"][0]
            self.assertEqual((check["wins"], check["losses"], check["draws"]), (0, 150, 150))
            self.assertEqual(check["meanScore"], 0.25)
            self.assertEqual(len(check["recordsSHA256"]), 64)
            self.assertEqual(len(check["seedResults"]), 150)
            self.assertEqual(run["champion"]["history"][0]["sha256"], "a" * 64)
            self.assertFalse(
                study.experiments_finished({"runs": {}, "continuousRuns": {"main": run}})
            )
            text = study.progress(
                {"runs": {}, "continuousRuns": {"main": run}, "observedUTC": "unit fixture"}
            )
            self.assertIn("11.2", text)
            self.assertIn("开发用途", text)
            self.assertIn("0/150/150", text)

    def test_continuous_corrupt_counts_wrong_seed_purpose_and_half_pairs_are_rejected(self):
        for mutation in (
            lambda r: r.update(wins=1),
            lambda r: r.update(firstSeed=3_500_000_000),
            lambda r: r["pairs"][0].update(scores=[0]),
            lambda r: r["pairs"].pop(),
        ):
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                report, target = self.continuous_fixture(directory)
                mutation(report)
                target.write_text(json.dumps(report))
                with self.assertRaises(ValueError):
                    study.continuous_evaluation(target, "anchor")

    def test_interrupted_monitor_is_not_a_complete_anchor_result(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            report, target = self.continuous_fixture(directory)
            report.update(status="stopped", pairs=report["pairs"][:1], wins=0, losses=1, draws=1)
            target.write_text(json.dumps(report))
            check = study.continuous_evaluation(target, "anchor")
            self.assertEqual(check["status"], "stopped")
            self.assertIsNone(check["decision"])

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
