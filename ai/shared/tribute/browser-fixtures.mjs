import { resolve, join } from 'node:path';
import { decisionCases, scenario } from './scenarios.mjs';
import { encodeTributeBatch } from './encoding.mjs';
import { option, writeJSON } from '../../danMCai/training/continuous/lib.mjs';
const run = resolve(option('run')),
  states = [];
let table;
const counts = { tribute: 0, return: 0 };
for (let seed = 3799000200; seed < 3799010000 && (states.length < 8 || !table); seed++) {
  for (const state of decisionCases(seed))
    if (counts[state.stage] < 4) {
      const { actions, rows } = encodeTributeBatch(state);
      states.push({ state, actions, rows: Array.from(rows), baseline: state.baseline });
      counts[state.stage]++;
    }
  const { game, order } = scenario(seed);
  if (
    !table &&
    order[0] !== 0 &&
    order[3] !== 0 &&
    order[0] % 2 !== order[1] % 2 &&
    decisionCases(seed).some((s) => s.stage === 'tribute')
  )
    table = {
      hands: game.hands.map((h) => h.map((c) => c.id)),
      L: game.L,
      levels: game.levels,
      order,
    };
}
if (states.length < 8 || !table) throw Error('Missing browser fixtures');
writeJSON(join(run, 'browser-fixtures.json'), { states, table });
