/** One owner-authorized 24h Mac continuation. Preparation never starts training. */
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statfsSync,
  writeFileSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { totalmem } from 'node:os';
import { join, resolve, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { option, readJSON, writeJSON, sha256, ensureDirs, runPaths } from './lib.mjs';
import { sourceHashes } from './sources.mjs';
import { REPO_ROOT } from './remote.mjs';

export const MAC_SEEDS = { actorSeedOffset: 3_000_000, evaluationBlockOffset: 300 };
export function remainingHours(schedule, now = Date.now()) {
  const end = Date.parse(schedule.deadlineUTC),
    start = Date.parse(schedule.startUTC);
  if (!Number.isFinite(end) || end - start !== 86400000) throw Error('Invalid 24h schedule');
  return Math.max(0, (end - now) / 3_600_000);
}

export function claimMacLock(run) {
  const file = join(run, 'mac-launch.lock');
  const previous = readJSON(file);
  if (previous) {
    try {
      process.kill(previous.pid, 0);
      throw Error('Mac launcher is already running');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    unlinkSync(file);
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  return () => {
    if (readJSON(file)?.pid === process.pid) unlinkSync(file);
  };
}

export function prepareMac(snapshot, run, actors = 2) {
  if (!Number.isInteger(actors) || actors < 1 || actors > 2) throw Error('Use 1 or 2 Mac samplers');
  if (existsSync(run)) throw Error('Destination must be new; never overwrite a run');
  const source = join(snapshot, 'windows-gpu-main');
  const manifest = readJSON(join(snapshot, 'manifest.json'));
  const config = readJSON(join(source, 'config.json'));
  const oldStatus = readJSON(join(source, 'status.json'));
  if (!manifest || !config || !oldStatus?.stoppedAt)
    throw Error('Verified stopped snapshot required');
  for (const name of readdirSync(join(source, 'actors')).filter((n) => /^actor-\d+\.json$/.test(n)))
    if (readJSON(join(source, 'actors', name)).nextSeed >= MAC_SEEDS.actorSeedOffset)
      throw Error('Mac training seed reservation conflicts with source run');
  const gateIndices = [oldStatus.gateIndex || 0, oldStatus.anchorIndex || 0];
  if (Math.max(...gateIndices) >= MAC_SEEDS.evaluationBlockOffset)
    throw Error('Mac evaluation seed reservation conflicts with source run');
  const paths = runPaths(run);
  mkdirSync(dirname(paths.root), { recursive: true });
  mkdirSync(paths.root);
  ensureDirs(paths);
  for (const name of ['models', 'champion', 'league', 'shards'])
    cpSync(join(source, name), paths[name], { recursive: true, preserveTimestamps: true });
  cpSync(join(source, 'learner/checkpoint.pt'), join(paths.learner, 'checkpoint.pt'));
  config.initial = 'ai/danMCai/models/baseline/policy.onnx';
  if (sha256(join(REPO_ROOT, config.initial)) !== sha256(join(paths.models, 'anchor.onnx')))
    throw Error('Imported P0 anchor differs from repository baseline');
  Object.assign(config, MAC_SEEDS, {
    actors,
    actorImplementation: 'fast',
    fastActor: { games: 8, provider: 'cpu' },
    resourceBudget: { reserveGB: 4, resumeGB: 5 },
    createdAt: new Date().toISOString(),
    sourceSHA256: sourceHashes(),
    sourceHashConvention: 'UTF-8 text with CRLF normalized to LF',
    protocolHistory: [],
    parent: {
      kind: 'windows-to-mac-continuation',
      latest: manifest.latest,
      champion: manifest.champion,
      checkpointSHA256: sha256(join(paths.learner, 'checkpoint.pt')),
      sourceConfigSHA256: sha256(join(source, 'config.json')),
      snapshotManifestSHA256: sha256(join(snapshot, 'manifest.json')),
    },
  });
  Object.assign(config.learner, { device: 'mps', threads: 1, seed: 20261105 });
  writeJSON(paths.config, config);
  // Preserve old shard names/countedShards, but never overwrite them with a new actor's sequence 0.
  for (let slot = 0; slot < actors; slot++) {
    const prefix = `a${String(slot).padStart(2, '0')}-`;
    const sequences = readdirSync(paths.shards)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
      .map((n) => Number(n.slice(prefix.length, -5)));
    const old = readJSON(join(source, `actors/actor-${slot}.json`), {});
    writeJSON(join(paths.actors, `actor-${slot}.json`), {
      slot,
      nextSeed: MAC_SEEDS.actorSeedOffset,
      shardSequence: Math.max(old.shardSequence || 0, ...sequences.map((n) => n + 1)),
    });
  }
  writeJSON(paths.status, {
    elapsedSeconds: 0,
    gates: [],
    anchorChecks: [],
    gateIndex: MAC_SEEDS.evaluationBlockOffset,
    anchorIndex: MAC_SEEDS.evaluationBlockOffset,
    lastAnchorAt: Date.now(),
    lastSnapshotAt: Date.now(),
  });
  writeJSON(join(paths.root, 'migration.json'), config.parent);
  return paths;
}

async function main() {
  const snapshot = resolve(REPO_ROOT, option('snapshot', 'ai/danMCai/workspace/mac-import'));
  const run = resolve(REPO_ROOT, option('run', 'ai/danMCai/runs/mac-20261105'));
  const python = resolve(REPO_ROOT, option('python', 'ai/danMCai/environment/mac/bin/python'));
  const root = resolve(REPO_ROOT, 'ai/danMCai/runs');
  if (!run.startsWith(root + '/') && !run.startsWith(root + '\\'))
    throw Error('Use an ignored ai/danMCai/runs subdirectory');
  const env = { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: '0', OMP_NUM_THREADS: '1' };
  const call = (file, args) => {
    const result = spawnSync(python, [join(REPO_ROOT, file), ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`${file} failed; training was not started`);
  };
  if (!existsSync(run)) {
    call('ai/danMCai/training/continuous/transfer.py', ['verify', '--snapshot', snapshot]);
    prepareMac(snapshot, run, Number(option('actors', '2')));
  } else if (!existsSync(join(run, 'migration.json'))) throw Error('Not a Mac continuation run');
  if (process.argv.includes('--prepare-only')) {
    console.log(`Prepared ${relative(REPO_ROOT, run)}; not started`);
    return;
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('Native Apple silicon macOS is required');
  if (totalmem() < 16 * 1024 ** 3)
    throw Error('This full-buffer preset requires at least 16 GiB unified memory');
  const disk = statfsSync(run);
  if (disk.bavail * disk.bsize < 8 * 1024 ** 3) throw Error('Keep at least 8 GiB disk space free');
  const scheduleFile = join(run, 'schedule.json');
  let schedule = readJSON(scheduleFile);
  if (schedule && remainingHours(schedule) <= 0)
    throw Error('The authorized 24h window has ended; not restarting');
  const unlock = claimMacLock(run);
  try {
    call('ai/danMCai/training/continuous/mac_preflight.py', [
      '--run',
      run,
      '--output',
      join(run, 'mac-preflight.json'),
    ]);
    if (!schedule) {
      const now = Date.now();
      schedule = {
        startUTC: new Date(now).toISOString(),
        deadlineUTC: new Date(now + 86400000).toISOString(),
        durationHours: 24,
        restartExtendsDeadline: false,
      };
      writeJSON(scheduleFile, schedule);
    }
    const hours = remainingHours(schedule);
    if (hours <= 0) throw Error('The authorized 24h window has ended');
    console.log(
      JSON.stringify({ run, ...schedule, remainingHours: hours, learner: 'mps', samplers: 'cpu' }),
    );
    // caffeinate keeps idle sleep from stopping the work; closing the lid can still sleep a laptop.
    const child = spawn(
      'caffeinate',
      [
        '-i',
        process.execPath,
        join(REPO_ROOT, 'ai/danMCai/training/continuous/supervisor.mjs'),
        `--run=${run}`,
        `--python=${python}`,
        `--hours=${hours}`,
        ...(option('protocol-change', '')
          ? [`--protocol-change=${option('protocol-change', '')}`]
          : []),
      ],
      { cwd: REPO_ROOT, env, stdio: 'inherit' },
    );
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.on(signal, () => {
        writeJSON(join(run, 'STOP'), { reason: signal, at: new Date().toISOString() });
      });
    const deadlineTimer = setTimeout(
      () => {
        writeJSON(join(run, 'STOP'), {
          reason: 'authorized-time-limit',
          deadlineUTC: schedule.deadlineUTC,
          at: new Date().toISOString(),
        });
      },
      Math.max(0, Date.parse(schedule.deadlineUTC) - Date.now()),
    );
    try {
      await new Promise((resolveChild, rejectChild) => {
        child.on('error', rejectChild);
        child.on('exit', (code) => {
          process.exitCode = code ?? 1;
          resolveChild();
        });
      });
    } finally {
      clearTimeout(deadlineTimer);
    }
  } finally {
    unlock();
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
