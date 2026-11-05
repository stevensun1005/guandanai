import test from 'node:test';
import assert from 'node:assert/strict';
import { metrics, intervals } from '../training/evaluate.mjs';
test('GuanZero swapped-seat metrics use each model team and each round outcome', () => {
  const pair = [
    {
      neuralTeam: 0,
      winner: 0,
      history: [
        { team: 0, up: 3 },
        { team: 1, up: 1 },
      ],
    },
    { neuralTeam: 1, winner: null, history: [{ team: 1, up: 2 }] },
  ];
  const m = metrics([pair]);
  assert.equal(m.wins, 1);
  assert.equal(m.draws, 1);
  assert.equal(m.roundWinRate, 2 / 3);
  assert.equal(m.averageUpgradePoints, 4 / 3);
  assert.equal(m.matchScore, 0.75);
  assert.equal(intervals([pair]), null);
  const c = intervals([pair, pair], 100);
  assert.deepEqual(c.averageUpgradePoints, [4 / 3, 4 / 3]);
});
