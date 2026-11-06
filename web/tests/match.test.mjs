import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aStayReason,
  roundOutcome,
  initialMatchLevels,
  levelAttemptLabel,
} from '../src/core/match.js';
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

test('a team at A that wins at the other team level is told it has not played A yet', () => {
  // the reported match: we were at A (one failed try), the opponents won the round before, so
  // round 9 was played at their 6; we finished first and second
  const state = { levels: [14, 6], lvlTeam: 1, L: 6, aFails: [1, 0] };
  const outcome = roundOutcome(state, [0, 2, 3, 1]);
  assert.equal(outcome.result.win, false);
  assert.deepEqual(outcome.levels, [14, 6]);
  assert.equal(outcome.lvlTeam, 0, 'next round is played at our A');
  assert.equal(aStayReason(outcome.result), 'notOwnA');
  // the next round is at our A: first and second now wins the match
  assert(roundOutcome({ ...state, ...outcome, L: 14 }, [0, 2, 3, 1]).result.win);
  // at our own A with the partner last
  const atA = { levels: [14, 6], lvlTeam: 0, L: 14, aFails: [0, 0] };
  assert.equal(aStayReason(roundOutcome(atA, [0, 1, 3, 2]).result), 'partnerLast');
  // passed, moved, lost or not at A: no reason to give
  assert.equal(aStayReason(roundOutcome(atA, [0, 2, 1, 3]).result), null);
  assert.equal(aStayReason(roundOutcome(atA, [1, 3, 0, 2]).result), null);
  assert.equal(
    aStayReason(roundOutcome({ levels: [9, 6], lvlTeam: 0, L: 9 }, [0, 2, 1, 3]).result),
    null,
  );
  assert.equal(
    aStayReason({ before: 14, after: 14, team: 0, aOut: 0, aTeam: 0, playedLevel: 14 }),
    'spent',
  );
});

test('once mode spends three A attempts then gives the other team one final attempt', () => {
  const atA = { levels: [14, 12], lvlTeam: 0, L: 14, aFails: [0, 0] };
  let state = atA;
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(levelAttemptLabel(state, 0), `A${attempt}`);
    state = { ...state, ...roundOutcome(state, [0, 1, 3, 2], 'once') };
    assert.equal(state.result.draw, false);
    assert.equal(state.result.spent, attempt === 3);
  }
  assert.equal(state.aOut, 0);
  assert.equal(roundOutcome(state, [0, 2, 1, 3], 'once').result.win, false);
  state = { ...state, ...roundOutcome(state, [1, 3, 0, 2], 'once') };
  assert.equal(state.result.draw, false);
  state.L = 14;
  assert.equal(levelAttemptLabel(state, 1), 'A末');
  const finalFailure = roundOutcome(state, [1, 0, 2, 3], 'once');
  assert.equal(finalFailure.result.lastTry, true);
  assert.equal(finalFailure.result.draw, true);
  assert.equal(roundOutcome(state, [1, 0, 3, 2], 'once').result.win, true);
  assert.equal(roundOutcome(atA, [0, 2, 1, 3], 'once').result.win, true);
  assert.equal(levelAttemptLabel(atA, 1), null);
});

test('starting levels follow absolute compass teams for every host seat and reject invalid levels', () => {
  for (const [own, direction] of ['S', 'E', 'N', 'W'].entries()) {
    for (const [side, absolute] of [
      ['SN', 0],
      ['EW', 1],
    ]) {
      const initial = initialMatchLevels({ startLevel: 12, startSide: side }, direction);
      const team = (absolute - own + 4) % 2;
      assert.equal(initial.lvlTeam, team);
      assert.equal(initial.levels[team], 12);
      assert.equal(initial.levels[1 - team], 2);
      assert.equal(initial.L, 12);
    }
  }
  assert.deepEqual(initialMatchLevels({}, 'E', 1), { levels: [2, 2], lvlTeam: 1, L: 2 });
  for (const startLevel of [1, 15, NaN, 2.5, 'Q'])
    assert.equal(initialMatchLevels({ startLevel }).L, 2);
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
