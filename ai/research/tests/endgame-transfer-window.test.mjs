import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWindow } from '../tools/endgame-transfer-window.mjs';

test('only explicit5AM training/8AM evaluation amendment keeps original start and bounded evaluation/save', () => {
  const originalStartUTC = '2026-11-12T16:58:54.268Z',
    trainingDeadlineUTC = '2026-11-13T10:00:00.000Z';
  const hours = (Date.parse(trainingDeadlineUTC) - Date.parse(originalStartUTC)) / 3600000;
  const p = {
    run: { hours },
    ownerDeadlineAmendment: {
      kind: 'owner-explicit-deadline-revision',
      originalStartUTC,
      trainingDeadlineUTC,
    },
  };
  const r = {
    startUTC: originalStartUTC,
    trainingDeadlineUTC,
    evaluationDeadlineUTC: '2026-11-13T13:00:00.000Z',
    deadlineUTC: '2026-11-13T13:15:00.000Z',
    durationHours: hours + 3.25,
    restartExtendsDeadline: false,
  };
  const now = Date.parse('2026-11-13T04:30:00Z');
  assert.doesNotThrow(() => validateWindow(p, r, now));
  assert.throws(() => validateWindow({ ...p, ownerDeadlineAmendment: undefined }, r, now));
  assert.throws(() =>
    validateWindow(p, { ...r, trainingDeadlineUTC: '2026-11-13T14:00:00Z' }, now),
  );
  assert.throws(() => validateWindow(p, { ...r, startUTC: '2026-11-13T04:30:00Z' }, now));
  assert.throws(() =>
    validateWindow(p, { ...r, evaluationDeadlineUTC: '2026-11-13T17:00:00Z' }, now),
  );
  assert.throws(() => validateWindow(p, r, Date.parse(trainingDeadlineUTC)));
});

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
