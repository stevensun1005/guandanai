import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWindow } from '../tools/endgame-transfer-window.mjs';

test('endgame transfer cannot reset, extend, or resume an expired registration', () => {
  const start = Date.parse('2026-11-12T17:00:00Z');
  const reg = {
    startUTC: new Date(start).toISOString(),
    durationHours: 19.25,
    restartExtendsDeadline: false,
    trainingDeadlineUTC: new Date(start + 16 * 3600000).toISOString(),
    evaluationDeadlineUTC: new Date(start + 19 * 3600000).toISOString(),
    deadlineUTC: new Date(start + 19.25 * 3600000).toISOString(),
  };
  assert.doesNotThrow(() => validateWindow({ run: { hours: 16 } }, reg, start + 3600000));
  assert.throws(() => validateWindow({ run: { hours: 16 } }, reg, start + 16 * 3600000), /expired/);
  for (const field of ['trainingDeadlineUTC', 'evaluationDeadlineUTC', 'deadlineUTC'])
    assert.throws(() =>
      validateWindow(
        { run: { hours: 16 } },
        { ...reg, [field]: new Date(Date.parse(reg[field]) + 1).toISOString() },
        start,
      ),
    );
  assert.throws(() =>
    validateWindow({ run: { hours: 16 } }, { ...reg, restartExtendsDeadline: true }, start),
  );
});
