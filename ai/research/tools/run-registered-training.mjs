/** Launch one preregistered, fixed-window training task. Never changes its frozen protocol. */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, realpathSync, statfsSync, unlinkSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { option, readJSON, sha256, writeJSON } from '../../danMCai/training/continuous/lib.mjs';

export async function trainRegistered(run) {
  const task = readJSON(join(run, 'campaign-task.json'));
  const protocol = join(run, 'protocol.json'),
    plan = readJSON(protocol);
  if (!task || sha256(protocol) !== task.protocolSHA256)
    throw Error('Unregistered training protocol');
  const stopped = () =>
    existsSync(join(run, 'STOP')) || Date.now() >= Date.parse(task.window.deadlineUTC);
  if (stopped()) return { phase: 'stopped-before-spawn', optimizerUpdates: 0 };
  if (
    task.window.requestedHours !== 4 ||
    plan.actorMix?.self !== 0 ||
    plan.actorMix?.league !== 1 ||
    plan.actorMix?.rule !== 0
  )
    throw Error('Expected preregistered four-hour champion-only exploiter');
  for (const [file, hash] of Object.entries(plan.sourceSHA256))
    if (sha256(join(plan.sourceRoot, file)) !== hash)
      throw Error('Frozen training source changed: ' + file);
  const configFile = join(run, 'initial-config.json'),
    config = readJSON(configFile);
  if (sha256(configFile) !== plan.configSHA256 || sha256(config.initial) !== plan.teacherSHA256)
    throw Error('Initial training configuration or teacher changed');
  if (
    config.snapshotMinutes <= 240 ||
    config.learner.targetMatchWeight !== 0 ||
    config.learner.anchorWeight !== 0
  )
    throw Error('Do not change frozen opponent pool or single-round target');
  if (freemem() < 5 * 1024 ** 3) throw Error('Wait for five GiB available RAM before launch');
  const disk = statfsSync(run);
  if (disk.bavail * disk.bsize < 8 * 1024 ** 3) throw Error('Insufficient free disk');
  const lock = join(run, 'registered-training.lock');
  closeSync(openSync(lock, 'wx'));
  let timer;
  try {
    if (!existsSync(join(run, 'config.json'))) {
      if (existsSync(join(run, 'status.json')) || existsSync(join(run, 'learner/checkpoint.pt')))
        throw Error('Unexpected prior state in fresh training directory');
      // The supervisor's legacy zero default would snapshot as soon as the first export appears.
      // Set the actual fixed-window origin before first spawn; never reset it on a restart.
      writeJSON(join(run, 'status.json'), {
        phase: 'training',
        displayName: 'danMCai · 017固定对手剥削臂',
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        lastSnapshotAt: Date.parse(task.window.startUTC),
        lastAnchorAt: Date.parse(task.window.startUTC),
        optimizerUpdates: 0,
      });
    }
    const remainingHours = (Date.parse(task.window.deadlineUTC) - Date.now()) / 3600000;
    if (!(remainingHours > 0) || stopped()) throw Error('Training window expired before spawn');
    const fd = openSync(join(run, 'supervisor.log'), 'a');
    const child = spawn(
      process.execPath,
      [
        join(plan.sourceRoot, 'ai/danMCai/training/continuous/supervisor.mjs'),
        `--run=${run}`,
        `--python=${plan.python}`,
        `--hours=${remainingHours}`,
        `--config=${JSON.stringify(config)}`,
      ],
      {
        cwd: plan.sourceRoot,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, OMP_NUM_THREADS: '1' },
      },
    );
    closeSync(fd);
    writeJSON(join(run, 'registered-launch.json'), {
      pid: process.pid,
      supervisorPID: child.pid,
      remainingHours,
      task,
      sourceRoot: plan.sourceRoot,
      startedAtUTC: new Date().toISOString(),
    });
    const stop = (reason) =>
      writeJSON(join(run, 'STOP'), { reason, atUTC: new Date().toISOString() });
    timer = setInterval(() => {
      if (stopped()) {
        if (!existsSync(join(run, 'STOP'))) stop('fixed-training-deadline');
        return;
      }
      const league = readJSON(join(run, 'league/league.json'));
      if (
        league &&
        (league.members.length !== 1 || league.members[0].sha256 !== plan.teacherSHA256)
      )
        stop('frozen-opponent-pool-changed');
    }, 1000);
    const code = await new Promise((ok, fail) => {
      child.once('error', fail);
      child.once('exit', ok);
    });
    if (!existsSync(join(run, 'STOP'))) stop('training-supervisor-exited');
    if (code !== 0) throw Error('Training supervisor exited ' + code);
    return { phase: 'stopped', supervisorPID: child.pid };
  } finally {
    clearInterval(timer);
    unlinkSync(lock);
  }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url))
  await trainRegistered(resolve(option('run', '')));
