"""Check match-end labels and learning after first-out on a real legal position."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT / "ai/danMCai/training"))
from match_learning import MatchEngine, match_features  # noqa: E402
from ppo_learning import load_actor  # noqa: E402


class MatchLearningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        code = """
import { createRound, advanceRound } from './ai/shared/simulation/simulation.mjs';
import { candidates } from './web/src/ai/candidates.js';
import { policyState,decisionContext } from './web/src/ai/observation.js';
const game=createRound(33000104);
for(let i=0;i<1000;i++){
 const plays=candidates(game.hands[game.turn],game.L,game.trick?.play);
 if(game.out.length&&plays.length>1){
  const state=policyState(game,game.turn,0,plays);
  state.trick=decisionContext(game,game.turn).trick;
  state.actionShapes=plays.map(p=>p&&({type:p.type,value:p.value,n:p.n}));
  state.match={levels:[game.L===2?5:2,game.L],lvlTeam:1,aFails:[0,1],round:4,previousOrder:[1,3,0,2]};
  console.log(JSON.stringify(state));break;
 }
 const play=plays.toSorted((a,b)=>(b?.cards.length||0)-(a?.cards.length||0))[0];
 if(advanceRound(game,play))throw Error('No post-first-out position');
}
"""
        cls.state = json.loads(
            subprocess.check_output(
                ["node", "--input-type=module", "-e", code], cwd=ROOT, text=True
            )
        )

    def test_after_first_out_is_recorded_and_match_terminal_labels_are_used(self):
        for outcome, target in [(self.state["p"] % 2, 1), (1 - self.state["p"] % 2, -1), (None, 0)]:
            with tempfile.TemporaryDirectory() as temporary:
                engine = MatchEngine(ROOT / "ai/danMCai/models/baseline/policy.onnx")
                engine.initialize({"output": temporary, "seed": 32, "options": {"games": 1}})
                engine.decide({"state": self.state, "episode": 0, "seat": self.state["p"]})
                self.assertEqual(len(engine.pending[0]), 1)
                engine.finish({"episode": 0, "winner": outcome})
                engine.close()
                aux = np.fromfile(Path(temporary) / "aux.f32", dtype="<f4")
                self.assertEqual(float(aux[3 * engine.config["k"] + 2]), target)
                weights, config, _ = load_actor(Path(temporary) / "behavior.npz")
                self.assertEqual(config["objective"], "full-match")
                self.assertEqual(weights["actor_w0"].shape, (573, 64))

    def test_match_progress_features_use_relative_public_information(self):
        before = match_features(self.state)
        self.assertEqual(before.shape, (8,))
        opposite = {**self.state, "p": (self.state["p"] + 1) % 4}
        after = match_features(opposite)
        np.testing.assert_array_equal(before[:2], after[:2][::-1])
        np.testing.assert_array_equal(before[2:4], after[2:4][::-1])
        self.assertEqual(before[4], 1 - after[4])


if __name__ == "__main__":
    unittest.main()
