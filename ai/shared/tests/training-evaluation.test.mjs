import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../../../web/src/app/runtime.js';
import { analyze, beats } from '../../../web/src/core/combinations.js';
import { createRound, advanceRound } from '../simulation/simulation.mjs';
import { createRuleBaseline } from '../simulation/rule-baseline.mjs';
import { clusterEstimate } from '../../local/evaluation/evaluate-trained.mjs';

const signature = (play) =>
  play && { type: play.type, value: play.value, cards: play.cards.map((card) => card.id).sort() };

for (const version of ['original', 'rules-v2']) {
  test(`${version} rule baseline reads no hidden hands and restores shared runtime and randomness`, () => {
    const previous = { sentinel: true };
    runtime.game = previous;
    const originalRandom = Math.random;
    for (let seed = 901; seed < 913; seed++) {
      const game = createRound(seed);
      const seat = game.turn;
      const before = structuredClone(game);
      const expected = createRuleBaseline(seed, { version })(game, seat);
      const hidden = {
        ...game,
        hands: game.hands.map((hand, player) =>
          player === seat
            ? hand
            : new Proxy(hand, {
                get(target, property) {
                  if (property === 'length') return target.length;
                  throw Error('Hidden card access');
                },
              }),
        ),
      };
      assert.deepEqual(
        signature(createRuleBaseline(seed, { version })(hidden, seat)),
        signature(expected),
      );
      assert.deepEqual(game, before);
      assert.equal(runtime.game, previous);
      assert.equal(Math.random, originalRandom);
    }
  });

  test(`seeded ${version} rule games are deterministic and every action is legal`, () => {
    function round(seed) {
      const game = createRound(seed);
      const choose = createRuleBaseline(seed, { version });
      for (let step = 0; step < 1000; step++) {
        const play = choose(game);
        if (play) {
          assert.ok(beats(play, game.trick?.play));
          assert.ok(
            analyze(play.cards, game.L).some(
              (shape) =>
                shape.type === play.type && shape.value === play.value && shape.n === play.n,
            ),
          );
        }
        const result = advanceRound(game, play);
        if (result) return { result, log: game.log };
      }
      throw Error('Rule game failed to finish');
    }
    for (let seed = 1201; seed < 1205; seed++) assert.deepEqual(round(seed), round(seed));
  });
}

test('win uncertainty treats swapped games as one independent deal', () => {
  const pairs = [0, 0.5, 1, 0.5];
  const clustered = clusterEstimate(pairs, [0, 1]);
  assert.equal(clustered.mean, 0.5);
  assert.ok(Math.abs(clustered.confidence95[0] - (0.5 - 1.96 / Math.sqrt(24))) < 1e-12);
  assert.deepEqual(clusterEstimate([0.5]), { mean: 0.5, confidence95: null });
});
