import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPolicyEpisode } from '../scripts/lib/policy-rollout.mjs';
import { candidates } from '../src/ai/candidates.js';
import { advanceRound } from '../scripts/lib/simulation.mjs';
import { makeDeck } from '../src/core/cards.js';
import { analyze } from '../src/core/combinations.js';

function recordingEngine() {
  const requests = [];
  return {
    requests,
    request: async (request) => {
      requests.push(structuredClone(request));
      if (request.op === 'finish') return { saved: true };
      const actions = request.state.actions;
      let index = 0;
      for (let i = 1; i < actions.length; i++)
        if (actions[i].length > actions[index].length) index = i;
      return { index };
    },
  };
}

test('policy rollouts expose only acting-seat information and receive team outcomes', async () => {
  const engine = recordingEngine();
  const result = await collectPolicyEpisode({ episode: 7, seed: 20700104, engine });
  assert.ok(result.turns > 4 && result.turns < 1000);
  const decisions = engine.requests.filter((request) => request.op === 'decide');
  assert.equal(decisions.length, result.stats.decisions);
  assert.ok(decisions.length > 0);
  for (const { state, seat } of decisions) {
    assert.equal(state.p, seat);
    assert.equal(state.context.p, seat);
    assert.equal(state.counts[seat], state.hand.length);
    assert.deepEqual(
      state.context.hand.map((card) => card.id),
      state.hand,
    );
    assert.equal(state.actionShapes.length, state.actions.length);
    assert.deepEqual(state.trick, state.context.trick);
    assert.equal('hands' in state, false);
    assert.equal('hands' in state.context, false);
    for (const action of state.actions)
      assert.ok(action.every((card) => state.hand.includes(card)));
  }
  const finish = engine.requests.at(-1);
  assert.equal(finish.op, 'finish');
  assert.equal(finish.winner, result.order[0] % 2);
  assert.deepEqual([...finish.order].sort(), [0, 1, 2, 3]);
  assert.equal(finish.points, result.points);
  assert.equal(finish.neuralTeam, null);
});

test('rollout scoring keeps the first-out team and public 接风 order', () => {
  const cards = makeDeck();
  const single = (card) => ({ ...analyze([card], 2)[0], cards: [card] });
  const finishing = (out, finisher, hands) => {
    const game = { hands, L: 2, turn: finisher, out, trick: null, passes: 0, log: [] };
    return advanceRound(game, single(hands[finisher][0]));
  };
  const double = finishing([0], 2, [[], [cards[2]], [cards[3]], [cards[4]]]);
  assert.deepEqual(double, { winner: 0, points: 3, order: [0, 2, 3, 1] });
  const third = finishing([0, 1], 2, [[], [], [cards[3]], [cards[4]]]);
  assert.deepEqual(third, { winner: 0, points: 2, order: [0, 1, 2, 3] });
  const opposingFinish = finishing([0, 1], 3, [[], [], [cards[3]], [cards[4]]]);
  assert.deepEqual(opposingFinish, { winner: 0, points: 1, order: [0, 1, 3, 2] });

  const game = {
    hands: [[], [cards[2]], [cards[3]], [cards[4]]],
    L: 2,
    turn: 1,
    out: [0],
    trick: { player: 0, play: single(cards[0]) },
    passes: 0,
    log: [],
  };
  for (const turn of [1, 2, 3]) {
    assert.equal(game.turn, turn);
    assert.equal(advanceRound(game, null), null);
  }
  assert.equal(game.turn, 2);
  assert.equal(game.trick, null);
  assert.equal(game.passes, 0);
});

test('mixed rollouts learn only the requested team and reject invalid model actions', async () => {
  const engine = recordingEngine();
  const result = await collectPolicyEpisode({
    episode: 2,
    seed: 20700106,
    engine,
    neuralTeam: 1,
    ruleChoose: (game, seat) => candidates(game.hands[seat], game.L, game.trick?.play)[0],
  });
  assert.ok(result.stats.ruleActions > 0);
  assert.ok(
    engine.requests.filter((request) => request.op === 'decide').every((r) => r.seat % 2 === 1),
  );
  await assert.rejects(
    collectPolicyEpisode({
      episode: 3,
      seed: 20700104,
      engine: { request: async () => ({ index: -1 }) },
    }),
    /invalid action/,
  );
});
