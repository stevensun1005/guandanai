import test from 'node:test';
import assert from 'node:assert/strict';
import { roundOutcome } from '../src/core/match.js';
import {
  createMatchRound,
  applyMatchTribute,
} from '../../ai/shared/simulation/match-simulation.mjs';
import { makeDeck } from '../src/core/cards.js';
import { createRuleBaseline } from '../../ai/shared/simulation/rule-baseline.mjs';

test('teammate placement changes next-round level without declaring premature match victory', () => {
  const match = { levels: [2, 2], lvlTeam: 0, L: 2 };
  assert.equal(roundOutcome(match, [0, 2, 1, 3]).levels[0], 5);
  assert.equal(roundOutcome(match, [0, 1, 2, 3]).levels[0], 4);
  assert.equal(roundOutcome(match, [0, 1, 3, 2]).levels[0], 3);
  assert.equal(roundOutcome(match, [0, 1, 3, 2]).result.win, false);
  assert.deepEqual(match.levels, [2, 2]);
});

test('playing A needs a qualifying partner finish and preserves the configured third-failure result', () => {
  const atA = { levels: [14, 11], lvlTeam: 0, L: 14, aFails: [2, 0] };
  assert(roundOutcome(atA, [0, 1, 2, 3]).result.win);
  const failed = roundOutcome(atA, [0, 1, 3, 2]);
  assert.equal(failed.result.win, false);
  assert(failed.result.draw);
  const reset = roundOutcome(atA, [1, 0, 3, 2], 'reset');
  assert(reset.result.reset);
  assert.equal(reset.levels[0], 2);
  assert.equal(roundOutcome({ ...atA, lvlTeam: 1, L: 11 }, [0, 2, 1, 3]).result.win, false);
});

test('single and double tribute preserve all physical cards and reset cached round state', () => {
  for (let seed = 0; seed < 50; seed++) {
    const game = createMatchRound(32000104 + seed, {
      levels: [5, 2],
      lvlTeam: 0,
      aFails: [0, 0],
      round: 2,
      previousOrder: seed % 2 ? [0, 2, 1, 3] : [0, 1, 2, 3],
    });
    assert(game.hands.every((hand) => hand.length === 27));
    assert.equal(new Set(game.hands.flat().map((card) => card.id)).size, 108);
    assert.equal(game.log.length, 0);
    assert.equal(game.L, 5);
  }
  createRuleBaseline(1);
  const deck = makeDeck(),
    jokers = deck.filter((card) => card.r === 17);
  const rest = deck.filter((card) => card.r !== 17);
  const game = {
    L: 2,
    hands: [
      rest.slice(0, 27),
      rest.slice(27, 54),
      rest.slice(54, 81),
      rest.slice(81).concat(jokers),
    ],
  };
  const snapshot = JSON.stringify(game.hands);
  const tribute = applyMatchTribute(game, [0, 1, 2, 3]);
  assert(tribute.resisted);
  assert.equal(tribute.leader, 0);
  assert.equal(JSON.stringify(game.hands), snapshot);
});
