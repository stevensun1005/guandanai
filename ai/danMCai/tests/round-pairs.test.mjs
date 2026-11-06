import test from 'node:test';
import assert from 'node:assert/strict';
import { lineup, playRound, runRoundPairs } from '../evaluation/evaluate-round-pairs.mjs';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('pending evaluation cannot start with missing frozen weights or deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'danmcai-pending-evaluation-'));
  try {
    const protocol = join(dir, 'protocol.json'),
      run = join(dir, 'results');
    writeFileSync(
      protocol,
      JSON.stringify({ models: { A: { file: null, sha256: null } }, evaluationDeadlineUTC: null }),
    );
    await assert.rejects(runRoundPairs({ protocol, run }), /Freeze all evaluation weights/);
    assert.equal(existsSync(run), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paired lineups swap both sides; mixed lineups balance which teammate uses the network', () => {
  const task = { model: 'champion', opponent: 'latest' };
  assert.deepEqual(lineup(task, 0, 10), ['champion', 'latest', 'champion', 'latest']);
  assert.deepEqual(lineup(task, 1, 10), ['latest', 'champion', 'latest', 'champion']);
  const mixed = { model: 'latest', opponent: 'clint', mixed: true };
  assert.deepEqual(lineup(mixed, 0, 10), ['latest', 'clint', 'clint', 'clint']);
  assert.deepEqual(lineup(mixed, 1, 11), ['clint', 'clint', 'clint', 'latest']);
  assert.throws(() => lineup(task, 2, 0));
});

test('repeated seeded rounds preserve deal/leader/outcome and reject invalid network values', async () => {
  const args = {
    seed: 933001,
    seats: ['a', 'b', 'a', 'b'],
    values: async (_, s) => new Float32Array(s.actions.length),
  };
  const a = await playRound(args),
    b = await playRound(args);
  assert.deepEqual(a, b);
  assert.equal(new Set(a.order).size, 4);
  assert.ok([1, 2, 3].includes(a.points));
  await assert.rejects(playRound({ ...args, values: async () => [NaN] }), /Invalid policy/);
});
