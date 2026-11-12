import test from 'node:test';
import assert from 'node:assert/strict';
import { createRound } from '../../shared/simulation/simulation.mjs';
import { cardIndex } from '../../../web/src/ai/encoding.mjs';
import { oracleFeatures, playRound, ORACLE } from '../endgame/actor.mjs';
import { summarize, playPaired, EvaluationStopped } from '../endgame/evaluate.mjs';

test('bounded evaluation discards an interrupted round instead of scoring it as a draw', async () => {
  await assert.rejects(
    playPaired(424242, 0, {
      values: async () => {
        throw Error('No inference should run');
      },
      champion: 'base',
      student: 'new',
      threshold: 32,
      solverCards: 18,
      checkpoint: () => {
        throw new EvaluationStopped('STOP');
      },
    }),
    EvaluationStopped,
  );
});

// Deterministic stand-in for a network: prefer larger plays, pass last.
const decide = async (file, state) =>
  state.actions.map((ids, i) =>
    ids.length ? ids.length + (file === 'student' ? 0.5 : 0) - i * 1e-3 : -1,
  );

test('oracle features hold exactly the other three hands, relative to the decider', () => {
  const game = createRound(424242);
  const row = oracleFeatures(game, 1);
  assert.equal(row.length, ORACLE);
  for (let k = 1; k <= 3; k++) {
    const seat = (1 + k) % 4;
    let total = 0;
    for (let i = 0; i < 54; i++) total += row[(k - 1) * 54 + i];
    assert.equal(total, game.hands[seat].length);
    for (const card of game.hands[seat]) assert.ok(row[(k - 1) * 54 + cardIndex(card.id)] >= 1);
  }
});

test('actor records only endgame decisions with signed final team points, deterministically', async () => {
  const options = {
    decide,
    champion: 'champion',
    student: 'student',
    threshold: 32,
    temperature: 0.02,
  };
  const first = await playRound(5150, options);
  const again = await playRound(5150, options);
  assert.deepEqual(
    first.rows.map((r) => [r.y, r.cards]),
    again.rows.map((r) => [r.y, r.cards]),
  );
  assert.ok(first.rows.length > 0);
  for (const row of first.rows) {
    assert.ok(row.cards <= 32);
    assert.equal(row.x.length, 567);
    const expected = row.team === first.result.winner ? first.result.points : -first.result.points;
    assert.equal(row.y, expected);
  }
  const none = await playRound(5150, { ...options, threshold: 0 });
  assert.equal(none.rows.length, 0);
});

test('summary reports paired means with a deal-cluster interval', () => {
  const rows = [
    {
      mean: 1,
      a: {
        points: 2,
        endgameDecisions: 3,
        differs: 1,
        solverChecked: 0,
        regretStudent: 0,
        regretChampion: 0,
      },
      b: {
        points: 0,
        endgameDecisions: 2,
        differs: 0,
        solverChecked: 0,
        regretStudent: 0,
        regretChampion: 0,
      },
    },
    {
      mean: -1,
      a: {
        points: -1,
        endgameDecisions: 1,
        differs: 0,
        solverChecked: 0,
        regretStudent: 0,
        regretChampion: 0,
      },
      b: {
        points: -1,
        endgameDecisions: 1,
        differs: 1,
        solverChecked: 0,
        regretStudent: 0,
        regretChampion: 0,
      },
    },
  ];
  const s = summarize(rows);
  assert.equal(s.pairs, 2);
  assert.equal(s.meanSignedPoints, 0);
  assert.ok(s.ci95[0] < 0 && s.ci95[1] > 0);
  assert.equal(s.decisionsDifferentFromChampion, 2);
});
