import test from 'node:test';
import assert from 'node:assert/strict';
import { playMatch } from '../simulation/match-rollout.mjs';

function validate(state) {
  assert.equal(Object.hasOwn(state, 'hands'), false);
  assert.equal(state.hand.length, state.counts[state.p]);
  assert.deepEqual(
    state.context.hand.map((card) => card.id),
    state.hand,
  );
  assert(state.actions.every((action) => action.every((id) => state.hand.includes(id))));
  assert.equal(state.match.levels[state.match.lvlTeam], state.level);
}
const choose = (state) => {
  validate(state);
  return {
    index: state.actions.reduce(
      (best, cards, i) => (cards.length > state.actions[best].length ? i : best),
      0,
    ),
  };
};

test('self-play collects all four own-seat views and continues learning through first-out', async () => {
  const seats = new Set();
  const run = () =>
    playMatch({
      seed: 35000104,
      team: 0,
      mode: 'self',
      decide: async (state) => {
        seats.add(state.p);
        return choose(state);
      },
    });
  const result = await run();
  assert.deepEqual([...seats].sort(), [0, 1, 2, 3]);
  assert(result.stats.afterFirstOutDecisions > 0);
  assert(result.stats.finishingChoices > 0);
  assert(result.history.at(-1).win || result.history.at(-1).draw);
  assert.deepEqual(await run(), result);
});

test('historical opponents act without adding their decisions to the learner buffer', async () => {
  const learned = new Set(),
    frozen = new Set();
  const result = await playMatch({
    seed: 35010104,
    team: 1,
    mode: 'snapshot',
    decide: async (state) => {
      learned.add(state.p);
      return choose(state);
    },
    snapshotInfer: async (state) => {
      validate(state);
      frozen.add(state.p);
      return state.actions.map((cards) => cards.length);
    },
  });
  assert.deepEqual([...learned].sort(), [1, 3]);
  assert.deepEqual([...frozen].sort(), [0, 2]);
  assert.deepEqual(result.stats.currentModelSeats, [1, 3]);
});
