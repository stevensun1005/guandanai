/** Bounded independent whole-match baseline; no training or promotion. */
import * as ort from 'onnxruntime-node';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  openSync,
  closeSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freemem } from 'node:os';
import { spawn } from 'node:child_process';
import { playMatch } from '../../shared/simulation/match-rollout.mjs';
import { createTableInference } from '../../shared/simulation/table-inference.mjs';
import { createRuleOpponent } from '../../shared/simulation/rule-baseline.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import {
  createModelPool,
  argmax,
  readJSON,
  writeJSON,
  sha256,
  option,
} from '../../danMCai/training/continuous/lib.mjs';

export function matchSeats(task, team, seed) {
  const focal = team + (seed % 2) * 2;
  return [0, 1, 2, 3].map((p) =>
    p % 2 !== team ? task.opponent : task.mixed && p !== focal ? 'clint' : 'champion',
  );
}

export async function runWorker(run, slot) {
  const plan = readJSON(join(run, 'protocol.json')),
    task = readJSON(join(run, 'campaign-task.json'));
  const protocolSHA256 = sha256(join(run, 'protocol.json'));
  const root = plan.sourceRoot;
  const stopped = () =>
    existsSync(join(run, 'STOP')) ||
    existsSync(join(run, '../../STOP')) ||
    Date.now() >= Math.min(Date.parse(plan.deadlineUTC), Date.parse(task.window.deadlineUTC));
  if (stopped()) return;
  if (protocolSHA256 !== task.protocolSHA256) throw Error('Protocol changed');
  for (const [path, hash] of Object.entries(plan.sourceFiles))
    if (sha256(join(root, path)) !== hash) throw Error('Frozen source changed: ' + path);
  for (const model of Object.values(plan.models))
    if (sha256(model.file) !== model.sha256) throw Error('Frozen model changed');
  const lock = join(run, `worker-${slot}.lock`),
    fd = openSync(lock, 'wx');
  closeSync(fd);
  const file = join(run, `worker-${slot}.jsonl`);
  if (existsSync(file)) {
    unlinkSync(lock);
    throw Error('Existing worker output: no repeated matches');
  }
  const jobs = plan.tasks
    .flatMap((t) => t.seeds.map((seed) => ({ task: t, seed })))
    .filter((_, i) => i % plan.workers === slot);
  const state = {
    pid: process.pid,
    phase: 'evaluation',
    completedMatches: 0,
    completedPairs: 0,
    plannedPairs: jobs.length,
    updatedAt: new Date().toISOString(),
    minimumAvailableGiB: freemem() / 1024 ** 3,
  };
  const save = () => {
    state.updatedAt = new Date().toISOString();
    writeJSON(join(run, `worker-${slot}.json`), state);
  };
  let last = 0,
    paused = false;
  const checkpoint = async () => {
    if (stopped()) throw Error('STOP or fixed deadline');
    let memory = freemem() / 1024 ** 3;
    state.minimumAvailableGiB = Math.min(state.minimumAvailableGiB, memory);
    while (memory < (paused ? 5 : 4)) {
      paused = true;
      state.phase = 'waiting-for-memory';
      save();
      await new Promise((r) => setTimeout(r, 1000));
      if (stopped()) throw Error('STOP or fixed deadline');
      memory = freemem() / 1024 ** 3;
    }
    paused = false;
    state.phase = 'evaluation';
    if (Date.now() - last > 3000) {
      save();
      last = Date.now();
    }
  };
  const pool = await createModelPool(ort, { threads: 1, limit: 3, provider: 'cpu' });
  const web = createTableInference({
    policy: plan.models.champion.file,
    config: plan.models.champion.config,
    runtime: ort,
  });
  try {
    paused = true;
    await checkpoint();
    for (const { task: t, seed } of jobs) {
      const games = [];
      for (const team of t.self ? [0] : [0, 1]) {
        const seats = matchSeats(t, team, seed),
          rules = new WeakMap();
        const result = await playMatch({
          seed,
          team,
          mode: 'self',
          evaluate: true,
          checkpoint,
          tablePolicy: async (game, p) => {
            const id = seats[p];
            if (id === 'clint') {
              if (!rules.has(game))
                rules.set(
                  game,
                  createRuleOpponent((Math.imul(seed, 1009) + game.match.round - 1) ^ 0x6a09e667),
                );
              return rules.get(game)(game, p);
            }
            if (t.arm === 'web' && id === 'champion') return web.decide(game, p, 'balanced');
            const plays = candidates(game.hands[p], game.L, game.trick?.play);
            if (plays.length === 1) return plays[0];
            const values = await pool.values(
              plan.models[id].file,
              policyState(game, p, 0, plays),
              plan.models[id].config,
            );
            return plays[argmax(Array.from(values))];
          },
        });
        games.push(result);
        state.completedMatches++;
        save();
        writeJSON(join(run, `worker-${slot}-pending.json`), {
          task: t.id,
          seed,
          protocolSHA256,
          games,
        });
      }
      appendFileSync(file, JSON.stringify({ task: t.id, seed, protocolSHA256, games }) + '\n');
      state.completedPairs++;
      unlinkSync(join(run, `worker-${slot}-pending.json`));
      save();
    }
    state.phase = 'complete';
  } catch (error) {
    state.phase = stopped() ? 'stopped' : 'failed';
    state.error = error.stack;
    throw error;
  } finally {
    state.stoppedAt = new Date().toISOString();
    save();
    await pool.close();
    await web.close();
    unlinkSync(lock);
  }
}

