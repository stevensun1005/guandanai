import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarSlot } from '../training/calendar-slot.mjs';
import { windowSlot } from '../training/register-window-suite.mjs';

const start = Date.parse('2026-11-06T03:11:40.256Z');
const end = Date.parse('2026-11-11T15:00:00.000Z');
const window = {
  startedAt: new Date(start).toISOString(),
  plannedEnd: new Date(end).toISOString(),
  midpointAt: new Date(start + 24 * 3600000).toISOString(),
  hours: (end - start) / 3600000,
  seedIndex: 5100,
  extension: {
    authority: 'owner-request',
    authorizedAt: '2026-11-07T14:00:00Z',
    originalPlannedEnd: new Date(start + 48 * 3600000).toISOString(),
  },
};
const schedule = {
  schemaVersion: 1,
  run: 'guanzero-adp-io48',
  authority: 'owner-request',
  timezone: 'America/Toronto',
  firstAt: '2026-11-09T13:00:00.000Z',
  intervalHours: 12,
  requestedLocalHours: [8, 20],
  seedIndexBase: 5130,
  finalIndex: 5150,
};
const slot = (time, changes = {}) =>
  calendarSlot(window, Date.parse(time), { ...schedule, ...changes });

test('old 22:12 trigger and pre-08:00 calls cannot freeze a new calendar model', () => {
  assert.throws(() => slot('2026-11-09T03:12:00Z'), /No evaluation due/);
  assert.throws(() => slot('2026-11-09T12:59:59.999Z'), /No evaluation due/);
});
test('Toronto 08:00/20:00 get distinct slots rather than old training-start slots', () => {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Toronto',
    hour: '2-digit',
    minute: '2-digit',
  });
  const oldIndices = new Set([5098, 5100, 5110, 5101, 5103, 5111, 5120]);
  for (let n = 0; n < 5; n++) {
    const now = Date.parse(schedule.firstAt) + n * 12 * 3600000;
    const result = calendarSlot(window, now, schedule);
    assert.equal(clock.format(result.due), n % 2 ? '20:00' : '08:00');
    assert.equal(result.index, 5130 + n);
    assert.equal(result.final, false);
    assert.ok(!oldIndices.has(result.index));
    assert.deepEqual(calendarSlot(window, now + 60000, schedule), result);
  }
  assert.equal(windowSlot(window, Date.parse(schedule.firstAt)).index, 5121);
});
test('Wednesday 10:00 has a separate final slot without extending training', () => {
  assert.equal(slot('2026-11-11T14:59:59Z').index, 5134);
  assert.deepEqual(slot('2026-11-11T15:00:00Z'), { slot: 105, index: 5150, final: true, due: end });
  assert.equal(window.plannedEnd, '2026-11-11T15:00:00.000Z');
});
test('reject off-clock anchors, malformed calendars and final seed collisions', () => {
  for (const changes of [
    { firstAt: '2026-11-09T13:12:00Z' },
    { intervalHours: 8 },
    { timezone: 'UTC' },
    { seedIndexBase: 5149 },
    { finalIndex: 5131 },
    { run: 'other-run' },
  ])
    assert.throws(() => slot('2026-11-09T13:00:00Z', changes));
});
