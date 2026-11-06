import { createRound, seededRandom } from '../simulation/simulation.mjs';
import {
  matchTributeSteps,
  baselineTributeChoice,
  applyMatchTribute,
} from '../simulation/match-simulation.mjs';
import { roundOutcome } from '../../../web/src/core/match.js';
import { tributeActions } from './encoding.mjs';
import { createRuleBaseline } from '../simulation/rule-baseline.mjs';

/** A fresh synthetic deal following a rule-valid prior finish and level transition. */
export function scenario(seed) {
  createRuleBaseline(seed); // Initialize only the unchanged historical original return baseline.
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw Error('Invalid scenario seed');
  const rng = seededRandom(seed ^ 0x543210ab),
    order = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const levels = [2 + Math.floor(rng() * 12), 2 + Math.floor(rng() * 12)],
    side = order[0] % 2;
  const next = roundOutcome(
    { levels, lvlTeam: side, L: levels[side], aFails: [0, 0] },
    order,
    'draw',
  );
  const game = createRound(seed);
  game.levels = next.levels;
  game.L = next.levels[next.lvlTeam];
  game.match = { ...next, round: 2, previousOrder: order };
  return { game, order };
}

export function decisionCases(seed) {
  const { game, order } = scenario(seed),
    steps = matchTributeSteps(game, order),
    out = [];
  let step = steps.next();
  while (!step.done) {
    const state = step.value;
    if (tributeActions(state).length > 1)
      out.push({ ...state, baseline: baselineTributeChoice(state) });
    step = steps.next(baselineTributeChoice(state));
  }
  return out;
}

export function intervene(seed, state, action) {
  const { game, order } = scenario(seed);
  let replaced = 0;
  const tribute = applyMatchTribute(game, order, (obs) => {
    if (obs.stage === state.stage && obs.player === state.player) {
      replaced++;
      return action;
    }
    return baselineTributeChoice(obs);
  });
  if (replaced !== 1) throw Error('Counterfactual decision was not reached');
  game.turn = tribute.leader;
  return game;
}
