import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coachAllowed,
  coachObservation,
  prepareCoachPolicy,
  relativeRating,
  actionKey,
  COACH_MODEL_ID,
} from '../src/coach/evaluation.mjs';
import catalog from '../src/ai/model-catalog.json' with { type: 'json' };
import { makeDeck } from '../src/core/cards.js';
import { validateRecord } from '../src/collection/validate.mjs';
import { humanExamples } from '../../ai/shared/data/tools/human-examples.mjs';
import { collectedRound } from './fixtures/collected-round.mjs';

test('online evaluation requires explicit host permission and always selects the current local champion', () => {
  for (const mode of ['host', 'guest']) {
    for (const value of [undefined, false, 'true', 1])
      assert.equal(coachAllowed(mode, { coachAllowed: value }), false);
    assert.equal(coachAllowed(mode, { coachAllowed: true }), true);
  }
  assert.equal(coachAllowed('solo', {}), true);
  assert.equal(COACH_MODEL_ID, catalog.selection.localChampions[0]);
  assert.equal(COACH_MODEL_ID, catalog.defaultId);
});

test('coach observation never reads another private card and freezes the pre-move public state', () => {
  const deck = makeDeck();
  const hidden = new Proxy(Array(27), {
    get(target, key) {
      if (key !== 'length') throw Error('private hand accessed');
      return target.length;
    },
  });
  const game = {
    hands: [[deck[0], deck[1]], hidden, hidden, hidden],
    log: [{ p: 1, cards: [deck[30]] }],
    L: 2,
    levels: [2, 4],
    lvlTeam: 0,
    round: 3,
    aFails: [0, 1],
    trick: { player: 1, play: { type: 'single', value: 4, n: 1 } },
  };
  const state = coachObservation(game, 1);
  assert.deepEqual(state.hand, [0, 1]);
  assert.deepEqual(state.counts, [2, 27, 27, 27]);
  assert.equal(state.selfLevel, 4);
  assert.equal(state.opponentLevel, 2);
  game.hands[0].pop();
  game.log.push({ p: 0, cards: [deck[0]] });
  game.levels[0] = 10;
  assert.deepEqual(state.hand, [0, 1]);
  assert.equal(state.log.length, 1);
  assert.equal(state.match.levels[0], 2);
  assert.ok(!('hands' in state));
});

test('rating is a monotone affine-invariant value-range score with explicit flat and invalid cases', () => {
  assert.deepEqual(relativeRating([-2, 0, 2], 1), { percent: 75, flat: false });
  assert.equal(relativeRating([-2, 0, 2], 2).percent, 100);
  assert.equal(relativeRating([-2, 0, 2], -2).percent, 0);
  assert.deepEqual(relativeRating([3, 5, 7], 6), relativeRating([-2, 0, 2], 1));
  assert.deepEqual(relativeRating([1, 1 + 1e-8], 1), { percent: 100, flat: true });
  assert.throws(() => relativeRating([], 1));
  assert.throws(() => relativeRating([NaN], 1));
});

test('worker prepares real legal actions, including pass and finishing moves, with equivalent duplicate tensors', () => {
  const observation = {
    p: 0,
    hand: [0],
    counts: [1, 27, 27, 27],
    log: [],
    level: 3,
    canPass: false,
    trick: null,
  };
  const first = prepareCoachPolicy(observation);
  assert.deepEqual(first.actions, [[0]]);
  assert.equal(first.index, undefined);
  assert.equal(actionKey([0]), actionKey([54]));
  assert.throws(() => prepareCoachPolicy({ ...observation, onlyAction: [] }));
  assert.throws(() => prepareCoachPolicy({ ...observation, onlyAction: [1] }));
  const follow = prepareCoachPolicy({
    ...observation,
    canPass: true,
    trick: { player: 1, play: { type: 'single', value: 2, n: 1 } },
  });
  assert.ok(follow.actions.some((ids) => !ids.length));
});

test('assisted human actions remain replayable but are excluded from unassisted imitation examples', () => {
  const record = collectedRound();
  record.kind = 'game';
  const human = record.actions.find((a) => a.actor === 'human');
  const before = humanExamples(record).length;
  human.assisted = true;
  assert.equal(validateRecord(record).actions.find((a) => a === human).assisted, true);
  assert.equal(humanExamples(record).length, before - 1);
  human.assisted = 'true';
  assert.throws(() => validateRecord(record));
  delete human.assisted;
  record.actions.find((a) => a.actor === 'bot').assisted = true;
  assert.throws(() => validateRecord(record));
});
