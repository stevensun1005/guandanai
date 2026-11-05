import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryAction } from '../training/continuous/resources.mjs';

test('samplers shed load below the reserve and resume with hysteresis after exiting', () => {
  const base = {
    running: ['actor-0', 'actor-1'],
    paused: [],
    now: 50000,
    lastActionAt: 0,
    reserveGB: 4,
    resumeGB: 5,
  };
  const decide = (freeGB, extra = {}) =>
    memoryAction({ ...base, freeBytes: freeGB * 1024 ** 3, ...extra });
  assert.deepEqual(decide(3), { type: 'pause', actor: 'actor-1' });
  assert.equal(decide(4.5), null);
  assert.equal(decide(3, { lastActionAt: 40000 }), null);
  assert.deepEqual(decide(3, { paused: ['actor-1'] }), { type: 'pause', actor: 'actor-0' });
  assert.equal(
    decide(6, { paused: ['actor-1'] }),
    null,
    'do not duplicate an actor still flushing',
  );
  assert.deepEqual(decide(6, { running: ['actor-0'], paused: ['actor-1'] }), {
    type: 'resume',
    actor: 'actor-1',
  });
});
