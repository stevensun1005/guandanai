import { makeDeck } from '../core/cards.js';
import { analyze, beats } from '../core/combinations.js';
import { candidates } from './candidates.js';

const deck = makeDeck();
const cardKey = (hand) =>
  hand
    .map((card) => card.r + card.s)
    .sort()
    .join(',');

/** A two-player ending reveals the sole other hand through card conservation. */
export function endgameRequest(game, player, plays) {
  const active = game.hands
    .map((hand, seat) => (hand.length ? seat : -1))
    .filter((seat) => seat >= 0);
  if (
    active.length !== 2 ||
    !active.includes(player) ||
    active[0] % 2 === active[1] % 2 ||
    game.hands.reduce((sum, hand) => sum + hand.length, 0) > 16
  )
    return null;
  return {
    trick: game.trick && {
      player: game.trick.player,
      play: { type: game.trick.play.type, value: game.trick.play.value, n: game.trick.play.n },
    },
    passes: game.passes || 0,
    shapes: plays.map((play) => play && { type: play.type, value: play.value, n: play.n }),
  };
}

export function inferLastOpponent(state) {
  if (
    state.counts.length !== 4 ||
    state.counts.some((count) => !Number.isInteger(count) || count < 0 || count > 27)
  )
    return null;
  const opponents = state.counts
    .map((count, seat) => (count > 0 && seat !== state.p ? seat : -1))
    .filter((seat) => seat >= 0);
  if (opponents.length !== 1 || opponents[0] % 2 === state.p % 2) return null;
  const known = state.hand.concat(state.log.flatMap((entry) => entry.cards || []));
  if (
    known.some((id) => !Number.isInteger(id) || id < 0 || id >= 108) ||
    new Set(known).size !== known.length
  )
    return null;
  const knownIds = new Set(known);
  const hand = deck.filter((card) => !knownIds.has(card.id));
  if (hand.length !== state.counts[opponents[0]] || state.hand.length !== state.counts[state.p])
    return null;
  return { player: opponents[0], hand };
}

/** Return a proved winning continuation, or leave the learned choice untouched. */
export function solvePublicEndgame(state, values, { maxNodes = 40000, maxMs = 80 } = {}) {
  if (
    !state.endgame ||
    state.hand.length + state.counts.reduce((sum, n, seat) => sum + (seat === state.p ? 0 : n), 0) >
      16
  )
    return null;
  const other = inferLastOpponent(state);
  if (!other) return null;
  const own = state.hand.map((id) => deck[id]);
  const shapes = state.endgame.shapes;
  if (shapes?.length !== state.actions.length || values.length !== state.actions.length)
    return null;
  const root = [];
  for (let index = 0; index < state.actions.length; index++) {
    const ids = state.actions[index],
      shape = shapes[index];
    if (!ids.length) {
      if (!state.endgame.trick || shape) return null;
      root.push(null);
      continue;
    }
    if (new Set(ids).size !== ids.length || !ids.every((id) => state.hand.includes(id)))
      return null;
    const cards = ids.map((id) => deck[id]);
    const reading = analyze(cards, state.level).find(
      (reading) =>
        reading.type === shape?.type &&
        reading.value === shape?.value &&
        beats(reading, state.endgame.trick?.play),
    );
    if (!reading) return null;
    root.push({ ...reading, cards });
  }
  const seats = [state.p, other.player];
  const trick = state.endgame.trick;
  if (trick?.player === state.p) return null;
  const initialOwner = trick ? seats.indexOf(trick.player) : -1;
  let finishedLeader = 0;
  if (trick && initialOwner < 0) {
    const mate = seats.indexOf((trick.player + 2) % 4);
    if (mate >= 0) finishedLeader = mate;
    else
      for (let step = 1; step <= 4; step++) {
        const next = seats.indexOf((trick.player + step) % 4);
        if (next >= 0) {
          finishedLeader = next;
          break;
        }
      }
  }
  const started = performance.now(),
    deadline = started + maxMs;
  const budget = Symbol('budget');
  const memo = new Map(),
    legalCache = new Map();
  let nodes = 0;
  const shapeKey = (play) => (play ? `${play.type}:${play.value}:${play.n}` : '-');
  function legal(hand, current) {
    const key =
      hand
        .map((card) => card.id)
        .sort((a, b) => a - b)
        .join(',') +
      '|' +
      shapeKey(current);
    if (!legalCache.has(key))
      legalCache.set(
        key,
        candidates(hand, state.level, current).sort(
          (a, b) => (b?.cards.length || 0) - (a?.cards.length || 0),
        ),
      );
    return legalCache.get(key);
  }
  function after(hands, turn, current, owner, passes, play) {
    if (play) {
      const ids = new Set(play.cards.map((card) => card.id));
      const remaining = hands[turn].filter((card) => !ids.has(card.id));
      if (!remaining.length) return turn === 0 ? 1 : -1;
      const next = hands.slice();
      next[turn] = remaining;
      return search(next, 1 - turn, play, turn, 0);
    }
    const nextPasses = passes + 1;
    if (nextPasses >= (owner < 0 ? 2 : 1))
      return search(hands, owner < 0 ? finishedLeader : owner, null, -1, 0);
    return search(hands, 1 - turn, current, owner, nextPasses);
  }
  function search(hands, turn, current, owner, passes) {
    if (++nodes > maxNodes || (nodes % 64 === 0 && performance.now() > deadline)) throw budget;
    const key =
      cardKey(hands[0]) +
      '|' +
      cardKey(hands[1]) +
      `|${turn}|${shapeKey(current)}|${owner}|${passes}`;
    if (memo.has(key)) return memo.get(key);
    const desired = turn === 0 ? 1 : -1;
    let result = -desired;
    for (const play of legal(hands[turn], current)) {
      const answer = after(hands, turn, current, owner, passes, play);
      if (answer === desired) {
        result = desired;
        break;
      }
    }
    memo.set(key, result);
    return result;
  }
  try {
    const order = root.map((_, index) => index).sort((a, b) => values[b] - values[a]);
    for (const index of order) {
      if (
        after(
          [own, other.hand],
          0,
          trick?.play || null,
          initialOwner,
          state.endgame.passes,
          root[index],
        ) === 1
      )
        return { index, winning: true, nodes, elapsedMs: performance.now() - started };
    }
    return null;
  } catch (error) {
    if (error === budget) return null;
    throw error;
  }
}
