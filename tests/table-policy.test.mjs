import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { createRound } from '../scripts/lib/simulation.mjs';
import { playMatch } from '../scripts/lib/match-rollout.mjs';
import { prepareTableDecision, decideTablePolicy } from '../src/ai/table-policy.mjs';
import { BOT_PROFILES, selectProfileAction } from '../src/ai/profiles.js';
import { solvePublicEndgame } from '../src/ai/endgame.js';
import { MODELS } from '../src/ai/models.mjs';

test('shared preparation reads only the current hand and public counts for all styles', () => {
  const game = createRound(55104);
  const p = game.turn;
  game.roundHistory = [{ log: [{ p: (p + 1) % 4, cards: null }] }];
  const hidden = {
    ...game,
    hands: game.hands.map((hand, seat) =>
      seat === p
        ? hand
        : new Proxy(hand, {
            get(target, property) {
              if (property === 'length') return target.length;
              throw Error('Private opponent card read');
            },
          }),
    ),
  };
  for (const { id } of BOT_PROFILES) {
    const expected = prepareTableDecision(game, p, 0, MODELS.policy, id);
    const actual = prepareTableDecision(hidden, p, 0, MODELS.policy, id);
    assert.deepEqual(actual, expected);
    assert.equal(actual.state.hands, undefined);
    if (id !== 'balanced') assert(actual.state.context.habits);
  }
  const deck = makeDeck();
  const finish = { ...game, hands: [[deck[0]], [], [], []] };
  assert.equal(prepareTableDecision(finish, 0, 0, MODELS.policy).index, 0);
});

test('shared Worker pipeline preserves policy and profile choices and proved endgames', async () => {
  const game = createRound(55104);
  class Tensor {
    constructor(type, data, dims) {
      Object.assign(this, { type, data, dims });
    }
    dispose() {}
  }
  const ort = { Tensor };
  for (const profile of ['balanced', 'aggressive', 'conservative']) {
    const { plays, state } = prepareTableDecision(game, game.turn, 0, MODELS.policy, profile);
    let offset = 0;
    const scores = plays.map((_, i) => 0.001 * i);
    const engine = {
      run: async ({ actions }) => {
        const values = scores.slice(offset, offset + actions.dims[0]);
        offset += actions.dims[0];
        return { values: new Tensor('float32', values, [values.length, 1]) };
      },
    };
    const expected =
      profile === 'balanced'
        ? scores.length - 1
        : selectProfileAction(plays, scores, profile, state.context);
    const result = await decideTablePolicy(ort, async () => engine, state, MODELS.policy);
    assert.equal(result.index, expected);
  }
  // Two active opponents and 106 public cards make the unseen final hand unique.
  const deck = makeDeck();
  const ending = {
    ...game,
    L: 2,
    hands: [[deck[0]], [deck[1], deck[2]], [], []],
    log: [{ p: 2, cards: deck.slice(3) }],
    trick: { player: 1, play: { type: 'single', value: 2, n: 1 } },
    passes: 0,
  };
  const prepared = prepareTableDecision(ending, 0, 0, { learnFinishingDecisions: true });
  assert(prepared.state.endgame);
  assert(
    solvePublicEndgame(
      prepared.state,
      prepared.plays.map(() => 0),
    ),
  );
});

test('table evaluation supplies public cross-round history and match progress', async () => {
  let late = 0;
  await playMatch({
    seed: 55105,
    team: 0,
    mode: 'self',
    evaluate: true,
    tablePolicy: async (game, player) => {
      assert.equal(game.roundHistory.length, game.round - 1);
      assert.equal(game.levels[game.lvlTeam], game.L);
      if (game.round > 1) {
        assert(game.prevOut);
        late++;
      }
      const prepared = prepareTableDecision(
        game,
        player,
        0,
        { extraFeatures: 61, learnFinishingDecisions: true },
        'observant',
      );
      if (prepared.state) assert.equal(prepared.state.match.round, game.round);
      return prepared.plays.reduce(
        (best, play) => ((play?.cards.length || 0) > (best?.cards.length || 0) ? play : best),
        prepared.plays[0],
      );
    },
  });
  assert(late > 0);
});
