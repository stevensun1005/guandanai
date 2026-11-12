/**
 * Endgame oracle-guiding run supervisor for a shared everyday Mac.
 *
 * First start freezes config.json (champion file + SHA, seeds, threshold, schedule, fixed deadline,
 * source SHAs). Restarts reuse the frozen config and only the time left before the original
 * deadline. Actors run at low CPU priority; STOP in the run directory stops everything cleanly.
 *
 *   node ai/danMCai/endgame/run.mjs --run=<dir> [--hours=8] [--actors=3] [--python=<venv python>]
 *
 * Continuing from an earlier run's learner checkpoint (a new run, never an extension of the old
 * one): the protocol names it under learner.init.sha256 and the operator passes its local path
 * with --init-checkpoint=<checkpoint.pt>. The file is SHA-checked and copied to learner/init.pt.
 * On Windows pass --python=<venv>\Scripts\python.exe; priorities use os.setPriority there.
 */
import { existsSync, mkdirSync, copyFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, sha256 } from '../training/continuous/lib.mjs';
import { isMain, spawnNice } from './platform.mjs';
import { memoryAction, memoryAvailability } from '../training/continuous/resources.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
let ownedLock;

export const SOURCES = [
  'ai/danMCai/endgame/actor.mjs',
  'ai/danMCai/endgame/pimc-actor.mjs',
  'ai/danMCai/endgame/solver.mjs',
  'ai/shared/search/belief.mjs',
  'ai/shared/search/pimc.mjs',
  'ai/danMCai/endgame/learner.py',
  'ai/danMCai/endgame/run.mjs',
  'ai/danMCai/endgame/platform.mjs',
  'ai/danMCai/endgame/rebase.py',
  'ai/danMCai/training/continuous/resources.mjs',
  'ai/danMCai/training/continuous/lib.mjs',
  'ai/danMCai/training/continuous/value_net.py',
  'ai/shared/simulation/simulation.mjs',
  'web/src/ai/candidates.js',
  'web/src/ai/encoding.mjs',
  'web/src/ai/observation.js',
  'web/src/core/combinations.js',
  'web/src/core/cards.js',
];

export function defaultConfig({ hours, actors, champion, seedBase, now = new Date() }) {
  const deadline = new Date(now.getTime() + hours * 3600_000).toISOString();
  const span = 1_000_000;
  return {
    schema: 'danmcai-endgame-oracle-v1',
    createdAt: now.toISOString(),
    deadline,
    hours,
    champion,
    actor: {
      count: actors,
      threshold: 32,
      temperature: 0.02,
      shardRows: 4096,
      slotSeeds: Array.from({ length: actors }, (_, i) => [
        seedBase + i * span,
        seedBase + (i + 1) * span,
      ]),
    },
    priority: { learnerNice: 0, actorNice: 5 },
    learner: {
      device: 'mps',
      threads: 2,
      seed: 20261107,
      learningRate: 1e-5,
      batch: 2048,
      capacity: 1_500_000,
      minSamples: 100_000,
      replayRatio: 4,
      oracleDecaySteps: 60_000,
      keepShardRows: 2_000_000,
      exportSeconds: 600,
    },
    sources: Object.fromEntries(SOURCES.map((file) => [file, sha256(join(root, file))])),
  };
}

/**
 * Freeze an inherited learner checkpoint into the new run. The protocol fixes the expected SHA, so
 * a checkpoint can only be used when it was preregistered; the local path comes from the operator.
 */
export function freezeInit(config, run, checkpoint) {
  const expected = config.learner.init?.sha256;
  if (!expected && !checkpoint) return;
  if (!expected) throw Error('--init-checkpoint needs learner.init.sha256 in the protocol');
  if (!checkpoint)
    throw Error('Protocol sets learner.init; pass --init-checkpoint=<checkpoint.pt>');
  const source = resolve(checkpoint);
  if (sha256(source) !== expected) throw Error('Init checkpoint SHA mismatch; refusing to start');
  mkdirSync(join(run, 'learner'), { recursive: true });
  copyFileSync(source, join(run, 'learner', 'init.pt'));
  config.learner.init = { ...config.learner.init, source, file: 'learner/init.pt' };
}

