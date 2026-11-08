import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchSeats, runController, runWorker } from '../tools/evaluate-match-017.mjs';
import { playMatch } from '../../shared/simulation/match-rollout.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';

test('mixed match lineup keeps Clint only in isolated seats and balances focal seats', () => {
  assert.deepEqual(matchSeats({ opponent: 'p0' }, 0, 2), ['champion', 'p0', 'champion', 'p0']);
  assert.deepEqual(matchSeats({ opponent: 'clint', mixed: true }, 1, 2), [
    'clint',
    'champion',
    'clint',
    'clint',
  ]);
  assert.deepEqual(matchSeats({ opponent: 'clint', mixed: true }, 1, 3), [
    'clint',
    'clint',
    'clint',
    'champion',
  ]);
});
test('whole-match STOP is checked before round preparation and every action', async () => {
  let calls = 0;
  await assert.rejects(
    playMatch({
      seed: 1832,
      team: 0,
      evaluate: true,
      checkpoint: () => {
        if (++calls === 3) throw Error('STOP');
      },
      tablePolicy: (game, p) => candidates(game.hands[p], game.L, game.trick?.play)[0],
    }),
    /STOP/,
  );
  assert.equal(calls, 3);
});
test('checkpoint callback does not change complete match outcomes', async () => {
  const options = {
    seed: 1833,
    team: 0,
    mode: 'self',
    evaluate: true,
    infer: (state) => state.actions.map(() => 0),
  };
  const plain = await playMatch(options);
  let calls = 0;
  const checked = await playMatch({
    ...options,
    checkpoint: () => {
      calls++;
    },
  });
  assert.deepEqual(checked, plain);
  assert.ok(calls > plain.history.length);
});
test('actual registered match controller and worker honor STOP before models or output', async () => {
  const run = mkdtempSync(join(tmpdir(), 'match017-stop-'));
  try {
    writeFileSync(
      join(run, 'protocol.json'),
      JSON.stringify({ deadlineUTC: '2026-11-11T16:45:00Z' }),
    );
    writeFileSync(
      join(run, 'campaign-task.json'),
      JSON.stringify({ window: { deadlineUTC: '2026-11-11T16:45:00Z' } }),
    );
    writeFileSync(join(run, 'STOP'), '{}');
    await runController(run);
    await runWorker(run, 0);
    assert.equal(existsSync(join(run, 'status.json')), false);
    assert.equal(existsSync(join(run, 'worker-0.lock')), false);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
