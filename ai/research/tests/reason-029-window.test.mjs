import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRegistration,
  playKey,
  segmentSeeds,
  OWNER_WINDOWS,
} from '../tools/reason-029-window.mjs';
test('029-reason fixed owner cutoff cannot be extended or restarted after expiry', () => {
  const plan = { id: 'reason-029-20261114' },
    reg = {
      deadlineUTC: '2026-11-14T18:00:00.000Z',
      trainingDeadlineUTC: '2026-11-14T15:00:00.000Z',
      generationDeadlineUTC: '2026-11-14T14:45:00.000Z',
      evaluationDeadlineUTC: '2026-11-14T17:45:00.000Z',
      restartExtendsDeadline: false,
    };
  assert.doesNotThrow(() => validateRegistration(plan, reg, Date.parse('2026-11-14T05:00Z')));
  assert.throws(() =>
    validateRegistration(
      plan,
      { ...reg, deadlineUTC: '2026-11-14T19:00Z' },
      Date.parse('2026-11-14T05:00Z'),
    ),
  );
  assert.throws(() => validateRegistration(plan, reg, Date.parse('2026-11-14T18:00Z')));
  assert.equal(
    playKey({ type: 1, value: 4, n: 2, cards: [{ id: 8 }, { id: 2 }] }),
    playKey({ type: 1, value: 4, n: 2, cards: [{ id: 2 }, { id: 8 }] }),
  );
  assert.equal(playKey(null), 'pass');
});
test('new continuation keeps the confirmed Nov15 9AM cutoff and disjoint complete generation blocks', () => {
  const plan = {
    id: 'reason-029-continue-20261115',
    generationSlots: { reason: 2 },
    segmentSizes: { reason: 800 },
    data: { reason: Array.from({ length: 1600 }, (_, i) => 10000 + i) },
  };
  const reg = { ...OWNER_WINDOWS[plan.id], restartExtendsDeadline: false };
  assert.doesNotThrow(() => validateRegistration(plan, reg, Date.parse('2026-11-15T05:00Z')));
  assert.equal(reg.trainingDeadlineUTC, '2026-11-15T14:00:00.000Z');
  assert.throws(() =>
    validateRegistration(
      plan,
      { ...reg, trainingDeadlineUTC: '2026-11-16T14:00:00.000Z' },
      Date.parse('2026-11-15T05:00Z'),
    ),
  );
  const a = segmentSeeds(plan, 'reason', 0, 0),
    b = segmentSeeds(plan, 'reason', 0, 1);
  assert.equal(a.length, 400);
  assert.equal(b.length, 400);
  assert.deepEqual(
    [...a, ...b].sort((a, b) => a - b),
    plan.data.reason.slice(0, 800),
  );
  assert.equal(a.filter((s) => b.includes(s)).length, 0);
  assert.ok(segmentSeeds(plan, 'reason', 1, 0).every((s) => !a.includes(s) && !b.includes(s)));
});
