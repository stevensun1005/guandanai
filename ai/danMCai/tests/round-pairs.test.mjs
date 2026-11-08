import test from 'node:test';
import assert from 'node:assert/strict';
import { lineup, playRound, runRoundPairs } from '../evaluation/evaluate-round-pairs.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cooperationLabels } from '../evaluation/cooperation-labels.mjs';

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

test('worker observes a real STOP file before any policy request or completed pair', async () => {
  const run = mkdtempSync(join(tmpdir(), 'danmcai-round-worker-stop-'));
  try {
    const protocol = join(run, 'protocol.json');
    writeFileSync(
      protocol,
      JSON.stringify({
        evaluationDeadlineUTC: new Date(Date.now() + 60000).toISOString(),
        models: {},
        sourceSHA256: {},
        workers: 1,
        reserveGiB: 0,
        tasks: [{ id: 'probe', seeds: [1] }],
      }),
    );
    writeFileSync(join(run, 'STOP'), '{}');
    await runRoundPairs({ protocol, run, shard: 0, shards: 1 });
    const status = JSON.parse(readFileSync(join(run, 'worker-0.json'), 'utf8'));
    assert.equal(status.phase, 'stopped');
    assert.equal(status.completedPairs, 0);
    assert.equal(existsSync(join(run, 'worker-0.jsonl')), false);
  } finally {
    rmSync(run, { recursive: true, force: true });
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

test('isolated original/Clint evaluation and descriptive counts leave complete outcomes unchanged', async () => {
  const args = {
    seed: 933003,
    seats: ['a', 'original', 'a', 'clint'],
    values: async (_, s) => new Float32Array(s.actions.length),
  };
  const plain = await playRound(args);
  const described = await playRound({ ...args, capture: true, descriptive: true });
  const { trace, descriptions, ...outcome } = described;
  assert.deepEqual(outcome, plain);
  const rows = await cooperationLabels(trace.initial, trace.moves);
  for (let p = 0; p < 4; p++) {
    const own = rows.filter((r) => r.p === p);
    const expected = { decisions: own.length };
    for (const field of [
      'passes',
      'overPartner',
      'bombOverPartner',
      'opponentReceivesLeadAndFinishesWithinTwoActions',
    ])
      expected[field] = own.filter((r) => r[field === 'passes' ? 'passed' : field]).length;
    assert.deepEqual(descriptions[p], expected);
  }
});
