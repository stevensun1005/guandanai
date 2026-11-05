import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationPhase, evaluationElapsed } from '../evaluation/monitor-fixed.mjs';
test('completed fixed workers stay complete after normal exit while incomplete exits remain failures', () => {
  assert.equal(evaluationPhase([]), 'failed');
  assert.equal(
    evaluationPhase([
      { phase: 'complete', alive: false },
      { phase: 'complete', alive: false },
    ]),
    'complete',
  );
  assert.equal(
    evaluationPhase([
      { phase: 'complete', alive: false },
      { phase: 'waiting-for-memory', alive: true },
    ]),
    'running',
  );
  assert.equal(evaluationPhase([{ phase: 'running', alive: false }]), 'failed');
  assert.equal(evaluationPhase([{ phase: 'failed', alive: true }]), 'failed');
});
test('finished match duration does not grow while desktop observations keep refreshing', () => {
  const start = '2026-11-05T17:00:00Z';
  const workers = [
    { updatedAtUTC: '2026-11-05T17:01:00Z' },
    { updatedAtUTC: '2026-11-05T17:02:00Z' },
  ];
  assert.equal(
    evaluationElapsed(start, workers, 'complete', Date.parse('2026-11-05T20:00:00Z')),
    120,
  );
});
