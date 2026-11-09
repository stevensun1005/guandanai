import catalog from '../ai/model-catalog.json' with { type: 'json' };
import { BOT_CHOICES, botModelName, searchBot } from '../ai/model-catalog.mjs';
import { policyState } from '../ai/observation.js';
import { candidates } from '../ai/candidates.js';
import { cardsArray } from '../ai/encoding.mjs';
import { makeDeck, isWild } from '../core/cards.js';
import { analyze, beats, strength } from '../core/combinations.js';

/** Champion weights: the coach's fallback values, extra single-move ratings and the private table. */
export const COACH_MODEL_ID = catalog.selection.danMCaiChampions[0];
export const COACH_MODEL_NAME = botModelName(COACH_MODEL_ID);
/**
 * Owner 2026-11-09: the coach defaults to the reasoning bot in the menu (danMCai-reason over the
 * current champion). Its belief-world search values replace the champion's in the search bands;
 * elsewhere, and whenever the search does not finish, the champion values are shown.
 */
export const COACH_SEARCH_BOT_ID = BOT_CHOICES.find((choice) => searchBot(choice.id))?.id ?? null;
export const COACH_NAME = botModelName(COACH_SEARCH_BOT_ID ?? COACH_MODEL_ID);
export const coachAllowed = (mode, rules) => mode === 'solo' || rules?.coachAllowed === true;
export const actionKey = (ids) => cardsArray(ids).join(',');
const coachDeck = makeDeck();
/** Use the same strongest legal reading as the selected-card UI. */
export function coachReading(ids, level, current) {
  if (!ids.length) return null;
  const cards = ids.map((id) => coachDeck[id]);
  const shape = analyze(cards, level)
    .filter((s) => beats(s, current))
    .sort((a, b) => strength(b) - strength(a))[0];
  if (!shape) throw Error('Illegal coach action');
  return { ...shape, cards, wu: cards.filter((card) => isWild(card, level)).length };
}

/**
 * One representative per rank/shape plan; keep the best suit choice and real held IDs.
 * Without `tiebreak`, `values` are all finite. With it (the champion values), a null value marks
 * a candidate the reasoning search did not evaluate: evaluated rows come first by value, ties by
 * the champion value (the bot's tie rule), then the unevaluated rows by champion value.
 */
export function rankedCoachActions(actions, values, level, limit = 5, current, tiebreak) {
  const valid = (v) => Number.isFinite(v) || (tiebreak && v === null);
  if (
    actions.length !== values.length ||
    !values.every(valid) ||
    (tiebreak && (tiebreak.length !== values.length || !tiebreak.every(Number.isFinite)))
  )
    throw Error('Invalid ranked actions');
  const order = (a, b) =>
    (a.value === null) - (b.value === null) ||
    (b.value ?? 0) - (a.value ?? 0) ||
    (b.base ?? 0) - (a.base ?? 0) ||
    a.index - b.index;
  const plans = new Map(),
    readings = new Map();
  actions.forEach((ids, index) => {
    const exact = actionKey(ids);
    if (!readings.has(exact)) readings.set(exact, coachReading(ids, level, current));
    const shape = readings.get(exact),
      cards = ids.map((id) => coachDeck[id]);
    const key = !cards.length
      ? 'pass'
      : `${shape?.type}|${shape?.value}|${cards
          .map((c) => (isWild(c, level) ? 'wild' : c.r))
          .sort()
          .join(',')}`;
    const row = { ids: ids.slice(), value: values[index], shape, index };
    if (tiebreak) row.base = tiebreak[index];
    if (!plans.has(key) || order(row, plans.get(key)) < 0) plans.set(key, row);
  });
  return [...plans.values()].sort(order).slice(0, limit);
}

/**
 * Display values from the champion reply and a reasoning-search reply, matched by face key (the
 * coach and the search generate the same candidates; physical duplicates share a key). Returns
 * null when the search did not evaluate any of the coach's candidates.
 */
export function mergeSearchValues(actions, search) {
  if (!search?.ok || !Array.isArray(search.plays) || search.plays.length !== search.values?.length)
    return null;
  const byKey = new Map();
  search.plays.forEach((ids, i) => {
    const value = search.values[i];
    if (Number.isFinite(value)) byKey.set(actionKey(ids), value);
  });
  const shown = actions.map((ids) => byKey.get(actionKey(ids)) ?? null);
  return shown.some((value) => value !== null) ? shown : null;
}

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
      plays = [coachReading(ids, observation.level, observation.trick?.play)];
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
