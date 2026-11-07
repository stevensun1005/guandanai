import test from 'node:test';
import assert from 'node:assert/strict';
import { createRound, advanceRound } from '../simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { scoreOracle, rolloutOracleRound } from '../../../web/src/coach/oracle.mjs';
import { sampleWorlds, likelihoodWeights, publicHistoryLogLikelihood } from '../search/belief.mjs';
import { searchObservation, searchRoots, scoreWorlds } from '../search/pimc.mjs';

const infer = async (state) => state.actions.map((a) => (a.length ? -a[0] / 100 : -10));

test('public determinizations preserve physical cards/counts and visible tribute; deterministic with seed', () => {
  const game = createRound(9912),
    state = searchObservation(game),
    other = (state.p + 1) % 4;
  state.publicKnownCards = [{ seat: other, card: game.hands[other][0].id }];
  const worlds = sampleWorlds(state, { count: 8, seed: 4321 });
  assert.deepEqual(worlds, sampleWorlds(state, { count: 8, seed: 4321 }));
  for (const hands of worlds) {
    assert.equal(new Set(hands.flat()).size, 108);
    assert.deepEqual(
      hands.map((h) => h.length),
      state.counts,
    );
    assert.deepEqual(hands[state.p], state.hand);
    assert.ok(hands[other].includes(state.publicKnownCards[0].card));
  }
  assert.throws(() => sampleWorlds({ ...state, hands: game.hands }, { seed: 3 }));
  assert.throws(() => sampleWorlds({ ...state, counts: [1, 1, 1, 1] }, { seed: 3 }));
});

test('likelihood floor rejects overconfident temperature and reports real ESS/particle collapse', () => {
  assert.throws(() => likelihoodWeights([0, -1], { temperature: 0.02 }));
  const w = likelihoodWeights([0, -1000, -1000, -1000], { seed: 14 });
  assert.equal(w.essBeforeResampling, 1);
  assert.equal(w.resampled, true);
  assert.equal(w.distinctSurvivors, 1);
  assert.equal(likelihoodWeights([0, 0, 0, 0]).essBeforeResampling, 4);
});

test('raw full-round kernel matches priorWeight=0 raw oracle line and final outcome', async () => {
  const game = createRound(9913);
  // A legal complete game prefix: no fabricated tiny-hand fixture or private-policy input.
  for (let i = 0; i < 80 && !game.out.length; i++) {
    const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
    if (advanceRound(game, plays[0])) throw Error('Unexpected fixture end');
  }
  const state = searchObservation(game),
    prepared = await searchRoots(state, infer),
    root = prepared.roots[0];
  const input = { ...state, hands: game.hands.map((h) => h.map((c) => c.id)), player: state.p };
  const direct = await rolloutOracleRound(input, root.play, infer);
  const oracle = await scoreOracle(
    { ...input, onlyAction: root.play?.cards.map((c) => c.id) || [] },
    infer,
    { priorWeight: 0, rawArgmax: true, maxSamples: 1, maxMs: 0, maxRoundPlies: 1000 },
  );
  assert.deepEqual(direct.line, oracle.lines[0]);
  assert.equal(direct.value, oracle.values[0]);
  await assert.rejects(
    rolloutOracleRound(input, root.play, infer, { stop: () => true }),
    /stopped/,
  );
  const result = await scoreWorlds(
    state,
    Array.from({ length: 48 }, () => input.hands),
    infer,
    { roots: prepared },
  );
  assert.equal(result.requestedWorlds, 48);
  assert.equal(result.uniqueWorlds, 1);
  assert.ok(result.rows.every((r) => r.pairedStandardError === null));
});

test('history likelihood uses only public choices with a minimum softmax temperature', async () => {
  const game = createRound(9914);
  for (let i = 0; i < 8; i++) {
    const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
    assert.equal(advanceRound(game, plays[0]), null);
  }
  const state = searchObservation(game),
    worlds = sampleWorlds(state, { count: 2, seed: 2 });
  const score = await publicHistoryLogLikelihood(state, worlds[0], infer);
  assert.ok(Number.isFinite(score));
  assert.ok(score <= 0);
  await assert.rejects(publicHistoryLogLikelihood(state, worlds[0], infer, { temperature: 0.02 }));
});
