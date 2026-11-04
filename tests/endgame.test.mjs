import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { analyze, beats } from '../src/core/combinations.js';
import { candidates } from '../src/ai/candidates.js';
import { endgameRequest, inferLastOpponent, solvePublicEndgame } from '../src/ai/endgame.js';
import { seededRandom } from '../scripts/lib/simulation.mjs';

const deck = makeDeck();
function fixture(own, other, current = null, owner = 1, passes = 0) {
  const held = new Set(own.concat(other).map((card) => card.id));
  const game = {
    hands: [own, other, [], []],
    L: 2,
    passes,
    trick: current && { player: owner, play: current },
  };
  const plays = candidates(own, 2, current);
  return {
    plays,
    state: {
      p: 0,
      hand: own.map((card) => card.id),
      counts: [own.length, other.length, 0, 0],
      level: 2,
      actions: plays.map((play) => play?.cards.map((card) => card.id) || []),
      log: deck.filter((card) => !held.has(card.id)).map((card) => ({ p: 2, cards: [card.id] })),
      endgame: endgameRequest(game, 0, plays),
    },
  };
}

// Exhaustive subsets form an independent oracle, rather than reusing policy candidates.
function oracleMoves(hand, current) {
  const plays = [];
  for (let bits = 1; bits < 1 << hand.length; bits++) {
    const cards = hand.filter((_, index) => bits & (1 << index));
    for (const shape of analyze(cards, 2))
      if (beats(shape, current)) plays.push({ ...shape, cards });
  }
  if (current) plays.push(null);
  return plays;
}
function oracleAfter(hands, turn, current, owner, passes, play, memo = new Map()) {
  if (play) {
    const ids = new Set(play.cards.map((card) => card.id));
    const rest = hands[turn].filter((card) => !ids.has(card.id));
    if (!rest.length) return turn === 0;
    const next = hands.slice();
    next[turn] = rest;
    return oracle(next, 1 - turn, play, turn, 0, memo);
  }
  if (passes + 1 >= (owner === 2 ? 2 : 1))
    return oracle(hands, owner === 2 ? 0 : owner, null, -1, 0, memo);
  return oracle(hands, 1 - turn, current, owner, passes + 1, memo);
}
function oracle(hands, turn, current, owner, passes, memo) {
  const key = JSON.stringify([
    hands.map((hand) => hand.map((card) => card.id)),
    turn,
    current && [current.type, current.value, current.n],
    owner,
    passes,
  ]);
  if (memo.has(key)) return memo.get(key);
  const answers = oracleMoves(hands[turn], current).map((play) =>
    oracleAfter(hands, turn, current, owner, passes, play, memo),
  );
  const answer = turn === 0 ? answers.some(Boolean) : answers.every(Boolean);
  memo.set(key, answer);
  return answer;
}

test('the last opponent hand is reconstructed from own and public cards only', () => {
  const { state } = fixture(deck.slice(2, 5), deck.slice(20, 23));
  assert.deepEqual(inferLastOpponent(state).hand, deck.slice(20, 23));
  state.log.push(state.log[0]);
  assert.equal(inferLastOpponent(state), null);
});
test('no search is requested while two hidden hands remain or card conservation fails', () => {
  const { state } = fixture(deck.slice(2, 5), deck.slice(20, 23));
  state.counts[2] = 2;
  assert.equal(
    solvePublicEndgame(
      state,
      state.actions.map(() => 0),
    ),
    null,
  );
  const game = { hands: [deck.slice(0, 4), deck.slice(4, 8), deck.slice(8, 12), []] };
  assert.equal(endgameRequest(game, 0, []), null);
});
test('bounded exact search agrees with exhaustive subset minimax on seeded small endings', () => {
  const random = seededRandom(91031);
  for (let index = 0; index < 60; index++) {
    const shuffled = deck
      .map((card) => ({ card, key: random() }))
      .sort((a, b) => a.key - b.key)
      .map((item) => item.card);
    const own = shuffled.slice(0, 2 + (index % 3)),
      other = shuffled.slice(5, 7 + (index % 2));
    const current = index % 2 ? { type: 'single', n: 1, value: 5 } : null;
    const { state, plays } = fixture(own, other, current);
    const answers = plays.map((play) =>
      oracleAfter([own, other], 0, current, current ? 1 : -1, 0, play),
    );
    const bad = answers.indexOf(false);
    const values = plays.map((_, i) => (i === bad ? 1 : 0));
    const answer = solvePublicEndgame(state, values, { maxNodes: 200000, maxMs: 1000 });
    if (answers.some(Boolean)) {
      assert(answer, `missing win ${index}`);
      assert.equal(answers[answer.index], true);
    } else assert.equal(answer, null);
  }
});
test('a finished trick owner hands the lead to their active partner after both passes', () => {
  const own = [deck[0], deck[12]],
    other = [deck[5], deck[6]];
  const current = { type: 'single', value: 17, n: 1 };
  for (const passes of [0, 1]) {
    const { state, plays } = fixture(own, other, current, 2, passes);
    const expected = oracleAfter([own, other], 0, current, 2, passes, plays[0]);
    const answer = solvePublicEndgame(
      state,
      plays.map(() => 0),
      { maxMs: 1000 },
    );
    assert.equal(!!answer, expected);
  }
});
test('an exhausted node budget preserves the model choice', () => {
  const { state } = fixture([deck[0], deck[12], deck[6]], [deck[5], deck[8], deck[9]]);
  assert.equal(
    solvePublicEndgame(
      state,
      state.actions.map(() => 0),
      { maxNodes: 0 },
    ),
    null,
  );
});

test('public search includes a 24-card ending and rejects a 25-card request', () => {
  const own = deck.filter((card) => card.r === 9).slice(0, 4);
  const other = deck.filter((card) => !own.includes(card)).slice(0, 20);
  const { state, plays } = fixture(own, other);
  assert(state.endgame);
  const finish = plays.findIndex((play) => play?.cards.length === own.length);
  const answer = solvePublicEndgame(
    state,
    plays.map((_, index) => (index === finish ? 1 : 0)),
  );
  assert.equal(answer.index, finish);
  const larger = fixture(own, deck.filter((card) => !own.includes(card)).slice(0, 21));
  assert.equal(larger.state.endgame, null);
});
