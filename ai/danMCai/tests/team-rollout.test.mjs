import test from 'node:test';
import assert from 'node:assert/strict';
import { playMatch } from '../../shared/simulation/match-rollout.mjs';

test('opening reviews fix the dealt problem while later deals refresh; private cards use a separate critic argument', async () => {
  async function run(seed) {
    const hands = new Map();
    await playMatch({
      seed,
      initialDealSeed: 6101,
      team: 0,
      mode: 'self',
      trainingCritic: true,
      decide: async (state, criticOnly) => {
        assert.equal(state.hands, undefined);
        assert.equal(state.criticOnly, undefined);
        assert.equal(criticOnly.hands.length, 4);
        assert.deepEqual(criticOnly.hands[state.p], state.hand);
        if (!hands.has(state.match.round))
          hands.set(
            state.match.round,
            criticOnly.hands.map((h) => h.slice().sort((a, b) => a - b)),
          );
        return {
          index: state.actions.reduce(
            (best, a, i) => (a.length > state.actions[best].length ? i : best),
            0,
          ),
        };
      },
    });
    return hands;
  }
  const first = await run(102),
    second = await run(103);
  assert.deepEqual(first.get(1), second.get(1));
  assert.notDeepEqual(first.get(2), second.get(2));
});
