import { execFileSync } from 'node:child_process';
import { freemem, totalmem } from 'node:os';

// macOS keeps reclaimable pages in the inactive queue; raw free pages alone are
// not a usable headroom measurement (see psutil's macOS virtual_memory).
export function macAvailableBytes(output) {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1]);
  const free = Number(output.match(/^Pages free:\s+(\d+)\./m)?.[1]);
  const inactive = Number(output.match(/^Pages inactive:\s+(\d+)\./m)?.[1]);
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    !Number.isSafeInteger(free) ||
    !Number.isSafeInteger(inactive)
  )
    throw Error('Invalid vm_stat memory counters');
  const bytes = (free + inactive) * pageSize;
  if (!Number.isSafeInteger(bytes)) throw Error('Invalid vm_stat memory size');
  return bytes;
}

export function memoryAvailability({
  platform = process.platform,
  rawFreeBytes = freemem(),
  totalBytes = totalmem(),
  readVM = () => execFileSync('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 1500 }),
} = {}) {
  const result = { availableBytes: rawFreeBytes, rawFreeBytes, measurement: 'os.freemem' };
  if (platform !== 'darwin') return result;
  try {
    const bytes = macAvailableBytes(readVM());
    if (bytes > totalBytes) throw Error('vm_stat exceeds physical memory');
    return { ...result, availableBytes: bytes, measurement: 'vm_stat free + inactive' };
  } catch (error) {
    return { ...result, measurementError: error.message };
  }
}

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
