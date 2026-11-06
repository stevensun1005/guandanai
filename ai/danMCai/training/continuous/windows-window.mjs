/** Opt-in launcher for a NEW bounded Windows experiment. Inspection never starts its clock. */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { option, readJSON, writeJSON, sha256 } from './lib.mjs';
import { sourceHashes } from './sources.mjs';

export function windowPlan(existing, hours, now = Date.now()) {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 6)
    throw Error('Specify an authorized budget of at most six hours');
  const schedule = existing ?? {
    startUTC: new Date(now).toISOString(),
    deadlineUTC: new Date(now + hours * 3600000).toISOString(),
    durationHours: hours,
    restartExtendsDeadline: false,
  };
  if (
    schedule.durationHours !== hours ||
    schedule.restartExtendsDeadline !== false ||
    Date.parse(schedule.deadlineUTC) - Date.parse(schedule.startUTC) !== hours * 3600000
  )
    throw Error('Cannot change the saved window');
  const remainingHours = (Date.parse(schedule.deadlineUTC) - now) / 3600000;
  if (!(remainingHours > 0)) throw Error('Fixed window has expired; no restart');
  return { schedule, remainingHours };
}

async function main() {
  const run = resolve(option('run', ''));
  const prepared = readJSON(join(run, 'PREPARED-NOT-STARTED.json'));
  const config = readJSON(join(run, 'config.json'));
  if (!prepared || !config) throw Error('Use a prepared Windows run');
  if (JSON.stringify(config.sourceSHA256) !== JSON.stringify(sourceHashes()))
    throw Error('Frozen source mismatch');
  if (!process.argv.includes('--start')) {
    console.log(
      JSON.stringify({
        run,
        prepared: true,
        started: false,
        scheduleCreated: false,
        existingSchedule: readJSON(join(run, 'schedule.json')),
        requires:
          'Owner-confirmed hours, --start, --authorization=<record>, --python=<GPU Python>, --verification=<GPU report>',
      }),
    );
    return;
  }
  if (process.platform !== 'win32' || !option('authorization', ''))
    throw Error('Windows and explicit new-window authorization required');
  const verification = readJSON(resolve(option('verification', '')));
  if (
    !verification?.passed ||
    verification.platform !== 'win32' ||
    verification.backendActuallyTested !== 'cuda:0' ||
    verification.checkpointSHA256 !== prepared.checkpointSHA256
  )
    throw Error('Matching Windows GPU preflight required');
  const python = resolve(option('python', ''));
  if (!existsSync(python) || !python.endsWith('python.exe'))
    throw Error('Specify the verified GPU Python');
  if (freemem() < 5 * 1024 ** 3) throw Error('Insufficient free RAM; keep four GiB reserved');
  const disk = statfsSync(run);
  if (disk.bavail * disk.bsize < 8 * 1024 ** 3) throw Error('Insufficient disk space');
  const file = join(run, 'schedule.json');
  const plan = windowPlan(readJSON(file), Number(option('hours', '0')));
  const lock = join(run, 'windows-launch.lock');
  const previous = readJSON(lock);
  if (previous) {
    try {
      process.kill(previous.pid, 0);
      throw Error('Launcher already active');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    unlinkSync(lock);
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  let timer;
  try {
    if (!existsSync(file)) {
      if (sha256(join(run, 'learner/checkpoint.pt')) !== prepared.checkpointSHA256)
        throw Error('Initial checkpoint changed');
      writeJSON(file, { ...plan.schedule, authorization: option('authorization', '') });
    }
    timer = setTimeout(
      () =>
        writeJSON(join(run, 'STOP'), {
          reason: 'authorized-time-limit',
          deadlineUTC: plan.schedule.deadlineUTC,
          at: new Date().toISOString(),
        }),
      Math.max(0, Date.parse(plan.schedule.deadlineUTC) - Date.now()),
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./supervisor.mjs', import.meta.url)),
        `--run=${run}`,
        `--python=${python}`,
        `--hours=${plan.remainingHours}`,
      ],
      { stdio: 'inherit', env: { ...process.env, OMP_NUM_THREADS: '1' } },
    );
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.on(signal, () => writeJSON(join(run, 'STOP'), { reason: signal }));
    await new Promise((resolveChild, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => {
        process.exitCode = code ?? 1;
        resolveChild();
      });
    });
  } finally {
    clearTimeout(timer);
    if (readJSON(lock)?.pid === process.pid) unlinkSync(lock);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
