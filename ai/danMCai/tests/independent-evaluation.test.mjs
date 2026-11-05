import test from 'node:test';
import assert from 'node:assert/strict';
import { roundCounts } from '../evaluation/evaluate-independent.mjs';
import { createTableInference } from '../../shared/simulation/table-inference.mjs';
import { createRound } from '../../shared/simulation/simulation.mjs';

test('cooperation counts distinguish double-down, isolated first and every team rank pair', () => {
  const history = [
    [0, 2, 1, 3],
    [0, 1, 2, 3],
    [0, 1, 3, 2],
    [1, 0, 2, 3],
    [1, 0, 3, 2],
    [1, 3, 0, 2],
  ].map((order) => ({ order }));
  const result = {
    neuralTeam: 0,
    history,
    stats: { rounds: 6, doubleWins: 1, doubleLosses: 1, isolatedFirsts: 1 },
  };
  assert.deepEqual(roundCounts(result), {
    rounds: 6,
    firsts: 3,
    doubleWins: 1,
    doubleLosses: 1,
    isolatedFirsts: 1,
    ranks: { 12: 1, 13: 1, 14: 1, 23: 1, 24: 1, 34: 1 },
  });
  assert.throws(
    () => roundCounts({ ...result, stats: { ...result.stats, doubleLosses: 0 } }),
    /mismatch/,
  );
});

test('native backend reuses table decision flow and enforces one inference thread', async () => {
  let options,
    released = false;
  class Tensor {
    constructor(type, data, dims) {
      Object.assign(this, { type, data, dims });
    }
    dispose() {}
  }
  const runtime = {
    Tensor,
    InferenceSession: {
      create: async (_bytes, opts) => {
        options = opts;
        return {
          run: async ({ actions }) => ({
            values: new Tensor('float32', new Float32Array(actions.dims[0]), [actions.dims[0], 1]),
          }),
          release: async () => {
            released = true;
          },
        };
      },
    },
  };
  const policy = createTableInference({ runtime });
  try {
    const game = createRound(55104);
    const play = await policy.decide(game, game.turn);
    assert(
      play == null || play.cards.every((c) => game.hands[game.turn].some((h) => h.id === c.id)),
    );
  } finally {
    await policy.close();
  }
  assert.equal(options.intraOpNumThreads, 1);
  assert.equal(options.interOpNumThreads, 1);
  assert.equal(options.executionProviders, undefined);
  assert(released);
});
