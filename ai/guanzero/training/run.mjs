import {
  existsSync,
  readFileSync,
  readdirSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import {
  paths,
  makePaths,
  readJSON,
  writeJSON,
  option,
  sha256,
  ROOT,
  actorTotals,
  stopped,
} from './lib.mjs';
const p = paths(option('run', 'ai/guanzero/runs/guanzero-adp'));
makePaths(p);
if (process.argv.includes('--status')) {
  console.log(
    JSON.stringify(
      {
        run: p.root,
        config: ((c) =>
          c && {
            device: c.device,
            actors: c.actors,
            objective: c.objective,
            batchSize: c.batchSize,
            python: c.python,
          })(readJSON(join(p.root, 'config.json'))),
        learner: readJSON(join(p.learner, 'status.json')),
        actors: actorTotals(p),
      },
      null,
      2,
    ),
  );
} else await main();
function sourceFiles(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(folder, e.name))
      : /\.(mjs|js|py)$/.test(e.name)
        ? [join(folder, e.name)]
        : [],
  );
}
function hashes() {
  const files = [
    ...sourceFiles(join(ROOT, 'ai/guanzero/training')),
    ...sourceFiles(join(ROOT, 'ai/shared/simulation')),
    ...sourceFiles(join(ROOT, 'web/src')),
    join(ROOT, 'ai/danMCai/training/continuous/lib.mjs'),
    join(ROOT, 'package-lock.json'),
    join(ROOT, 'ai/danMCai/models/baseline/policy.onnx'),
  ];
  return Object.fromEntries(
    files.sort().map((f) => [relative(ROOT, f).replaceAll('\\', '/'), sha256(f)]),
  );
}
function integerOption(name, fallback, min, max) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < min || value > max) throw Error(`Invalid --${name}`);
  return value;
}
async function main() {
  const lock = join(p.root, 'supervisor.lock');
  if (existsSync(lock)) {
    const owner = readJSON(lock);
    let active = false;
    try {
      process.kill(owner.pid, 0);
      active = true;
    } catch {}
    if (active) throw Error(`GuanZero run already owned by PID ${owner.pid}`);
    unlinkSync(lock);
  }
  const fd = openSync(lock, 'wx');
  writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  closeSync(fd);
  let timer = null,
    evalTimer = null,
    stopping = false;
  const children = new Map(),
    delays = new Map();
  const unlock = () => {
    if (readJSON(lock)?.pid === process.pid) unlinkSync(lock);
  };
  try {
    const configFile = join(p.root, 'config.json');
    let config = readJSON(configFile);
    const sourceSHA256 = hashes();
    if (config) {
      if (JSON.stringify(config.sourceSHA256) !== JSON.stringify(sourceSHA256))
        throw Error('GuanZero sources changed: use a new run directory');
      for (const key of [
        'device',
        'python',
        'objective',
        'actors',
        'batchSize',
        'learnerThreads',
        'inference',
        'inferencePort',
        'inferenceBatch',
        'inferenceWaitMs',
        'seed',
      ]) {
        const cli = key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        const explicit = process.argv.find((a) => a.startsWith(`--${cli}=`));
        if (explicit && String(config[key]) !== explicit.slice(explicit.indexOf('=') + 1))
          throw Error(`Cannot change frozen ${key}; use a new run directory`);
      }
    } else {
      const physical = Number(
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            '(Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum',
          ],
          { encoding: 'utf8', windowsHide: true },
        ).trim(),
      );
      const device = option('device', 'cuda');
      if (!['cuda', 'xpu', 'cpu'].includes(device)) throw Error('Invalid device');
      const objective = option('objective', 'adp');
      if (!['adp', 'wp'].includes(objective)) throw Error('Invalid objective');
      config = {
        schema: 1,
        method: 'GuanZero DMC',
        createdAt: new Date().toISOString(),
        seed: integerOption('seed', 20261104, 0, 2 ** 32 - 1),
        device,
        python: option(
          'python',
          join(ROOT, 'ai/danMCai/workspace/guanzero-gpu-env/Scripts/python.exe'),
        ),
        actors: integerOption('actors', Math.max(1, physical - (device === 'cpu' ? 2 : 1)), 1, 40),
        learnerThreads: integerOption(
          'learner-threads',
          device === 'cpu' ? (physical < 6 ? 2 : 4) : 1,
          1,
          64,
        ),
        batchSize: integerOption('batch-size', 3200, 1, 3200),
        objective,
        inference: option('inference', 'cpu'),
        inferencePort: integerOption('inference-port', 8771, 1024, 65535),
        inferenceBatch: integerOption('inference-batch', 32, 1, 256),
        inferenceWaitMs: integerOption('inference-wait-ms', 2, 0, 50),
        epsilon: 0.01,
        sourceSHA256,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: ROOT,
          encoding: 'utf8',
          windowsHide: true,
        }).trim(),
      };
      if (!['cpu', 'gpu-batch'].includes(config.inference))
        throw Error('Invalid inference backend');
      writeJSON(configFile, config);
    }
    if (stopped(p))
      throw Error(`Run is stopped: remove only this run's STOP to explicitly resume ${p.root}`);
    const hours = Number(option('hours', '24'));
    if (!Number.isFinite(hours) || hours <= 0) throw Error('Invalid hours');
    const deadline = Date.now() + hours * 3600000;
    const log = (event) => console.log(JSON.stringify({ t: new Date().toISOString(), ...event }));
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      clearInterval(evalTimer);
      writeFileSync(join(p.root, 'STOP'), 'GuanZero local shutdown\n');
      for (const timeout of delays.values()) clearTimeout(timeout);
      const force = setTimeout(() => {
        for (const child of children.values()) child.kill();
      }, 60000);
      force.unref();
      log({ kind: 'stopping', run: p.root });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    const start = (key, file, args = [], failures = 0) => {
      if (stopping || stopped(p)) return;
      const python = key === 'learner' || key === 'inference';
      const command = python ? config.python : process.execPath;
      const child = spawn(
        command,
        [join(ROOT, 'ai/guanzero/training', file), `--run=${p.root}`, ...args],
        { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true },
      );
      children.set(key, child);
      log({ kind: 'process-start', key, pid: child.pid });
      child.once('error', (error) => log({ kind: 'process-error', key, error: String(error) }));
      child.once('close', (code) => {
        children.delete(key);
        log({ kind: 'process-exit', key, code });
        if (stopping) return;
        if (key === 'learner' && readJSON(join(p.learner, 'status.json'))?.error) {
          shutdown();
          return;
        }
        const delay = Math.min(60000, 2000 * 2 ** Math.min(failures, 5));
        delays.set(
          key,
          setTimeout(() => start(key, file, args, failures + 1), delay),
        );
      });
    };
    start('learner', 'learner.py');
    if (config.inference === 'gpu-batch')
      start('inference', 'inference.py', [
        `--port=${config.inferencePort}`,
        `--device=${config.device}`,
        `--batch=${config.inferenceBatch}`,
        `--wait-ms=${config.inferenceWaitMs}`,
      ]);
    let actorsStarted = false,
      evaluating = false;
    const launchEvaluation = () => {
      if (evaluating || stopping) return;
      evaluating = true;
      const pairs = integerOption('eval-pairs', 100, 1, 100000);
      const child = spawn(
        process.execPath,
        [join(ROOT, 'ai/guanzero/training/evaluate.mjs'), `--run=${p.root}`, `--pairs=${pairs}`],
        { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true },
      );
      children.set('evaluation', child);
      log({ kind: 'evaluation-start', pid: child.pid, pairs });
      child.once('error', (error) => log({ kind: 'evaluation-error', error: String(error) }));
      child.once('close', (code) => {
        children.delete('evaluation');
        evaluating = false;
        log({ kind: 'evaluation-exit', code });
      });
    };
    timer = setInterval(() => {
      if (stopped(p) || Date.now() >= deadline) {
        shutdown();
        return;
      }
      const inferenceStatus = readJSON(join(p.root, 'inference/status.json'));
      const inferenceReady =
        config.inference !== 'gpu-batch' ||
        (inferenceStatus?.ready && Date.now() / 1000 - inferenceStatus.updatedAt < 10);
      if (!actorsStarted && inferenceReady && existsSync(join(p.models, 'latest.json'))) {
        actorsStarted = true;
        for (let slot = 0; slot < config.actors; slot++)
          start(`actor-${slot}`, 'actor.mjs', [`--slot=${slot}`]);
        if (option('eval-at-start', 'false') === 'true') launchEvaluation();
      }
    }, 1000);
    evalTimer = setInterval(launchEvaluation, Number(option('eval-seconds', '21600')) * 1000);
    await new Promise((resolveDone) => {
      const check = setInterval(() => {
        if (stopping && children.size === 0) {
          clearInterval(check);
          resolveDone();
        }
      }, 500);
    });
    log({ kind: 'stopped', run: p.root });
  } finally {
    clearInterval(timer);
    clearInterval(evalTimer);
    unlock();
  }
}
