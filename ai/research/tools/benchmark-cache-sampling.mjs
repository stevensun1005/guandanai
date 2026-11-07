/** Fixed-budget complete sampling probe; no learner, pool updates or web promotion. */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { option, readJSON, writeJSON, sha256 } from '../../danMCai/training/continuous/lib.mjs';
import { actorTotals } from '../../danMCai/training/continuous/remote.mjs';

const run = resolve(option('run', ''));
const planFile = resolve(option('protocol', ''));
const plan = readJSON(planFile);
const task = readJSON(join(run, 'campaign-task.json'));
if (!task || task.protocolSHA256 !== sha256(planFile))
  throw Error('Registered frozen protocol required');
for (const [file, digest] of Object.entries(plan.sourceSHA256)) {
  const text = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  const { createHash } = await import('node:crypto');
  if (createHash('sha256').update(text).digest('hex') !== digest)
    throw Error('Frozen source changed: ' + file);
}
for (const phase of plan.phases) {
  if (sha256(join(phase.run, 'config.json')) !== phase.configSHA256)
    throw Error('Configuration changed');
  if (sha256(join(phase.run, 'league/league.json')) !== phase.leagueSHA256)
    throw Error('Frozen opponent-pool metadata changed');
  for (const model of plan.weights)
    if (sha256(join(phase.run, model.relativeFile)) !== model.sha256) throw Error('Weight changed');
}
if (existsSync(join(run, 'phases.jsonl')))
  throw Error('Probe has already produced evidence; do not overwrite it');
const stopped = () =>
  existsSync(join(run, 'STOP')) || Date.now() >= Date.parse(task.window.deadlineUTC);
let index = 0,
  phase = 'starting',
  completedBefore = 0,
  minimumAvailableGiB = freemem() / 1024 ** 3;
let currentRun = null;
const children = new Set(),
  results = [];
const startedAtUTC = new Date().toISOString();
function status(extra = {}) {
  const actors = currentRun
    ? actorTotals(join(currentRun, 'actors'))
    : { matches: 0, decisions: 0 };
  writeJSON(join(run, 'status.json'), {
    pid: process.pid,
    phase,
    updatedAt: new Date().toISOString(),
    startedAtUTC,
    displayName: '真实采样验证 · 缓存 6 / 12',
    deadlineUTC: task.window.deadlineUTC,
    phaseIndex: index,
    sessionLimit: plan.phases[index]?.sessionLimit ?? null,
    completedMatches: completedBefore + actors.matches,
    plannedMatches: plan.plannedMatches,
    samplingDecisionsInPhase: actors.decisions,
    minimumAvailableGiB,
    optimizerUpdates: 0,
    strengthGames: 0,
    provider: 'dml',
    ...extra,
  });
}
let stoppingAt = null;
const timer = setInterval(() => {
  minimumAvailableGiB = Math.min(minimumAvailableGiB, freemem() / 1024 ** 3);
  if (stopped() || freemem() < 4 * 1024 ** 3) {
    if (!stoppingAt) {
      stoppingAt = Date.now();
      writeJSON(join(run, 'STOP'), { reason: stopped() ? 'probe-deadline' : 'memory-reserve' });
    }
    if (Date.now() - stoppingAt > 35000) for (const child of children) child.kill();
  }
  status();
}, 1000);
function launch(phasePlan, slot) {
  const fd = openSync(join(run, `phase-${index}-actor-${slot}.log`), 'a');
  const child = spawn(
    process.execPath,
    [
      join(plan.sourceRoot, 'ai/danMCai/training/continuous/fast-actor.mjs'),
      `--run=${phasePlan.run}`,
      `--slot=${slot}`,
      '--games=8',
      `--matches=${plan.matchesPerActor}`,
      '--provider=dml',
      `--session-limit=${phasePlan.sessionLimit}`,
      `--stop-file=${join(run, 'STOP')}`,
    ],
    { cwd: plan.sourceRoot, windowsHide: true, stdio: ['ignore', fd, fd] },
  );
  closeSync(fd);
  children.add(child);
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', (code) => {
      children.delete(child);
      code === 0 ? done() : fail(Error(`Sampler ${slot} exited ${code}`));
    });
  });
}
try {
  for (index = 0; index < plan.phases.length; index++) {
    if (stopped()) {
      phase = 'stopped';
      break;
    }
    const phasePlan = plan.phases[index];
    currentRun = phasePlan.run;
    while (!stopped() && freemem() < 6 * 1024 ** 3) {
      phase = 'waiting-for-memory';
      status();
      await new Promise((done) => setTimeout(done, 1000));
    }
    if (stopped()) {
      phase = 'stopped';
      break;
    }
    phase = 'running';
    status();
    const started = performance.now();
    const settled = await Promise.allSettled(
      Array.from({ length: plan.actors }, (_, slot) =>
        launch(phasePlan, slot).catch((error) => {
          writeJSON(join(run, 'STOP'), { reason: 'sampler-failed' });
          throw error;
        }),
      ),
    );
    if (settled.some((v) => v.status === 'rejected'))
      throw Error('Sampling phase failed; keep partial evidence');
    const actors = Array.from({ length: plan.actors }, (_, slot) =>
      readJSON(join(currentRun, `actors/actor-${slot}.json`)),
    );
    const totals = actorTotals(join(currentRun, 'actors'));
    if (stopped()) {
      phase = 'stopped';
      break;
    }
    if (
      actors.some(
        (a) =>
          a.matches !== plan.matchesPerActor ||
          a.failures ||
          a.inference.provider !== 'dml' ||
          a.inference.fallbackReason ||
          a.inference.peakSessions > phasePlan.sessionLimit,
      )
    )
      throw Error('Incomplete sampling or provider/session-bound violation');
    const elapsedSeconds = (performance.now() - started) / 1000;
    const row = {
      phaseIndex: index,
      sessionLimit: phasePlan.sessionLimit,
      elapsedSeconds,
      matches: totals.matches,
      decisions: totals.decisions,
      decisionsPerSecond: totals.decisions / elapsedSeconds,
      actors,
    };
    results.push(row);
    appendFileSync(join(run, 'phases.jsonl'), JSON.stringify(row) + '\n');
    completedBefore += totals.matches;
    currentRun = null;
  }
  phase = results.length === plan.phases.length ? 'complete' : 'stopped';
  writeJSON(join(run, 'summary.json'), {
    schema: 1,
    phase,
    kind: 'complete-sampling-throughput-not-playing-strength',
    protocolSHA256: sha256(planFile),
    completedAtUTC: new Date().toISOString(),
    plannedMatches: plan.plannedMatches,
    completedMatches:
      completedBefore + (currentRun ? actorTotals(join(currentRun, 'actors')).matches : 0),
    phases: results,
    minimumAvailableGiB,
    optimizerUpdates: 0,
    strengthGames: 0,
    scope: plan.scope,
  });
  status({ stoppedAt: new Date().toISOString() });
  if (phase !== 'complete') process.exitCode = 2;
} catch (error) {
  phase = 'failed';
  status({ failure: error.stack, stoppedAt: new Date().toISOString() });
  throw error;
} finally {
  clearInterval(timer);
}
