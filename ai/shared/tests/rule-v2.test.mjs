import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../../../web/src/core/cards.js';
import { analyze } from '../../../web/src/core/combinations.js';
import { createRuleBaseline, createRuleOpponent } from '../simulation/rule-baseline.mjs';

const take = (rank, n) =>
  makeDeck()
    .filter((c) => c.r === rank && c.s !== 'H')
    .slice(0, n);
const bomb = makeDeck()
  .filter((c) => c.r === 8)
  .slice(0, 4);
function game(hand, winner = 1, left = 27) {
  const cards = take(4, 3).concat(take(5, 2));
  const play = { ...analyze(cards, 2).find((p) => p.type === 'full'), cards };
  return {
    L: 2,
    turn: 0,
    hands: [hand, new Array(left), new Array(12), new Array(13)],
    trick: { player: winner, play },
    log: [{ p: winner, ...play, lead: true }],
    trib: [],
  };
}

test('rules-v2 never spends its finishing bomb over a teammate full house', () => {
  assert.equal(createRuleOpponent(9101001)(game(bomb, 2)), null);
});

test('rules-v2 saves a sole bomb against a non-ending opponent full house', () => {
  for (const left of [27, 19, 11]) {
    const state = game(bomb.concat(take(3, 1), take(7, 1), take(9, 1)), 1, left);
    assert.equal(createRuleOpponent(9101002)(state), null);
  }
});

test('rules-v2 leads the only non-bomb group before its bomb outside matching-count exceptions', () => {
  const state = game(bomb.concat(take(3, 2)), 1, 10);
  state.trick = null;
  state.log = [];
  const play = createRuleOpponent(9101003)(state);
  assert.equal(play.type, 'pair');
  assert.equal(play.value, 3);
});

test('rule opponent versions reject misspellings instead of silently changing the baseline', () => {
  assert.throws(() => createRuleBaseline(1, { version: 'rule-v2' }), /Unknown rule/);
});
