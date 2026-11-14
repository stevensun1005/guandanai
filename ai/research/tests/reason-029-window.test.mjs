import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistration, playKey } from '../tools/reason-029-window.mjs';
test('029-reason fixed owner cutoff cannot be extended or restarted after expiry', () => {
  const plan = { id: 'reason-029-20261114' },
    reg = {
      deadlineUTC: '2026-11-14T18:00:00.000Z',
      trainingDeadlineUTC: '2026-11-14T11:00:00.000Z',
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
