/** Hysteresis keeps memory pressure from repeatedly stopping/starting the same sampler. */
export function memoryAction({
  freeBytes,
  reserveGB = 4,
  resumeGB = 5,
  running = [],
  paused = [],
  now = Date.now(),
  lastActionAt = 0,
}) {
  if (now - lastActionAt < 20000) return null;
  if (freeBytes < reserveGB * 1024 ** 3) {
    const actor = running.filter((name) => !paused.includes(name)).at(-1);
    return actor ? { type: 'pause', actor } : null;
  }
  if (freeBytes > resumeGB * 1024 ** 3) {
    const actor = paused.find((name) => !running.includes(name));
    return actor ? { type: 'resume', actor } : null;
  }
  return null;
}
