import { validateWindow } from './window.mjs';
/** Windows watchdog for an existing fixed GuanZero training window. */
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export function recoveryDecision({ now, end, stopped, learnerError, supervisorAlive, orphaned }) {
  if (now >= end) return 'expired';
  if (stopped) return 'stopped';
  if (learnerError) return 'learner-error';
  if (supervisorAlive) return 'healthy';
  return orphaned ? 'orphaned' : 'restart';
}
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const hash = async (p) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(readFileSync(p)).digest('hex');
};
function processes() {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='python.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const value = JSON.parse(output || '[]');
  return Array.isArray(value) ? value : [value];
}
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
}
function save(file, value) {
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}
export async function watch({ run, runtime, control, once = false }) {
  run = resolve(run);
  runtime = resolve(runtime);
  control = resolve(control);
  mkdirSync(control, { recursive: true });
  const lock = join(control, '.lock'),
    status = join(control, 'status.json');
  if (existsSync(lock)) {
    if (running(read(lock).pid)) throw Error('Watchdog already active');
    unlinkSync(lock);
  }
  closeSync(openSync(lock, 'wx'));
  save(lock, { pid: process.pid });
  const configFile = join(run, 'config.json'),
    windowFile = join(run, 'window.json');
  const original = { config: await hash(configFile), window: await hash(windowFile) };
  const window = read(windowFile),
    config = read(configFile);
  validateWindow(window);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: runtime,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (commit !== config.commit) throw Error('Frozen runtime identity mismatch');
  let failures = 0,
    nextAttempt = 0,
    orphanSince = null;
  const record = {
    pid: process.pid,
    run,
    runtime,
    commit,
    plannedEnd: window.plannedEnd,
    restarts: 0,
  };
  try {
    do {
      try {
        if (
          (await hash(configFile)) !== original.config ||
          (await hash(windowFile)) !== original.window
        )
          throw Error('Frozen configuration or window changed');
        const list = processes(),
          owner = existsSync(join(run, 'supervisor.lock'))
            ? read(join(run, 'supervisor.lock')).pid
            : null;
        const token = '--run=' + run;
        const owned = list.filter((p) => p.CommandLine?.includes(token));
        const supervisor = owned.find(
          (p) => p.ProcessId === owner && p.CommandLine.includes('ai/guanzero/training/run.mjs'),
        );
        const children = owned.filter((p) =>
          /ai[\\/]guanzero[\\/]training[\\/](actor\.mjs|learner\.py|inference\.py)/.test(
            p.CommandLine,
          ),
        );
        const learner = read(join(run, 'learner/status.json'));
        let phase = recoveryDecision({
          now: Date.now(),
          end: Date.parse(window.plannedEnd),
          stopped: existsSync(join(run, 'STOP')),
          learnerError: learner.error,
          supervisorAlive: Boolean(supervisor),
          orphaned: children.length > 0,
        });
        record.phase = phase;
        record.step = learner.step;
        record.supervisorPid = supervisor?.ProcessId ?? null;
        record.updatedAt = new Date().toISOString();
        record.error = null;
        if (['expired', 'stopped'].includes(phase)) {
          save(status, record);
          return record;
        }
        if (phase === 'learner-error') {
          record.error = learner.error;
          save(status, record);
          return record;
        }
        if (phase === 'healthy') {
          orphanSince = null;
          failures = 0;
        }
        if (phase === 'orphaned') {
          orphanSince ??= Date.now();
          if (Date.now() - orphanSince >= 30000) {
            // Recheck supervisor ownership immediately before retiring its exact-run orphans.
            const current = processes();
            if (
              current.some(
                (p) =>
                  p.CommandLine?.includes(token) &&
                  p.CommandLine.includes('ai/guanzero/training/run.mjs'),
              )
            )
              throw Error('Supervisor appeared during orphan recovery');
            for (const child of children) {
              const confirmed = current.find(
                (p) => p.ProcessId === child.ProcessId && p.CommandLine === child.CommandLine,
              );
              if (confirmed) process.kill(confirmed.ProcessId);
            }
            record.phase = 'retired-orphans';
            orphanSince = null;
          }
        }
        if (phase === 'restart' && Date.now() >= nextAttempt) {
          const pythonCode =
            "import sys,torch,json; p=torch.load(sys.argv[1],map_location='cpu',weights_only=False); assert all(k in p for k in ('model','optimizer','step','used','consumed')); print(json.dumps({'step':p['step']}))";
          const checkpoint = JSON.parse(
            execFileSync(config.python, ['-c', pythonCode, join(run, 'learner/state.pt')], {
              cwd: runtime,
              encoding: 'utf8',
              windowsHide: true,
              timeout: 60000,
            }),
          );
          if (existsSync(join(run, 'STOP')) || Date.now() >= Date.parse(window.plannedEnd))
            continue;
          if (
            processes().some(
              (p) =>
                p.CommandLine?.includes(token) &&
                p.CommandLine.includes('ai/guanzero/training/run.mjs'),
            )
          )
            continue;
          const out = openSync(join(control, 'training.stdout.log'), 'a'),
            err = openSync(join(control, 'training.stderr.log'), 'a');
          try {
            const child = spawn(process.execPath, ['ai/guanzero/training/run.mjs', token], {
              cwd: runtime,
              windowsHide: true,
              stdio: ['ignore', out, err],
            });
            await new Promise((resolve, reject) => {
              child.once('spawn', resolve);
              child.once('error', reject);
            });
            child.once('error', () => {});
            record.supervisorPid = child.pid;
            record.resumedFromStep = checkpoint.step;
          } finally {
            closeSync(out);
            closeSync(err);
          }
          record.restarts++;
          record.phase = 'restarting';
          record.lastRestartAt = new Date().toISOString();
          nextAttempt = Date.now() + 60000;
        }
        save(status, record);
      } catch (error) {
        failures++;
        record.phase = 'error';
        record.error = String(error.stack || error);
        record.updatedAt = new Date().toISOString();
        save(status, record);
        nextAttempt = Date.now() + Math.min(300000, 10000 * 2 ** Math.min(failures, 5));
      }
      if (!once) await sleep(15000);
    } while (!once);
    return record;
  } finally {
    if (existsSync(lock) && read(lock).pid === process.pid) unlinkSync(lock);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [run, runtime, control] = process.argv.slice(2);
  if (!run || !runtime || !control)
    throw Error('Pass run, frozen runtime and watchdog control directory');
  console.log(
    JSON.stringify(await watch({ run, runtime, control, once: process.argv.includes('--once') })),
  );
}