async function main() {
  const run = resolve(option('run', ''));
  if (!option('run')) throw Error('Missing --run');
  mkdirSync(join(run, 'models'), { recursive: true });
  const lock = join(run, 'supervisor.lock');
  closeSync(openSync(lock, 'wx'));
  ownedLock = lock;
  writeJSON(lock, { pid: process.pid });
  let config = readJSON(join(run, 'config.json'));
  if (!config) {
    const file = resolve(option('champion', join(root, 'web/dist/models/bot-017.onnx')));
    const expected = option(
      'champion-sha',
      '462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7',
    );
    if (sha256(file) !== expected) throw Error('Champion SHA mismatch; refusing to start');
    const frozen = join(run, 'models', 'champion.onnx');
    copyFileSync(file, frozen);
    // A published protocol JSON fixes hours, actors, seed blocks and learner settings verbatim.
    const protocolFile = option('protocol');
    const protocol = protocolFile ? readJSON(resolve(protocolFile)) : {};
    const run_ = protocol.run || {};
    config = defaultConfig({
      hours: Number(run_.hours ?? option('hours', 8)),
      actors: Number(run_.actors ?? option('actors', 3)),
      champion: { id: '017', version: 'v000855042', sha256: expected, file: frozen },
      seedBase: Number(option('seed-base', 0)),
    });
    if (protocolFile) {
      config.protocol = { file: resolve(protocolFile), sha256: sha256(resolve(protocolFile)) };
      // An amendment may pin the original fixed deadline instead of starting a fresh window.
      if (run_.deadline) {
        config.deadline = new Date(run_.deadline).toISOString();
        config.hours = (Date.parse(config.deadline) - Date.parse(config.createdAt)) / 3600_000;
      }
      config.purpose = protocol.purpose;
      if (protocol.schema) config.schema = protocol.schema;
      Object.assign(config.actor, protocol.actor || {});
      Object.assign(config.learner, protocol.learner || {});
      config.priority = protocol.priority || config.priority;
      if (protocol.teacher) {
        if (protocol.teacher.sha256 !== expected) throw Error('Protocol teacher SHA mismatch');
        config.champion.id = protocol.teacher.id;
        config.champion.version = protocol.teacher.version;
      }
      if (protocol.resources) config.resources = protocol.resources;
    } else if (!option('seed-base')) throw Error('Missing --seed-base or --protocol');
    if (!['actor.mjs', 'pimc-actor.mjs'].includes(config.actor.script || 'actor.mjs'))
      throw Error(`Unknown actor script ${config.actor.script}`);
    if (config.actor.slotSeeds.length !== config.actor.count)
      throw Error('Seed blocks must match the actor count');
    freezeInit(config, run, option('init-checkpoint'));
    writeJSON(join(run, 'config.json'), config);
  }
  for (const [file, digest] of Object.entries(config.sources))
    if (sha256(join(root, file)) !== digest)
      throw Error(`Frozen source changed: ${file}; use a frozen checkout for this run`);
  const python = option(
    'python',
    process.env.DANMCAI_PYTHON || join(root, 'ai/danMCai/environment/mac/bin/python'),
  );
  if (!existsSync(python)) throw Error(`Python not found: ${python}; pass --python=<venv python>`);
  const deadline = Date.parse(config.deadline);
  if (Date.now() >= deadline) throw Error('Fixed deadline already passed; not extending');
  const children = new Map();
  const pausedActors = new Set();
  let lastMemoryActionAt = 0;
  const restarts = {};
  const status = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    deadline: config.deadline,
    restarts,
  };
  function start(name, nice, command, args) {
    const child = spawnNice(nice, command, args, {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    children.set(name, child);
    child.on('exit', (code) => {
      children.delete(name);
      // A clean exit means the child finished its own work (seeds used up or STOP/deadline seen).
      if (stopping || code === 0 || pausedActors.has(name)) return;
      restarts[name] = (restarts[name] || 0) + 1;
      if (restarts[name] > 5) {
        console.error(`${name} failed repeatedly (${code}); stopping run`);
        stop('child-failure');
      } else setTimeout(() => !stopping && start(name, nice, command, args), 5000);
    });
  }
  let stopping = false;
  function stop(reason) {
    if (stopping) return;
    stopping = true;
    status.stopReason = reason;
    if (!existsSync(join(run, 'STOP')))
      writeJSON(join(run, 'STOP'), { reason, at: new Date().toISOString() });
  }
  // Learner first: it publishes the initial student (an exact champion copy) before actors read it.
  const { learnerNice = 0, actorNice = 5 } = config.priority || {};
  while (
    config.resources &&
    memoryAvailability().availableBytes < config.resources.resumeGiB * 2 ** 30
  ) {
    if (existsSync(join(run, 'STOP')) || Date.now() >= deadline) return;
    writeJSON(join(run, 'status.json'), {
      ...status,
      state: 'waiting-for-memory',
      updatedAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 1000));
  }
  const resuming = existsSync(join(run, 'learner/checkpoint.pt'));
  start('learner', learnerNice, python, [join(here, 'learner.py'), `--run=${run}`]);
  while (!existsSync(join(run, 'models', 'latest.json'))) {
    if (existsSync(join(run, 'STOP')) || Date.now() >= deadline) stop('initialization-stopped');
    if (stopping) throw Error(`Learner did not publish the initial student: ${status.stopReason}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  if (
    !resuming &&
    config.learner.init?.expectedStudentSHA256 &&
    readJSON(join(run, 'models/latest.json')).sha256 !== config.learner.init.expectedStudentSHA256
  ) {
    stop('initial-student-SHA-mismatch');
    throw Error('Initial student differs from preregistered transfer');
  }
  const startActor = (slot) =>
    start(`actor-${slot}`, actorNice, process.execPath, [
      join(here, config.actor.script || 'actor.mjs'),
      `--run=${run}`,
      `--slot=${slot}`,
    ]);
  for (let slot = 0; slot < config.actor.count; slot++) startActor(slot);
  process.on('SIGINT', () => stop('operator-interrupt'));
  process.on('SIGTERM', () => stop('operator-terminate'));
  while (children.size) {
    if (existsSync(join(run, 'STOP'))) stop('stop-file');
    if (Date.now() >= deadline) stop('fixed-deadline');
    if (!stopping && config.resources) {
      const available = memoryAvailability().availableBytes;
      const action = memoryAction({
        freeBytes: available,
        reserveGB: config.resources.reserveGiB,
        resumeGB: config.resources.resumeGiB,
        running: [...children.keys()].filter((n) => n.startsWith('actor-')),
        paused: [...pausedActors],
        lastActionAt: lastMemoryActionAt,
      });
      if (action) {
        lastMemoryActionAt = Date.now();
        if (action.type === 'pause') {
          pausedActors.add(action.actor);
          children.get(action.actor)?.kill();
        } else {
          pausedActors.delete(action.actor);
          startActor(Number(action.actor.slice(6)));
        }
      }
      status.resources = { availableGiB: available / 2 ** 30, pausedActors: [...pausedActors] };
    }
    status.children = [...children].map(([name, child]) => ({ name, pid: child.pid }));
    status.updatedAt = new Date().toISOString();
    writeJSON(join(run, 'status.json'), status);
    await new Promise((r) => setTimeout(r, 3000));
  }
  // Children watch STOP and the deadline themselves and may exit before this loop notices.
  if (!status.stopReason)
    status.stopReason =
      Date.now() >= deadline
        ? 'fixed-deadline'
        : existsSync(join(run, 'STOP'))
          ? 'stop-file'
          : 'children-finished';
  status.endedAt = new Date().toISOString();
  status.children = [];
  writeJSON(join(run, 'status.json'), status);
}

if (isMain(import.meta.url)) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      if (ownedLock) unlinkSync(ownedLock);
    });
}
