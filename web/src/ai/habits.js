export const HABIT_ROUNDS = 4;
export const HABIT_DECAY = 0.6;

/** Recent public choices against opponents, separated from passing on a partner's lead. */
export function observeOpponentHabits(history, currentLog) {
  const seats = Array.from({ length: 4 }, () => ({ responses: 0, passes: 0, byType: {} }));
  const recent = history.slice(-HABIT_ROUNDS);
  const rounds = recent.map((record, index) => ({
    log: record.log,
    weight: HABIT_DECAY ** (recent.length - index),
  }));
  rounds.push({ log: currentLog, weight: 1 });
  for (const { log, weight } of rounds) {
    let last = null;
    for (const entry of log || []) {
      if (!Number.isInteger(entry.p) || entry.p < 0 || entry.p > 3) continue;
      const played = !!entry.cards?.length;
      if (!entry.lead && last && entry.p % 2 !== last.p % 2) {
        const seat = seats[entry.p];
        const key = `${last.type}:${last.cards.length}`;
        const bucket = (seat.byType[key] ||= { passes: 0, responds: 0 });
        seat.responses += weight;
        if (played) bucket.responds += weight;
        else {
          seat.passes += weight;
          bucket.passes += weight;
        }
      }
      if (played) last = entry;
    }
  }
  return seats;
}
