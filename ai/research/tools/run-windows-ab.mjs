/** Bounded sequential Windows A/B experiment; never publishes or promotes a model. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { option, readJSON, sha256, writeJSON } from '../../danMCai/training/continuous/lib.mjs';
import { actorTotals } from '../../danMCai/training/continuous/remote.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '../../..');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return !!pid;
  } catch {
    return false;
  }
};

export function armSnapshot(run, frozen) {
  const config = readJSON(join(run, 'config.json'));
  const status = readJSON(join(run, 'status.json'), {});
  const learner = readJSON(join(run, 'learner/status.json'), {});
  const schedule = readJSON(join(run, 'schedule.json'));
  const actors = actorTotals(join(run, 'actors'));
  const age = (Date.now() - Date.parse(status.updatedAt)) / 1000;
  return {
    run,
    schedule,
    frozen,
    phase: status.stoppedAt
      ? 'stopped'
      : alive(status.pid) && age < 90
        ? 'running'
        : schedule
          ? 'unconfirmed'
          : 'waiting',
    heartbeatAgeSeconds: Number.isFinite(age) ? age : null,
    updatedAt: status.updatedAt || null,
    stoppedAt: status.stoppedAt || null,
    stopReason: status.stopReason || null,
    latest: readJSON(join(run, 'models/latest.json')),
    inheritedStep: config.parent.latest.step,
    newUpdates: Math.max(
      0,
      (learner.step || config.parent.latest.step) - config.parent.latest.step,
    ),
    learner,
    actors,
    actorMix: config.actorMix,
    resources: status.resources || null,
    decisionsPerSecond: status.decisionsPerSecond || null,
  };
}

export function freezeEvaluation(settings, now = Date.now()) {
  const output = join(settings.directory, 'evaluation');
  const file = join(output, 'protocol.json');
  // Never reset an evaluation deadline or reselect models after any results exist.
  if (existsSync(file)) return file;
  mkdirSync(join(output, 'models'), { recursive: true });
  const plan = readJSON(settings.pendingProtocol);
  for (const [id, model] of Object.entries(plan.models)) {
    let source;
    if (id === 'A' || id === 'B') {
      const run = settings.arms[id];
      const status = readJSON(join(run, 'status.json'));
      const learner = readJSON(join(run, 'learner/status.json'));
      const latest = readJSON(join(run, 'models/latest.json'));
      const window = readJSON(join(run, 'schedule.json'));
      if (
        !status?.stoppedAt ||
        learner?.state !== 'stopped' ||
        status.running?.length ||
        alive(status.pid) ||
        alive(learner.pid)
      )
        throw Error('Training must have fully stopped before freezing ' + id);
      if (Date.parse(status.stoppedAt) < Date.parse(window.deadlineUTC) - 1000)
        throw Error('Arm stopped before its fixed window: ' + id);
      if (learner.step !== latest.step) throw Error('Final learner/export step mismatch: ' + id);
      source = join(run, 'models', latest.file);
      model.sha256 = latest.sha256;
      model.version = latest.version;
      model.step = latest.step;
      model.config = { stateFeatures: 513, actionFeatures: 54 };
    } else source = resolve(dirname(settings.pendingProtocol), model.file);
    if (sha256(source) !== model.sha256) throw Error('Model SHA mismatch: ' + id);
    const target = join(output, 'models', id + '.onnx');
    copyFileSync(source, target);
    model.file = 'models/' + id + '.onnx';
  }
  for (const [name, digest] of Object.entries(plan.sourceSHA256))
    if (sha256(join(settings.evaluationSource, name)) !== digest)
      throw Error('Evaluation source changed: ' + name);
  plan.evaluationDeadlineUTC = new Date(now + settings.evaluationHours * 3600000).toISOString();
  plan.status = 'frozen-before-results';
  plan.purpose =
    'Independent fixed-sample single-round A/B comparison; no automatic champion change';
  plan.frozenAtUTC = new Date(now).toISOString();
  plan.trainingAuthorization = settings.authorization;
  writeJSON(file, plan);
  return file;
}

function launch(executable, args, cwd, log) {
  const fd = openSync(log, 'a');
  const child = spawn(executable, args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, OMP_NUM_THREADS: '1' },
  });
  closeSync(fd);
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', (code, signal) =>
      code === 0 ? done() : fail(Error(`${log}: exit ${code}, signal ${signal}`)),
    );
  });
}

export function experimentSnapshot(settings, state) {
  const evaluation = join(settings.directory, 'evaluation');
  const protocol = readJSON(join(evaluation, 'protocol.json'));
  const workers = Array.from({ length: protocol?.workers || 4 }, (_, i) =>
    readJSON(join(evaluation, `worker-${i}.json`)),
  ).filter(Boolean);
  return {
    ...state,
    observedAtUTC: new Date().toISOString(),
    controllerAlive: alive(state.pid),
    memory: {
      availableGiB: freemem() / 1024 ** 3,
      totalGiB: totalmem() / 1024 ** 3,
      reserveGiB: 4,
      resumeGiB: 5,
    },
    arms: Object.fromEntries(
      Object.entries(settings.arms).map(([id, run]) => [
        id,
        armSnapshot(run, settings.trainingSource),
      ]),
    ),
    evaluation: {
      workers,
      deadlineUTC: protocol?.evaluationDeadlineUTC || null,
      plannedRounds: 24000,
      completedRounds: workers.reduce((n, w) => n + w.completedPairs * 2, 0),
      summary: readJSON(join(evaluation, 'summary.json')),
    },
    webChampionChanged: false,
  };
}

async function main() {
  const settingsFile = resolve(option('settings', ''));
  const settings = readJSON(settingsFile);
  if (
    settings?.hoursPerArm !== 4 ||
    settings.order?.join() !== 'A,B' ||
    !settings.authorization ||
    !(settings.evaluationHours > 0)
  )
    throw Error('Explicit fixed A-then-B four-hour authorization required');
  mkdirSync(settings.directory, { recursive: true });
  const stateFile = join(settings.directory, 'progress.json');
  const state = readJSON(stateFile, { phase: 'ready', armsComplete: [] });
  let cpuBefore = cpus();
  let cpuPercent = null;
  setInterval(() => {
    const after = cpus();
    const total = (list) =>
      list.reduce((n, c) => n + Object.values(c.times).reduce((a, b) => a + b, 0), 0);
    const idle = (list) => list.reduce((n, c) => n + c.times.idle, 0);
    const delta = total(after) - total(cpuBefore);
    cpuPercent = delta > 0 ? 100 * (1 - (idle(after) - idle(cpuBefore)) / delta) : null;
    cpuBefore = after;
  }, 5000).unref();
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end('Read only');
    }
    if (req.url === '/api/status') {
      try {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(
          JSON.stringify({
            ...experimentSnapshot(settings, readJSON(stateFile, state)),
            machineCPUPercent: cpuPercent,
          }),
        );
      } catch (error) {
        res.writeHead(503);
        return res.end(JSON.stringify({ error: error.message }));
      }
    }
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(readFileSync(join(here, 'windows-ab-dashboard.html')));
    }
    res.writeHead(404);
    res.end('Not found');
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(settings.port, '127.0.0.1', done);
  });
  console.log(`Windows A/B progress: http://127.0.0.1:${settings.port}/`);
  if (!process.argv.includes('--start')) return;
  const lock = join(settings.directory, 'controller.lock');
  if (existsSync(lock)) throw Error('Controller lock exists; audit it before any recovery');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, settings: settingsFile }), { flag: 'wx' });
  const save = (phase) => {
    Object.assign(state, { phase, pid: process.pid, updatedAtUTC: new Date().toISOString() });
    writeJSON(stateFile, state);
  };
  const stop = () => {
    writeJSON(join(settings.directory, 'STOP'), { atUTC: new Date().toISOString() });
    for (const run of Object.values(settings.arms))
      if (existsSync(join(run, 'schedule.json')) && !readJSON(join(run, 'status.json'))?.stoppedAt)
        writeJSON(join(run, 'STOP'), { reason: 'experiment-operator-stop' });
    mkdirSync(join(settings.directory, 'evaluation'), { recursive: true });
    writeJSON(join(settings.directory, 'evaluation/STOP'), { reason: 'experiment-operator-stop' });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    for (const id of settings.order) {
      if (state.armsComplete.includes(id)) continue;
      if (existsSync(join(settings.directory, 'STOP')))
        throw Error('Experiment stopped by operator');
      save('training-' + id);
      await launch(
        process.execPath,
        [
          join(settings.trainingSource, 'ai/danMCai/training/continuous/windows-window.mjs'),
          `--run=${settings.arms[id]}`,
          '--start',
          '--hours=4',
          `--authorization=${settings.authorization}`,
          `--python=${settings.python}`,
          `--verification=${settings.verification[id]}`,
        ],
        settings.trainingSource,
        join(settings.directory, `training-${id}.log`),
      );
      const status = readJSON(join(settings.arms[id], 'status.json'));
      const window = readJSON(join(settings.arms[id], 'schedule.json'));
      if (
        !status?.stoppedAt ||
        Date.parse(status.stoppedAt) < Date.parse(window.deadlineUTC) - 1000
      )
        throw Error('Stopped before authorized deadline: ' + id);
      state.armsComplete.push(id);
      save('completed-' + id);
    }
    if (existsSync(join(settings.directory, 'STOP'))) throw Error('Experiment stopped by operator');
    const protocol = freezeEvaluation(settings);
    save('independent-evaluation');
    const plan = readJSON(protocol);
    const settled = await Promise.allSettled(
      Array.from({ length: plan.workers }, (_, shard) =>
        launch(
          process.execPath,
          [
            join(settings.evaluationSource, 'ai/danMCai/evaluation/evaluate-round-pairs.mjs'),
            `--protocol=${protocol}`,
            `--run=${dirname(protocol)}`,
            `--shard=${shard}`,
            `--shards=${plan.workers}`,
          ],
          settings.evaluationSource,
          join(settings.directory, `evaluation-${shard}.log`),
        ).catch((error) => {
          writeJSON(join(dirname(protocol), 'STOP'), { reason: 'worker-failed', shard });
          throw error;
        }),
      ),
    );
    if (settled.some((s) => s.status === 'rejected'))
      throw Error(
        'Independent workers failed; preserve partial evidence, do not count it as complete',
      );
    await launch(
      settings.python,
      [
        join(settings.evaluationSource, 'ai/danMCai/evaluation/summarize-round-pairs.py'),
        '--protocol',
        protocol,
        '--results',
        dirname(protocol),
        '--output',
        join(dirname(protocol), 'summary.json'),
      ],
      settings.evaluationSource,
      join(settings.directory, 'summary.log'),
    );
    save('complete-awaiting-research-publication');
  } catch (error) {
    state.failure = error.stack;
    save('needs-attention');
    console.error(error.stack);
  } finally {
    unlinkSync(lock);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
)
  main().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
