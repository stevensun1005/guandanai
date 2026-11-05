/** Presentation identities: a batch counter is never a training checkpoint. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export function modelLabel(runName, digest, version, identities = {}) {
  const identity = identities[digest];
  const recorded = /^model-(\d+)$/.exec(String(version || ''));
  const step =
    identity?.sha256 === digest && Number.isSafeInteger(identity.step)
      ? identity.step
      : recorded
        ? Number(recorded[1])
        : null;
  return `${runName}-${Number.isSafeInteger(step) && step >= 0 ? step : String(digest || 'unknown').slice(0, 12)}`;
}
export function captureModelIdentities(run, identities = {}, seen = new Map()) {
  const folder = join(run, 'models');
  if (!existsSync(folder)) return false;
  let changed = false;
  for (const name of readdirSync(folder)) {
    const match = /^model-(\d+)\.onnx$/.exec(name);
    if (!match) continue;
    const file = join(folder, name);
    try {
      const stamp = statSync(file),
        key = `${stamp.size}:${stamp.mtimeMs}`;
      if (seen.get(name) === key) continue;
      const bytes = readFileSync(file),
        sha256 = createHash('sha256').update(bytes).digest('hex');
      const step = Number(match[1]);
      if (!Number.isSafeInteger(step)) continue;
      if (!identities[sha256]) {
        identities[sha256] = {
          sha256,
          step,
          version: name.slice(0, -5),
          bytes: bytes.length,
          observedAt: new Date().toISOString(),
          proof: 'full-sha256-of-named-export',
        };
        changed = true;
      }
      seen.set(name, key);
    } catch (error) {
      if (!['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return changed;
}
