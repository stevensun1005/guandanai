import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("divergence", ROOT / "ai/research/tools/match-objective-divergence.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class MatchObjectiveTest(unittest.TestCase):
    def test_empty_replay_and_exact_state_deltas(self):
        result = subprocess.run(["node", "--input-type=module", "-e", tool.REPLAY],
                                input="[]", text=True, capture_output=True, cwd=ROOT, check=True)
        table = json.loads(result.stdout)["transitions"]
        self.assertEqual(len(table), 36)
        k = [r for r in table if r["ownLevel"] == 13 and r["activeTeam"] == 0
             and r["signedRoundPoints"] > 0]
        self.assertEqual([r["ownLevelDelta"] for r in k], [1, 1, 1])
        a = [r for r in table if r["ownLevel"] == 14 and r["activeTeam"] == 0
             and r["signedRoundPoints"] == 1][0]
        self.assertEqual(a["failedAAttempt"], 1)
        self.assertIsNone(a["terminal"])

    def test_ratio_cluster_and_zero_denominator(self):
        r = tool.summarize([[1, 2, 1, 2, 1, 1, 0, 2, 1, 20, 1]] * 5, 100)
        self.assertEqual(r["metrics"]["ownAPlusOnePerOwnAAttempt"]["pairedSeedCluster95CI"], [.5, .5])
        self.assertEqual(r["matches"], 10)
        zero = tool.summarize([[0] * 11], 100)
        self.assertIsNone(zero["metrics"]["matchWinRate"]["estimate"])

    def test_reject_invalid_history(self):
        result = subprocess.run(["node", "--input-type=module", "-e", tool.REPLAY],
                                input=json.dumps([{"games": [{"neuralTeam": 0}, {"neuralTeam": 0}]}]),
                                text=True, capture_output=True, cwd=ROOT)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
