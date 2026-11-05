/**
 * Run extra sampling actors on another machine that writes into a shared run directory.
 *
 *   node scripts/continuous/remote-actors.mjs --run=Z:/ --slots=8-15
 *
 * The learner, gates and league stay on the machine that runs supervisor.mjs. Before starting,
 * this launcher checks that the local checkout matches the run's frozen sources, refuses the
 * supervisor's own slots and slots claimed by another live machine, then keeps each actor
 * running: crashed actors restart with backoff, and while <run>/STOP exists it waits for the
 * supervisor to resume. Ctrl+C stops this machine only; unflushed rows (at most one shard
 * interval) are lost.
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { MAX_ACTORS, option, readJSON, runPaths } from './lib.mjs';
import { REPO_ROOT, parseSlots, sourceMismatches } from './remote.mjs';

const paths = runPaths(option('run', ''));
const slots = parseSlots(option('slots', ''));
const host = option('host', hostname());
const STALE_MS = 3 * 60_000;

if (!option('run', ''))
  throw Error('Usage: remote-actors.mjs --run=<shared run directory> --slots=8-15');
const config = readJSON(paths.config);
if (!config) throw Error(`No config.json in ${paths.root}; is the shared folder mapped correctly?`);
const mismatches = sourceMismatches(config);
if (mismatches.length)
  throw Error(
    `This checkout does not match the run's frozen sources; check out the same commit first.\n  ${mismatches.join('\n  ')}`,
  );
for (const slot of slots) {
  if (slot >= MAX_ACTORS) throw Error(`Slot ${slot} is outside 0-${MAX_ACTORS - 1}`);
  if (slot < config.actors)
    throw Error(`Slot ${slot} belongs to the supervisor (slots 0-${config.actors - 1})`);
}

const claimFile = (slot) => join(paths.actors, `claim-${slot}.json`);
function claim(slot) {
  const existing = readJSON(claimFile(slot), null);
  const fresh = existing && Date.now() - Date.parse(existing.heartbeat) < STALE_MS;
  if (fresh && existing.host !== host)
    throw Error(`Slot ${slot} is claimed by ${existing.host}; choose other slots`);
  const status = readJSON(join(paths.actors, `actor-${slot}.json`), null);
  const active = status?.updatedAt && Date.now() - Date.parse(status.updatedAt) < STALE_MS;
  if (active && !(existing?.host === host))
    throw Error(`Slot ${slot} wrote progress in the last 3 minutes without a claim from ${host}`);
}
function heartbeat() {
  for (const slot of slots)
    writeFileSync(
      claimFile(slot),
      JSON.stringify({ slot, host, pid: process.pid, heartbeat: new Date().toISOString() }),
    );
}
slots.forEach(claim);
heartbeat();

const logFile = join(paths.actors, `remote-${host.replace(/[^\w.-]/g, '_')}.jsonl`);
function log(kind, detail = {}) {
  const record = { t: new Date().toISOString(), host, kind, ...detail };
  try {
    appendFileSync(logFile, JSON.stringify(record) + '\n');
  } catch {
    // The share may be briefly unavailable; the console line still records the event.
  }
  console.log(JSON.stringify(record));
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const children = new Map();
const crashes = new Map();
let stopping = false;

function start(slot) {
  if (stopping) return;
  if (existsSync(paths.stop)) {
    setTimeout(() => start(slot), 30_000);
    return;
  }
  const child = spawn(
    process.execPath,
    [join(REPO_ROOT, 'scripts/continuous/actor.mjs'), `--run=${paths.root}`, `--slot=${slot}`],
    { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  let tail = '';
  child.stderr.on('data', (chunk) => (tail = (tail + chunk).slice(-3000)));
  child.on('exit', (code) => {
    children.delete(slot);
    if (stopping) return;
    if (existsSync(paths.stop)) {
      log('waiting-for-supervisor', { slot });
      setTimeout(() => start(slot), 30_000);
      return;
    }
    const now = Date.now();
    const recent = (crashes.get(slot) || []).filter((t) => now - t < 10 * 60_000);
    recent.push(now);
    crashes.set(slot, recent);
    const delay =
      recent.length > 20 ? 10 * 60_000 : Math.min(60_000, 2000 * 2 ** (recent.length - 1));
    log('actor-exit', { slot, code, restartInSeconds: delay / 1000, stderr: tail.slice(-1200) });
    setTimeout(() => start(slot), delay);
  });
  children.set(slot, child);
  log('actor-start', { slot, pid: child.pid });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill();
  for (const slot of slots) {
    const current = readJSON(claimFile(slot), null);
    if (current?.host === host) rmSync(claimFile(slot), { force: true });
  }
  log('stop');
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('start', {
  run: resolve(paths.root),
  slots,
  node: process.version,
  frozenSources: Object.keys(config.sourceSHA256).length,
  commit: gitCommit(),
});
slots.forEach(start);
setInterval(() => {
  try {
    heartbeat();
  } catch (error) {
    log('heartbeat-failed', { error: String(error?.message || error) });
  }
}, 30_000);
