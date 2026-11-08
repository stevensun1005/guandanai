/** Private browser-local host state. Never used as a public peer/spectator payload. */
export const HOST_KEY = 'guandan-host-table-v1';
export const HOST_KEEP_MS = 3 * 3600000;
export function readHost(storage, version, now = Date.now()) {
  try {
    const value = JSON.parse(storage.getItem(HOST_KEY) || 'null');
    return value?.schema === 1 &&
      value.version === version &&
      /^\d{4}$/.test(value.code) &&
      ['S', 'E', 'N', 'W'].includes(value.direction) &&
      value.game?.hands?.length === 4 &&
      Number.isFinite(value.savedAt) &&
      value.savedAt <= now &&
      now - value.savedAt < HOST_KEEP_MS
      ? value
      : null;
  } catch {
    return null;
  }
}
export function clearHost(storage) {
  try {
    storage.removeItem(HOST_KEY);
  } catch {}
}
export function writeHost(storage, value, now = Date.now()) {
  try {
    storage.setItem(HOST_KEY, JSON.stringify({ ...value, schema: 1, savedAt: now }));
    return true;
  } catch {
    return false;
  }
}
