import test from 'node:test';
import assert from 'node:assert/strict';
import { createRound, advanceRound } from '../../shared/simulation/simulation.mjs';
import { createRuleBaseline } from '../../shared/simulation/rule-baseline.mjs';
import { createWebClint } from '../../shared/simulation/web-clint.mjs';
import { BRAIN_STAT } from '../../../web/src/rule-bot/endgame-brain.mjs';
import { analyze, beats } from '../../../web/src/core/combinations.js';
import { clintMatch, freezeClint, verifyClintMetadata } from '../training/evaluate-clint.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';

test('brain-enabled Clint performs a real legal search on a public late-round position', () => {
  let position;
  for (let seed = 71; seed < 100 && !position; seed++) {
    const game = createRound(seed),
      rule = createRuleBaseline(seed, { version: 'rules-v2' });
    for (let n = 0; n < 600; n++) {
      const hand = game.hands[game.turn];
      if (
        game.hands.every((h) => h.length <= 4) &&
        hand.length >= 2 &&
        !analyze(hand, game.L).length &&
        candidates(hand, game.L, game.trick?.play).length > 1
      ) {
        position = game;
        break;
      }
      if (advanceRound(game, rule(game, game.turn))) break;
    }
  }
  assert.ok(position, 'real legal late-game fixture');
  position.tok = 'brain-search-test';
  position.round = 1;
  const before = BRAIN_STAT.calls,
    p = position.turn;
  const move = createWebClint(7331)(position, p);
  assert.ok(BRAIN_STAT.calls > before, 'actual endgame brain was called');
  if (move) {
    assert.ok(move.cards.every((c) => position.hands[p].includes(c)));
    assert.ok(
      analyze(move.cards, position.L).some((x) => x.type === move.type && x.value === move.value),
    );
    assert.ok(beats(move, position.trick?.play));
  } else assert.ok(position.trick);
});
test('Clint match adapter routes both teams through the table policy rather than rules-only mode', async () => {
  let network = 0;
  const result = await clintMatch({
    seed: 991,
    team: 0,
    inference: {
      values: async (state) => {
        network++;
        return Float32Array.from(state.actions, () => 0);
      },
    },
    play: async (options) => {
      assert.equal(options.mode, 'self');
      assert.equal(options.evaluate, true);
      const a = createRound(991 * 1009);
      Object.assign(a, { round: 1, prevOut: null });
      await options.tablePolicy(a, 0);
      await options.tablePolicy(a, 1);
      return { winner: 0 };
    },
  });
  assert.equal(network, 1);
  assert.equal(result.clintStats.decisions, 1);
  const identity = freezeClint();
  verifyClintMetadata(identity);
  assert.equal(identity.brain.ms, 30000);
  assert.ok(identity.sourceSHA256['web/src/rule-bot/endgame-brain.mjs']);
  assert.throws(() => verifyClintMetadata({ ...identity, brain: { ...identity.brain, ms: 0 } }));
});
