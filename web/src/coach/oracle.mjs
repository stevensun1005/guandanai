import { makeDeck } from '../core/cards.js';
import { candidates } from '../ai/candidates.js';
import { policyState } from '../ai/observation.js';
import { advanceRound } from '../../../ai/shared/simulation/simulation.mjs';
import { rankedCoachActions, coachReading, actionKey } from './evaluation.mjs';

const deck = makeDeck();
function restore(input) {
  const all = input.hands?.flat();
  if (
    !all ||
    input.hands.length !== 4 ||
    new Set(all).size !== all.length ||
    all.some((id) => !Number.isInteger(id) || id < 0 || id > 107) ||
    !Number.isInteger(input.player) ||
    input.player < 0 ||
    input.player > 3 ||
    !input.hands[input.player].length ||
    input.hands.some((hand) => hand.length > 27)
  )
    throw Error('Invalid full-information position');
  return {
    hands: input.hands.map((hand) => hand.map((id) => deck[id])),
    L: input.level,
    levels: input.levels.slice(),
    turn: input.player,
    log: input.log.map((entry) => ({
      p: entry.p,
      cards: entry.cards?.map((id) => deck[id]) || null,
    })),
    trick: input.trick && structuredClone(input.trick),
    passes: input.passes,
    out: input.out.slice(),
  };
}
const shapeOf = (play) => play && { type: play.type, value: play.value, n: play.n, wu: play.wu };

/** Bounded full-information neural rollouts, not a separately trained omniscient network. */
export async function scoreOracle(input, infer, { maxRoots = 8, horizon = 4, maxMs = 1800 } = {}) {
  const initial = restore(input),
    player = input.player,
    side = player % 2;
  let roots = candidates(initial.hands[player], initial.L, initial.trick?.play);
  const canonical = new Map();
  for (const play of roots) {
    const cards = play?.cards.map((card) => card.id) || [],
      key = actionKey(cards);
    if (!canonical.has(key))
      canonical.set(key, coachReading(cards, initial.L, initial.trick?.play));
  }
  roots = [...canonical.values()];
  if (input.onlyAction !== undefined) {
    const ids = input.onlyAction;
    if (
      !Array.isArray(ids) ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !input.hands[player].includes(id))
    )
      throw Error('Invalid oracle action');
    if (!ids.length) {
      if (!initial.trick) throw Error('Cannot pass on lead');
      roots = [null];
    } else {
      roots = [coachReading(ids, initial.L, initial.trick?.play)];
    }
  }
  const ids = roots.map((play) => play?.cards.map((card) => card.id) || []);
  const prior = await infer(policyState(initial, player, 0, roots));
  if (prior.length !== roots.length || !prior.every(Number.isFinite))
    throw Error('Invalid oracle prior');
  let selected = rankedCoachActions(ids, prior, initial.L, maxRoots, initial.trick?.play).map(
    (row) => row.index,
  );
  // Always consider passing to a partner and a legal immediate finish, even outside the neural beam.
  for (let i = 0; i < roots.length; i++)
    if (
      (!roots[i] || roots[i].cards.length === initial.hands[player].length) &&
      !selected.includes(i)
    )
      selected.push(i);
  const started = performance.now(),
    actions = [],
    values = [],
    shapes = [];
  for (const index of selected) {
    if (actions.length >= Math.min(5, selected.length) && performance.now() - started > maxMs)
      break;
    const game = restore(input);
    let result = advanceRound(game, roots[index]);
    for (let ply = 1; ply < horizon && !result; ply++) {
      const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
      const estimates = await infer(policyState(game, game.turn, 0, plays));
      if (!estimates.length || !estimates.every(Number.isFinite))
        throw Error('Invalid rollout values');
      let best = estimates.indexOf(Math.max(...estimates));
      const finish = plays.findIndex((play) => play?.cards.length === game.hands[game.turn].length);
      if (finish >= 0) best = finish;
      result = advanceRound(game, plays[best]);
    }
    let value;
    if (result) value = (result.winner === side ? 1 : -1) * result.points;
    else {
      const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
      const estimates = await infer(policyState(game, game.turn, 0, plays));
      if (!estimates.length || !estimates.every(Number.isFinite))
        throw Error('Invalid leaf values');
      value = (game.turn % 2 === side ? 1 : -1) * Math.max(...estimates);
    }
    actions.push(ids[index]);
    values.push(value);
    shapes.push(shapeOf(roots[index]));
  }
  return {
    actions,
    values,
    shapes,
    search: {
      candidates: roots.length,
      evaluated: actions.length,
      horizon,
      elapsedMs: Math.round(performance.now() - started),
      fullInformation: true,
    },
  };
}
