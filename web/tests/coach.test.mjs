import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coachAllowed,
  coachObservation,
  prepareCoachPolicy,
  relativeRating,
  actionKey,
  COACH_MODEL_ID,
  COACH_NAME,
  COACH_SEARCH_BOT_ID,
  mergeSearchValues,
  rankedCoachActions,
} from '../src/coach/evaluation.mjs';
import { BOT_CHOICES, searchBot } from '../src/ai/model-catalog.mjs';
import catalog from '../src/ai/model-catalog.json' with { type: 'json' };
import { makeDeck } from '../src/core/cards.js';
import { rotateSnapshot } from '../src/network/snapshot.js';
import { policyState } from '../src/ai/observation.js';
import { encode } from '../src/ai/encoding.mjs';
import { validateRecord } from '../src/collection/validate.mjs';
import { humanExamples } from '../../ai/shared/data/tools/human-examples.mjs';
import { collectedRound } from './fixtures/collected-round.mjs';

test('online evaluation requires explicit host permission and never uses a retired reasoning base', () => {
  for (const mode of ['host', 'guest']) {
    for (const value of [undefined, false, 'true', 1])
      assert.equal(coachAllowed(mode, { coachAllowed: value }), false);
    assert.equal(coachAllowed(mode, { coachAllowed: true }), true);
  }
  assert.equal(coachAllowed('solo', {}), true);
  // champion weights: fallback values, single extra moves and the private table
  assert.equal(COACH_MODEL_ID, catalog.selection.danMCaiChampions[0]);
  assert.equal(COACH_MODEL_ID, catalog.defaultId);
  // The new champion has no separately validated search bot yet. Historical 9001 stays on017.
  assert.equal(COACH_SEARCH_BOT_ID, null);
  assert.equal(searchBot('9001').base, '017');
  assert.ok(!BOT_CHOICES.some((choice) => choice.id === '9001'));
  assert.equal(COACH_NAME, 'danMCai-v000061013');
});

test('search values replace the champion values only for the moves the search evaluated', () => {
  const deck = makeDeck();
  // hand 3♠ 3♥ 5♠; level 2, leading: candidates single 3, pair 3, single 5
  const actions = [[deck[1].id], [deck[1].id, deck[14].id], [deck[3].id]];
  const base = [0.4, 0.9, 0.1];
  const search = {
    ok: true,
    kind: 'midgame',
    // the worker may use other physical copies of the same faces
    plays: [[deck[3].id], [deck[54 + 1].id, deck[14].id]],
    values: [1.5, -0.5],
  };
  const shown = mergeSearchValues(actions, {
    ...search,
    plays: [...search.plays, [deck[1].id]],
    values: [...search.values, null],
  });
  assert.deepEqual(shown, [null, -0.5, 1.5]);
  const ranked = rankedCoachActions(actions, shown, 2, 5, null, base);
  // searched moves first by search value, then the unsearched one by champion value
  assert.deepEqual(
    ranked.map((row) => [row.index, row.value]),
    [
      [2, 1.5],
      [1, -0.5],
      [0, null],
    ],
  );
  // ties of the search value go to the higher champion value (the bot's tie rule)
  const tied = rankedCoachActions(actions, [0, 0, 0], 2, 5, null, base);
  assert.deepEqual(
    tied.map((row) => row.index),
    [1, 0, 2],
  );
  assert.equal(mergeSearchValues(actions, { ...search, ok: false }), null);
  assert.equal(
    mergeSearchValues(actions, { ...search, plays: [[deck[20].id]], values: [1] }),
    null,
  );
  // null is only valid next to champion tiebreak values
  assert.throws(() => rankedCoachActions(actions, shown, 2, 5, null));
  assert.throws(() => rankedCoachActions(actions, shown, 2, 5, null, [0, 1]));
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
  assert.equal(state.selfLevel, 2);
  assert.equal(state.opponentLevel, 4);
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

test('all four rotated evaluation views encode the same seat with unequal team levels', () => {
  const deck = makeDeck();
  const game = {
    hands: [0, 1, 2, 3].map((p) => deck.slice(p * 27, p * 27 + 27)),
    levels: [7, 10],
    lvlTeam: 0,
    L: 7,
    aFails: [1, 2],
    round: 4,
    log: [],
    trick: null,
  };
  const card = game.hands[1].pop();
  game.log.push({ p: 1, cards: [card] });
  for (let offset = 0; offset < 4; offset++) {
    const local = rotateSnapshot(game, offset);
    const expected = policyState(game, offset, 0, []),
      actual = coachObservation(local, offset);
    assert.equal(actual.selfLevel, expected.selfLevel, `own level rotated twice at seat ${offset}`);
    assert.equal(actual.opponentLevel, expected.opponentLevel);
    assert.deepEqual(encode(actual), encode(expected));
  }
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

test('a match named in keepAssistedMatches keeps its assisted human actions, marked as overridden', () => {
  const record = collectedRound();
  record.kind = 'game';
  const human = record.actions.find((a) => a.actor === 'human');
  const before = humanExamples(record).length;
  human.assisted = true;
  assert.equal(humanExamples(record).length, before - 1);
  const kept = humanExamples(record, { keepAssistedMatches: new Set([record.matchId]) });
  assert.equal(kept.length, before);
  assert.equal(kept.filter((row) => row.assistedOverride).length, 1);
  assert.equal(
    humanExamples(record, { keepAssistedMatches: new Set(['other-match']) }).length,
    before - 1,
  );
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
