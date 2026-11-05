import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { rankedCoachActions, coachReading } from '../src/coach/evaluation.mjs';
import { scoreOracle } from '../src/coach/oracle.mjs';
import {
  privateEligible,
  privateActive,
  privateSeat,
  markPrivateTable,
  privateWasUsed,
  oracleObservation,
} from '../src/private-table/state.mjs';

const deck = makeDeck();
const position = (hands) => ({
  hands: hands.map((hand) => hand.map((rank) => deck[rank - 2])),
  L: 10,
  levels: [10, 7],
  turn: 0,
  log: [],
  out: [],
  trick: null,
  passes: 0,
  phase: 'play',
});
const infer = async (state) => {
  assert(
    !('hands' in state),
    'The unchanged network receives its regular observation, not four private hands',
  );
  return state.actions.map((ids) =>
    ids.length ? -ids.reduce((sum, id) => sum + deck[id].r, 0) / 100 : -10,
  );
};

test('Top 5 merges duplicate rank plans and retains the highest-valued actual suit choice', () => {
  const actions = [[0], [13], [54], [1], []],
    values = [3, 4, 2, 1, 0];
  const before = structuredClone(actions);
  const rows = rankedCoachActions(actions, values, 7);
  assert.deepEqual(
    rows.map((row) => row.ids),
    [[13], [1], []],
  );
  assert.deepEqual(
    rows.map((row) => row.value),
    [4, 1, 0],
  );
  assert.deepEqual(actions, before);
  assert.throws(() => rankedCoachActions([[0]], [NaN], 7));
});

test('Private mode is host-name gated and only applies to self and a computer partner', () => {
  const context = {
    nickname: 'stezer0',
    privateTable: true,
    network: { mode: 'host', humans: new Set([0]) },
  };
  assert(privateActive(context));
  assert.deepEqual(
    [0, 1, 2, 3].map((p) => privateSeat(context, p)),
    [true, false, true, false],
  );
  context.network.humans.add(2);
  assert(!privateSeat(context, 2));
  context.network.mode = 'guest';
  assert(!privateActive(context));
  assert(!privateEligible('solo', 'stezer0'));
  assert(!privateEligible('host', 'Stezer0'));
});

test('Private observations are independent copies and their matches remain excluded after switching off', () => {
  const game = position([[2], [3], [4], [5]]),
    observation = oracleObservation(game);
  const context = { game, nickname: 'stezer0', privateTable: true, network: { mode: 'host' } };
  markPrivateTable(context);
  context.privateTable = false;
  assert(privateWasUsed(game));
  assert(!privateWasUsed(position([[2], [3], [4], [5]])));
  game.hands[1].pop();
  assert.equal(observation.hands[1].length, 1);
});

test('Full-information neural rollouts can overturn their public neural prior using actual counterplay', async () => {
  const game = position([[3, 7], [4], [5], [6]]),
    before = structuredClone(game);
  const result = await scoreOracle(oracleObservation(game), infer, { horizon: 8, maxMs: 10000 });
  const small = result.actions.findIndex((ids) => ids[0] === 1),
    large = result.actions.findIndex((ids) => ids[0] === 5);
  assert.equal(result.values[small], -2);
  assert.equal(result.values[large], 2);
  assert.equal(result.actions[result.values.indexOf(Math.max(...result.values))][0], 5);
  assert.deepEqual(game, before);
});

test('Same public hand/counts, different hidden arrangements produce different completed team-upgrade values', async () => {
  const a = position([[2], [3], [4], [5]]),
    b = position([[2], [5], [4], [3]]);
  const x = await scoreOracle(oracleObservation(a), infer, { horizon: 8 });
  const y = await scoreOracle(oracleObservation(b), infer, { horizon: 8 });
  assert.deepEqual(x.values, [2]);
  assert.deepEqual(y.values, [1]);
});

test('Oracle rejects duplicate private cards and a leading pass before inference', async () => {
  const input = oracleObservation(position([[2], [3], [4], [5]]));
  await assert.rejects(scoreOracle({ ...input, hands: [[0], [0], [2], [3]] }, infer), /Invalid/);
  await assert.rejects(scoreOracle({ ...input, onlyAction: [] }, infer), /Cannot pass/);
});

test('Ambiguous wild cards use the actual UI legal reading for the current trick', () => {
  const ids = [1, 27, 2, 28, 18, 72],
    trick = { type: 'pairs3', value: 2, n: 6 };
  const play = coachReading(ids, 7, trick);
  assert.equal(play.type, 'pairs3');
  assert.equal(play.value, 3);
  const rows = rankedCoachActions([ids], [1], 7, 5, trick);
  assert.equal(rows[0].shape.type, 'pairs3');
});
