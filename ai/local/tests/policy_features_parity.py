"""Check Python/browser residual feature parity on seeded legal trajectories."""

import json
from pathlib import Path
import subprocess
import sys

import numpy as np

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT / "ai/local/training"))
from policy_features import encode_policy_extras, encode_policy_extras_batch  # noqa: E402

SCRIPT = r"""
import { createRound, advanceRound, seededRandom } from './ai/shared/simulation/simulation.mjs';
import { candidates } from './web/src/ai/candidates.js';
import { policyState } from './web/src/ai/observation.js';
import { encodePolicyExtrasBatch } from './web/src/ai/policy-features.mjs';
const samples=[];
for(let round=0;round<24;round++) {
  const game=createRound(718001+round), random=seededRandom(880001+round);
  for(let turn=0;turn<1000;turn++) {
    const plays=candidates(game.hands[game.turn],game.L,game.trick?.play);
    if(turn%5===0) {
      const selected=plays.filter((_,i)=>i%Math.max(1,Math.floor(plays.length/32))===0).slice(0,32);
      const state=policyState(game,game.turn,0,selected);
      state.trick=game.trick;
      state.actionShapes=selected.map(play=>play&&({type:play.type,value:play.value,n:play.n}));
      samples.push({state,features:Array.from(encodePolicyExtrasBatch(state))});
    }
    const winning=plays.find(play=>play&&play.cards.length===game.hands[game.turn].length);
    const ordered=plays.toSorted((a,b)=>(b?.cards.length||0)-(a?.cards.length||0));
    const play=winning||ordered[Math.floor(random()*Math.min(4,ordered.length))];
    if(advanceRound(game,play))break;
  }
}
console.log(JSON.stringify(samples));
"""


def main():
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", SCRIPT],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    )
    samples = json.loads(completed.stdout)
    rows = 0
    for sample in samples:
        state = sample["state"]
        expected = np.array(sample["features"], dtype=np.float32).reshape(-1, 53)
        actual = encode_policy_extras_batch(state)
        np.testing.assert_array_equal(actual, expected)
        np.testing.assert_array_equal(encode_policy_extras(state, 0), expected[0])
        rows += actual.shape[0]
    print(json.dumps({"states": len(samples), "actions": rows, "maximumError": 0}))


if __name__ == "__main__":
    main()
