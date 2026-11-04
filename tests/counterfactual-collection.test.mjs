import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCounterfactualDeal } from '../scripts/collect-counterfactual.mjs';

function publicOnlyScorer(calls) {
  return async (state) => {
    calls.push(state);
    assert.equal('hands' in state, false);
    assert.equal('hands' in state.context, false);
    assert.deepEqual(
      state.context.hand.map((card) => card.id),
      state.hand,
    );
    assert.deepEqual(state.trick, state.context.trick);
    assert.equal(state.hand.length, state.counts[state.p]);
    const visible = state.log.flatMap((entry) => entry.cards || []).concat(state.hand);
    assert.equal(new Set(visible).size, visible.length);
    for (let seat = 0; seat < 4; seat++)
      assert.equal(
        state.counts[seat],
        27 -
          state.log
            .filter((entry) => entry.p === seat)
            .reduce((sum, entry) => sum + (entry.cards?.length || 0), 0),
      );
    return state.actions.map((cards) => cards.length);
  };
}

test('counterfactual branches faithfully replay rules and expose only acting-seat observations', async () => {
  const calls = [];
  const first = await collectCounterfactualDeal({
    seed: 21590104,
    episode: 0,
    infer: publicOnlyScorer(calls),
  });
  const second = await collectCounterfactualDeal({
    seed: 21590104,
    episode: 0,
    infer: publicOnlyScorer([]),
  });
  assert.ok(calls.length > 0);
  assert.ok(first.stats.prefixRuleDecisions > 0);
  assert.ok(first.stats.eligiblePivots > 1);
  assert.equal(first.skipped, undefined);
  assert.deepEqual(first, second);
  assert.ok(first.returns.length >= 2 && first.returns.length <= 4);
  assert.equal(first.branchWinners[0], first.baseWinner);
  assert.ok(first.state.counts.every((count) => count > 0));
  assert.deepEqual(
    first.returns,
    first.branchWinners.map((winner) => (winner === first.player % 2 ? 1 : -1)),
  );
});

test('counterfactual roots include either neural team and reject malformed proposal scores', async () => {
  const result = await collectCounterfactualDeal({
    seed: 21590105,
    episode: 1,
    infer: publicOnlyScorer([]),
  });
  assert.equal(result.neuralTeam, 1);
  assert.equal(result.player % 2, 1);
  assert.ok(result.indices.length >= 2 && result.indices.length <= 4);
  await assert.rejects(
    collectCounterfactualDeal({ seed: 21590104, episode: 0, infer: async () => [NaN] }),
    /Invalid proposal/,
  );
});
