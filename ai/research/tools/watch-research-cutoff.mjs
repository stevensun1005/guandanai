/** Owner's earlier Nov 11 cutoff. Tightens old immutable campaign; never extends it. */
import { closeSync, existsSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enforceDeadlines } from './research-deadline.mjs';
import { option, readJSON, sha256, writeJSON } from '../../danMCai/training/continuous/lib.mjs';

export const EARLY_END = '2026-11-11T15:00:00.000Z';
export const EARLY_COMPUTE_END = '2026-11-11T14:45:00.000Z';
export async function watchCutoff(root) {
  const file = join(root, 'authorization-20261108.json'),
    authorization = readJSON(file);
  if (
    authorization.deadlineUTC !== EARLY_END ||
    authorization.computeDeadlineUTC !== EARLY_COMPUTE_END
  )
    throw Error('Unexpected owner cutoff');
  const hash = sha256(file),
    lock = join(root, 'early-cutoff.lock');
  closeSync(openSync(lock, 'wx'));
  try {
    while (true) {
      const changed = sha256(file) !== hash,
        now = Date.now();
      if (changed || now >= Date.parse(EARLY_COMPUTE_END)) {
        enforceDeadlines(root, readJSON(join(root, 'tasks.json'), []), now, 'owner-earlier-cutoff');
        if (!existsSync(join(root, 'STOP')))
          writeJSON(join(root, 'STOP'), {
            reason: 'owner-earlier-cutoff',
            atUTC: new Date().toISOString(),
          });
      }
      writeJSON(join(root, 'early-cutoff-status.json'), {
        pid: process.pid,
        updatedAtUTC: new Date().toISOString(),
        deadlineUTC: EARLY_END,
        computeDeadlineUTC: EARLY_COMPUTE_END,
        authorizationSHA256: hash,
        failure: changed ? 'authorization-changed' : null,
      });
      if (changed || now >= Date.parse(EARLY_END)) {
        // Only the exact temporary helper recorded by this campaign; OS releases its thread request.
        const awake = readJSON(join(root, 'awake-status.json'));
        if (awake?.phase === 'awake') {
          const check = spawnSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(awake.pid)}"; if($p.CommandLine -like '*research-awake.ps1*' -and $p.CommandLine -like '*research-through-20261111*'){ Stop-Process -Id $p.ProcessId; exit 0 }; exit 1`,
            ],
            { windowsHide: true },
          );
          if (check.status !== 0) throw Error('Unable to verify/release exact awake helper');
          writeJSON(join(root, 'awake-status.json'), {
            ...awake,
            phase: 'released-by-owner-cutoff',
            updatedAtUTC: new Date().toISOString(),
            deadlineUTC: EARLY_END,
          });
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  } finally {
    unlinkSync(lock);
  }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url))
  await watchCutoff(resolve(option('campaign', '')));
