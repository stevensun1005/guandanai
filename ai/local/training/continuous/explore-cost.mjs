/**
 * Measure how much a training-time exploration rule costs in whole matches:
 * the exploring team and a greedy opponent use the same model, on paired seeds with sides swapped.
 */
import * as ort from 'onnxruntime-node';
import { playMatch } from '../../../shared/simulation/match-rollout.mjs';
import { seededRandom } from '../../../shared/simulation/simulation.mjs';
import { PROBE_SEED_BASE, createModelPool, explore, matchScore, option } from './lib.mjs';

const model = option('model', 'ai/local/models/baseline/policy.onnx');
const pairs = Number(option('pairs', '100'));
const offset = Number(option('offset', '0'));
const exploration = JSON.parse(option('exploration', '{"type":"epsilon","epsilon":0.01}'));
const pool = await createModelPool(ort);
const random = seededRandom(0x5eed + offset);
let total = 0,
  wins = 0,
  draws = 0,
  explored = 0,
  decisions = 0;
const started = Date.now();
for (let pair = 0; pair < pairs; pair++) {
  const seed = PROBE_SEED_BASE + offset + pair;
  for (const team of [0, 1]) {
    const result = await playMatch({
      seed,
      team,
      mode: 'snapshot',
      snapshotInfer: (state) => pool.values(model, state),
      decide: async (state) => {
        const values = await pool.values(model, state);
        const choice = explore(values, exploration, random);
        decisions++;
        if (choice.explored) explored++;
        return { index: choice.index };
      },
    });
    const score = matchScore(result.winner, team);
    total += score;
    if (score === 1) wins++;
    if (score === 0.5) draws++;
  }
}
await pool.close();
console.log(
  JSON.stringify({
    exploration,
    model,
    pairs,
    firstSeed: PROBE_SEED_BASE + offset,
    matches: 2 * pairs,
    wins,
    draws,
    meanScore: total / (2 * pairs),
    nonGreedyDecisionRate: explored / decisions,
    seconds: (Date.now() - started) / 1000,
  }),
);
