import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, copyFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { windowPlan } from '../training/continuous/windows-window.mjs';
import { trimLeagueMembership } from '../training/continuous/lib.mjs';
import { createBatchedPool } from '../training/continuous/batch-inference.mjs';

test('fixed Windows windows retain their deadline and reject expiration or new durations', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  const plan = windowPlan(null, 4, now);
  assert.equal(windowPlan(plan.schedule, 4, now + 3600000).remainingHours, 3);
  assert.equal(plan.schedule.deadlineUTC, '2026-11-07T04:00:00.000Z');
  assert.throws(() => windowPlan(plan.schedule, 5, now), /change/);
  assert.throws(() => windowPlan(plan.schedule, 4, now + 14400000), /expired/);
  for (const hours of [0, -1, NaN, 7]) assert.throws(() => windowPlan(null, hours, now));
});

test('retired league opponent remains reloadable after real worker session eviction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'danmcai-retained-'));
  const pool = await createBatchedPool(ort, { provider: 'cpu', sessionLimit: 1 });
  try {
    const old = join(dir, 'old.onnx'),
      next = join(dir, 'next.onnx');
    for (const file of [old, next]) copyFileSync('ai/danMCai/models/baseline/policy.onnx', file);
    const league = {
      members: [
        { id: 'old', file: 'old.onnx' },
        { id: 'next', file: 'next.onnx', pinned: true },
      ],
      stats: { old: { wins: 1 } },
    };
    const state = JSON.parse(readFileSync('ai/shared/fixtures/positions.json', 'utf8'))[0];
    const first = await pool.values(old, state);
    trimLeagueMembership(league, 1);
    assert.deepEqual(
      league.members.map((m) => m.id),
      ['next'],
    );
    assert.equal(league.stats.old, undefined);
    assert.ok(existsSync(old));
    await pool.values(next, state);
    const reloaded = await pool.values(old, state);
    assert.deepEqual(reloaded, first);
    assert.ok(pool.stats.sessionsReleased >= 2);
  } finally {
    await pool.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
