import { validateWindow } from './window.mjs';

/** Calendar slots for this finite window; no training configuration is rewritten. */
export function calendarSlot(window, now, schedule) {
  const { start, end } = validateWindow(window);
  const first = Date.parse(schedule.firstAt);
  if (
    schedule.schemaVersion !== 1 ||
    schedule.run !== 'guanzero-adp-io48' ||
    schedule.authority !== 'owner-request' ||
    schedule.timezone !== 'America/Toronto' ||
    schedule.intervalHours !== 12 ||
    JSON.stringify(schedule.requestedLocalHours) !== '[8,20]' ||
    !Number.isFinite(first) ||
    first < start ||
    first >= end ||
    !Number.isFinite(now) ||
    !Number.isSafeInteger(schedule.seedIndexBase) ||
    schedule.seedIndexBase < 5130 ||
    schedule.finalIndex !== 5150
  )
    throw Error('Invalid evaluation calendar');
  const interval = 12 * 3600000;
  const count = Math.ceil((end - first) / interval);
  if (schedule.seedIndexBase + count > schedule.finalIndex)
    throw Error('Evaluation seed slots overlap final slot');
  // Reject anchors or timezone transitions that would move either local clock time.
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: schedule.timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let n = 0; n < count; n++) {
    if (clock.format(first + n * interval) !== (n % 2 ? '20:00:00' : '08:00:00'))
      throw Error('Evaluation slots must stay at Toronto 08:00 and 20:00');
  }
  if (now >= end) return { slot: 100 + count, index: schedule.finalIndex, final: true, due: end };
  if (now < first) throw Error('No evaluation due yet');
  const ordinal = Math.floor((now - first) / interval);
  return {
    slot: 100 + ordinal,
    index: schedule.seedIndexBase + ordinal,
    final: false,
    due: first + ordinal * interval,
  };
}
