import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonRound, pairedRows } from '../tools/compare-champion-reason.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';

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
