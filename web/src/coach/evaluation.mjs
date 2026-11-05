import catalog from '../ai/model-catalog.json' with { type: 'json' };
import { botModelName } from '../ai/model-catalog.mjs';
import { policyState } from '../ai/observation.js';
import { candidates } from '../ai/candidates.js';
import { cardsArray } from '../ai/encoding.mjs';
import { makeDeck, isWild } from '../core/cards.js';
import { analyze, beats } from '../core/combinations.js';

export const COACH_MODEL_ID = catalog.selection.localChampions[0];
export const COACH_MODEL_NAME = botModelName(COACH_MODEL_ID);
export const coachAllowed = (mode, rules) => mode === 'solo' || rules?.coachAllowed === true;
export const actionKey = (ids) => cardsArray(ids).join(',');

/** Copy only this player's cards, public history and public match context. */
export function coachObservation(game) {
  return {
    // Hands, public seats and team levels are already rotated into this player's view.
    ...policyState(game, 0, 0, []),
    trick: game.trick && {
      player: game.trick.player,
      play: { type: game.trick.play.type, value: game.trick.play.value, n: game.trick.play.n },
    },
    match: {
      levels: game.levels.slice(),
      aFails: (game.aFails || [0, 0]).slice(),
      lvlTeam: game.lvlTeam,
      round: game.round,
      previousOrder: game.prevOut?.slice() || null,
    },
  };
}

/** Candidate generation runs inside the separate evaluation Worker. No finishing/search shortcut. */
export function prepareCoachPolicy(observation) {
  const deck = makeDeck(),
    hand = observation.hand.map((id) => deck[id]);
  let plays;
  if (observation.onlyAction !== undefined) {
    const ids = observation.onlyAction;
    if (
      !Array.isArray(ids) ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !observation.hand.includes(id))
    )
      throw Error('Invalid coach action');
    if (!ids.length) {
      if (!observation.canPass) throw Error('Cannot rate a leading pass');
      plays = [null];
    } else {
      const cards = ids.map((id) => deck[id]);
      const shape = analyze(cards, observation.level).find((s) =>
        beats(s, observation.trick?.play),
      );
      if (!shape) throw Error('Illegal coach action');
      plays = [{ ...shape, cards, wu: cards.filter((c) => isWild(c, observation.level)).length }];
    }
  } else plays = candidates(hand, observation.level, observation.trick?.play);
  return {
    ...observation,
    actions: plays.map((p) => p?.cards.map((c) => c.id) || []),
    actionShapes: plays.map((p) => p && { type: p.type, value: p.value, n: p.n, wu: p.wu }),
  };
}

/** A relative value-range score, not a calibrated probability or an estimate of win rate. */
export function relativeRating(values, selected) {
  if (!values.length || !values.every(Number.isFinite) || !Number.isFinite(selected))
    throw Error('Invalid coach values');
  let low = selected,
    high = selected;
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const flat = high - low < 1e-6;
  return { percent: flat ? 100 : Math.round((100 * (selected - low)) / (high - low)), flat };
}