export async function runController(run) {
  const plan = readJSON(join(run, 'protocol.json')),
    task = readJSON(join(run, 'campaign-task.json'));
  const stop = () =>
    existsSync(join(run, 'STOP')) ||
    existsSync(join(run, '../../STOP')) ||
    Date.now() >= Math.min(Date.parse(plan.deadlineUTC), Date.parse(task.window.deadlineUTC));
  if (stop()) return;
  if (existsSync(join(run, 'status.json')))
    throw Error('Existing attempt; refusing duplicate controller');
  if (sha256(join(run, 'protocol.json')) !== task.protocolSHA256)
    throw Error('Registered protocol changed');
  const lock = join(run, 'evaluation-controller.lock'),
    fd = openSync(lock, 'wx');
  closeSync(fd);
  const state = {
    pid: process.pid,
    phase: 'evaluation',
    displayName: plan.displayName,
    completedMatches: 0,
    plannedMatches: plan.plannedMatches,
    optimizerUpdates: 0,
    workers: [],
  };
  const tick = () => {
    state.workers = Array.from({ length: plan.workers }, (_, i) =>
      readJSON(join(run, `worker-${i}.json`)),
    ).filter(Boolean);
    state.completedMatches = state.workers.reduce((n, w) => n + w.completedMatches, 0);
    state.strengthGames = state.completedMatches;
    state.updatedAt = new Date().toISOString();
    if (stop() && !existsSync(join(run, 'STOP')))
      writeJSON(join(run, 'STOP'), { reason: 'fixed-deadline' });
    writeJSON(join(run, 'status.json'), state);
  };
  const launch = (exe, args, name) =>
    new Promise((done, fail) => {
      const out = openSync(join(run, name), 'a');
      const child = spawn(exe, args, {
        cwd: plan.sourceRoot,
        windowsHide: true,
        stdio: ['ignore', out, out],
      });
      closeSync(out);
      child.once('error', fail);
      child.once('exit', (code) => (code === 0 ? done() : fail(Error(`Child exited ${code}`))));
    });
  const timer = setInterval(tick, 3000);
  try {
    tick();
    const settled = await Promise.allSettled(
      Array.from({ length: plan.workers }, (_, i) =>
        launch(
          process.execPath,
          [
            join(plan.sourceRoot, 'ai/research/tools/evaluate-match-017.mjs'),
            `--run=${run}`,
            `--slot=${i}`,
          ],
          `worker-${i}.log`,
        ).catch((error) => {
          if (!existsSync(join(run, 'STOP')))
            writeJSON(join(run, 'STOP'), { reason: 'worker-failed' });
          throw error;
        }),
      ),
    );
    tick();
    if (
      settled.some((x) => x.status === 'rejected') ||
      state.workers.length !== plan.workers ||
      state.workers.some((w) => w.phase !== 'complete')
    )
      throw Error('Incomplete fixed evaluation; retain partial data');
    await launch(
      plan.python,
      [join(plan.sourceRoot, 'ai/research/tools/summarize-match-017.py'), '--run', run],
      'summary.log',
    );
    state.phase = 'complete';
  } catch (error) {
    state.phase = 'needs-attention';
    state.failure = error.stack;
    throw error;
  } finally {
    clearInterval(timer);
    state.stoppedAt = new Date().toISOString();
    tick();
    unlinkSync(lock);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const run = resolve(option('run', '')),
    slot = option('slot', null);
  if (slot === null) await runController(run);
  else await runWorker(run, Number(slot));
}
