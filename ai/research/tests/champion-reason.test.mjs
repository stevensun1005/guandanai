import test from 'node:test';
import assert from 'node:assert/strict';
import {
  comparisonRound,
  pairedRows,
  studentChallenger,
} from '../tools/compare-champion-reason.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { createRound } from '../../shared/simulation/simulation.mjs';
import { playPaired } from '../../danMCai/endgame/evaluate.mjs';

const first = async (g, p) => candidates(g.hands[p], g.L, g.trick?.play)[0];
const reason = { decide: first };
test('raw/reason comparison keeps identical deals and swaps both teams', async () => {
  const games = [];
  for (const team of [0, 1])
    games.push(await comparisonRound({ seed: 71, team, raw: first, reason }));
  assert.equal(games[0].dealSHA256, games[1].dealSHA256);
  assert.deepEqual(
    games.map((g) => g.seats),
    [
      ['challenger', 'reason', 'challenger', 'reason'],
      ['reason', 'challenger', 'reason', 'challenger'],
    ],
  );
  assert.equal(games[0].signedPoints, -games[1].signedPoints);
  assert.equal(games[0].order.length, 4);
  const rows = [{ seed: 71, protocolSHA256: 'test', games }];
  assert.equal(pairedRows(rows, 'test', [71]), rows);
  assert.throws(() => pairedRows([...rows, ...rows], 'test', [71]));
  assert.throws(() => pairedRows(rows, 'changed', [71]));
});
test('STOP discards unfinished games; no fabricated draws or results', async () => {
  let calls = 0;
  await assert.rejects(
    comparisonRound({
      seed: 72,
      team: 0,
      raw: first,
      reason,
      checkpoint: async () => {
        if (++calls === 3) throw Error('STOP');
      },
    }),
    /STOP/,
  );
});

test('student challenger matches the previously evaluated hybrid policy for whole rounds', async () => {
  const calls = { champion: 0, student: 0 };
  const values = (file, state) => {
    calls[file]++;
    return Float32Array.from(state.actions, (_, i) => (file === 'student' ? i : -i));
  };
  const hybrid = studentChallenger(
    (s) => values('champion', s),
    (s) => values('student', s),
  );
  const opponent = studentChallenger(
    (s) => values('champion', s),
    (s) => values('champion', s),
  );
  for (const team of [0, 1]) {
    const observed = await comparisonRound({
      seed: 73,
      team,
      raw: hybrid,
      reason: { decide: opponent },
    });
    const expected = await playPaired(73, team, {
      values,
      champion: 'champion',
      student: 'student',
      threshold: 32,
      solverCards: 0,
    });
    assert.deepEqual(observed.order, expected.order);
    assert.equal(observed.signedPoints, expected.points);
  }
  assert.ok(calls.champion > 0 && calls.student > 0);
  assert.throws(() => studentChallenger(values, values, 40), /32-card/);
  const game = createRound(74);
  game.hands = game.hands.map((h) => h.slice(0, 1));
  const noInference = studentChallenger(
    () => {
      throw Error('Unexpected inference');
    },
    () => {
      throw Error('Unexpected inference');
    },
  );
  assert.equal((await noInference(game, game.turn)).cards.length, 1);
});
