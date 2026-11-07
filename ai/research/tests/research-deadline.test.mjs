import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  HARD_DEADLINE,
  COMPUTE_DEADLINE,
  researchWindow,
  safeRun,
  enforceDeadlines,
} from '../tools/research-deadline.mjs';

test('research windows cannot extend Wednesday cutoff, restart their clocks or stop legacy runs', () => {
  const campaign = {
    deadlineUTC: HARD_DEADLINE,
    computeDeadlineUTC: COMPUTE_DEADLINE,
    restartExtendsDeadline: false,
  };
  const now = Date.parse('2026-11-11T15:00:00Z');
  const first = researchWindow(campaign, null, 12, now);
  assert.equal(first.window.deadlineUTC, COMPUTE_DEADLINE);
  assert.equal(researchWindow(campaign, first.window, 12, now + 3600000).remainingSeconds, 2700);
  assert.throws(() => researchWindow(campaign, first.window, 13, now), /alter/);
  assert.throws(
    () => researchWindow(campaign, first.window, 12, Date.parse(COMPUTE_DEADLINE)),
    /expired/,
  );
  assert.throws(
    () => researchWindow({ ...campaign, deadlineUTC: '2026-11-12T17:00:00Z' }, null, 4, now),
    /cannot be extended/,
  );
  const root = mkdtempSync(join(tmpdir(), 'danmcai-campaign-'));
  try {
    const run = join(root, 'experiments', 'candidate-1');
    mkdirSync(join(run, 'evaluation'), { recursive: true });
    const legacy = join(root, 'gpu-main');
    mkdirSync(legacy);
    assert.throws(() => safeRun(root, legacy), /dedicated/);
    const tasks = [{ id: 'candidate-1', run, window: first.window }];
    assert.equal(enforceDeadlines(root, tasks, now).stopped.length, 0);
    assert.equal(enforceDeadlines(root, tasks, Date.parse(COMPUTE_DEADLINE)).stopped.length, 1);
    assert.ok(existsSync(join(run, 'STOP')) && existsSync(join(run, 'evaluation/STOP')));
    assert.ok(!existsSync(join(legacy, 'STOP')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
