/** One bounded registered evaluation. No training, restart or model selection. */
import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, option, sha256 } from '../../danMCai/training/continuous/lib.mjs';

export async function evaluateRegistered(run) {
  const task = readJSON(join(run, 'campaign-task.json'));
  const protocol = join(run, 'protocol.json'),
    plan = readJSON(protocol);
  if (!task || sha256(protocol) !== task.protocolSHA256)
    throw Error('Unregistered or changed protocol');
  const stop = () =>
    existsSync(join(run, 'STOP')) || Date.now() >= Date.parse(plan.evaluationDeadlineUTC);
  if (stop()) return { phase: 'stopped-before-spawn', completedRounds: 0 };
  const lock = join(run, 'evaluation-controller.lock');
  const lockFd = openSync(lock, 'wx');
  closeSync(lockFd);
  const children = [];
  const state = {
    pid: process.pid,
    phase: 'evaluation',
    updatedAt: new Date().toISOString(),
    displayName: plan.displayName || '冠军微调最终模型 · 10000局独立留出',
    completedRounds: 0,
    plannedRounds: plan.plannedRounds,
    optimizerUpdates: 0,
    strengthGames: 0,
    workers: [],
  };
  const tick = () => {
    state.workers = Array.from({ length: plan.workers }, (_, slot) =>
      readJSON(join(run, `worker-${slot}.json`)),
    ).filter(Boolean);
    state.completedRounds = state.workers.reduce(
      (n, w) => n + (w.completedRounds ?? w.completedPairs * 2),
      0,
    );
    state.strengthGames = ['decision-trace', 'deviation-pairs'].includes(plan.evaluationKind)
      ? 0
      : state.completedRounds;
    state.updatedAt = new Date().toISOString();
    if (stop() && !existsSync(join(run, 'STOP')))
      writeJSON(join(run, 'STOP'), { reason: 'fixed-evaluation-deadline', atUTC: state.updatedAt });
    writeJSON(join(run, 'status.json'), state);
  };
  const launch = (exe, args, log) => {
    const fd = openSync(join(run, log), 'a');
    const child = spawn(exe, args, {
      cwd: plan.evaluationSource,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, OMP_NUM_THREADS: '1' },
    });
    closeSync(fd);
    children.push(child);
    return new Promise((done, fail) => {
      child.once('error', fail);
      child.once('exit', (code) => (code === 0 ? done() : fail(Error(`Worker exited ${code}`))));
    });
  };
  let timer;
  try {
    tick();
    timer = setInterval(tick, 3000);
    const settled = await Promise.allSettled(
      Array.from({ length: plan.workers }, (_, slot) =>
        launch(
          process.execPath,
          [
            join(
              plan.evaluationSource,
              plan.evaluationKind === 'decision-trace'
                ? 'ai/danMCai/evaluation/evaluate-decision-trace.mjs'
                : plan.evaluationKind === 'deviation-pairs'
                  ? 'ai/danMCai/evaluation/evaluate-deviation-pairs.mjs'
                  : 'ai/danMCai/evaluation/evaluate-round-pairs.mjs',
            ),
            `--protocol=${protocol}`,
            `--run=${run}`,
            `--shard=${slot}`,
            `--shards=${plan.workers}`,
          ],
          `evaluation-${slot}.log`,
        ).catch((e) => {
          if (!existsSync(join(run, 'STOP')))
            writeJSON(join(run, 'STOP'), { reason: 'worker-failed' });
          throw e;
        }),
      ),
    );
    tick();
    if (
      state.workers.length !== plan.workers ||
      settled.some((x) => x.status === 'rejected') ||
      state.workers.some((w) => w.phase !== 'complete')
    )
      throw Error('Incomplete evaluation; preserve partial evidence');
    await launch(
      plan.python,
      [
        join(
          plan.evaluationSource,
          plan.evaluationKind === 'decision-trace'
            ? 'ai/research/tools/summarize-decision-trace.py'
            : plan.evaluationKind === 'deviation-pairs'
              ? 'ai/research/tools/summarize-deviation-pairs.py'
              : 'ai/danMCai/evaluation/summarize-round-pairs.py',
        ),
        '--protocol',
        protocol,
        '--results',
        run,
        '--output',
        join(run, 'summary.json'),
      ],
      'summary.log',
    );
    state.phase = 'complete';
  } catch (e) {
    state.phase = 'needs-attention';
    state.failure = e.stack;
    throw e;
  } finally {
    clearInterval(timer);
    state.stoppedAt = new Date().toISOString();
    tick();
    unlinkSync(lock);
  }
  return state;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url))
  await evaluateRegistered(resolve(option('run', '')));
