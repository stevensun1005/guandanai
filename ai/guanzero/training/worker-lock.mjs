import { existsSync, openSync, writeFileSync, closeSync, unlinkSync, readFileSync } from 'node:fs';
export function workerAlive(file) {
  if (!existsSync(file)) return false;
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0)
    throw Error('Invalid worker lock; preserve and inspect');
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
export function acquireWorkerLock(file, metadata = {}) {
  if (existsSync(file)) {
    if (workerAlive(file)) throw Error('Opponent worker already running');
    unlinkSync(file);
  }
  const fd = openSync(file, 'wx');
  writeFileSync(fd, JSON.stringify({ ...metadata, pid: process.pid }));
  return () => {
    closeSync(fd);
    if (JSON.parse(readFileSync(file, 'utf8')).pid !== process.pid)
      throw Error('Worker lock replaced');
    unlinkSync(file);
  };
}
