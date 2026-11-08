/** Fixed champion trajectory corpus and descriptive Q gaps; no fitting or deployment. */
import * as ort from 'onnxruntime-node';
import { appendFileSync, existsSync, openSync, closeSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freemem } from 'node:os';
import { playRound, lineup } from './evaluate-round-pairs.mjs';
import {
  createModelPool,
  readJSON,
  writeJSON,
  sha256,
  option,
} from '../training/continuous/lib.mjs';

export function compactTrajectory(result, seats) {
  const { trace, ...outcome } = result;
  return {
    ...outcome,
    seats,
    initial: {
      hands: trace.initial.hands.map((h) => h.map((c) => c.id)),
      level: trace.initial.L,
      leader: trace.initial.turn,
    },
    moves: trace.moves.map(({ estimates, ...move }) => ({
      ...move,
      model: seats[move.p],
      candidateCount: estimates?.length ?? (seats[move.p] === 'clint' ? null : 1),
      top5: estimates
        ? estimates
            .map((q, index) => ({ q, index }))
            .sort((a, b) => b.q - a.q || a.index - b.index)
            .slice(0, 5)
        : [],
    })),
  };
}

export async function runDecisionTrace({ protocol, run, shard = 0, shards = 4 }) {
  const plan = readJSON(protocol),
    registered = readJSON(join(run, 'campaign-task.json'));
  const stopped = () =>
    existsSync(join(run, 'STOP')) ||
    existsSync(join(run, '../../STOP')) ||
    Date.now() >=
      Math.min(Date.parse(plan.evaluationDeadlineUTC), Date.parse(registered.window.deadlineUTC));
  if (stopped()) return;
  const protocolSHA256 = sha256(protocol);
  if (
    protocolSHA256 !== registered.protocolSHA256 ||
    shards !== plan.workers ||
    !Number.isInteger(shard) ||
    shard < 0 ||
    shard >= shards
  )
    throw Error('Invalid registered trace worker');
  for (const [name, hash] of Object.entries(plan.sourceSHA256))
    if (sha256(join(plan.evaluationSource, name)) !== hash)
      throw Error('Frozen source changed: ' + name);
  for (const m of Object.values(plan.models))
    if (sha256(m.file) !== m.sha256) throw Error('Frozen model changed');
  const file = join(run, `worker-${shard}.jsonl`),
    lock = join(run, `trace-worker-${shard}.lock`);
  if (existsSync(file) || existsSync(join(run, `worker-${shard}.json`)))
    throw Error('Existing attempt; no overwrite or repeated trajectories');
  const fd = openSync(lock, 'wx');
  closeSync(fd);
  const state = {
    pid: process.pid,
    phase: 'running',
    completedPairs: 0,
    completedRounds: 0,
    plannedPairs: plan.tasks.reduce(
      (n, t) => n + Math.max(0, Math.ceil((t.seeds.length - shard) / shards)),
      0,
    ),
    gapPairs: 0,
    trajectoryPairs: 0,
    optimizerUpdates: 0,
    minimumAvailableGiB: freemem() / 1024 ** 3,
  };
  const save = () => {
    state.updatedAtUTC = new Date().toISOString();
    writeJSON(join(run, `worker-${shard}.json`), state);
  };
  let last = 0,
    paused = true;
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
    state.phase = 'running';
    if (Date.now() - last > 3000) {
      save();
      last = Date.now();
    }
  };
  const pool = await createModelPool(ort, { threads: 1, limit: 2, provider: 'cpu' });
  try {
    for (const stage of ['gap', 'trajectory']) {
      if (stage === 'trajectory') {
        while (!existsSync(join(run, 'gap-published.json'))) {
          await checkpoint();
          state.phase = 'awaiting-gap-publication';
          save();
          await new Promise((r) => setTimeout(r, 1000));
        }
        const published = readJSON(join(run, 'gap-published.json'));
        if (
          published.protocolSHA256 !== protocolSHA256 ||
          !/^[a-f0-9]{40}$/.test(published.mainCommit) ||
          published.gapSHA256 !== sha256(join(run, 'gap-summary.json'))
        )
          throw Error('Invalid gap publication marker');
      }
      for (const task of plan.tasks.filter((t) => t.stage === stage)) {
        state.currentTask = task.id;
        for (let i = shard; i < task.seeds.length; i += shards) {
          const seed = task.seeds[i],
            games = [];
          for (const team of [0, 1]) {
            await checkpoint();
            const seats = lineup(task, team, seed);
            const result = await playRound({
              seed,
              seats,
              capture: true,
              checkpoint,
              values: (id, s) => pool.values(plan.models[id].file, s, plan.models[id].config),
            });
            games.push({ team, ...compactTrajectory(result, seats) });
            writeJSON(join(run, `trace-${shard}-pending.json`), {
              stage,
              task: task.id,
              seed,
              protocolSHA256,
              games,
            });
            state.completedRounds++;
            save();
          }
          appendFileSync(
            file,
            JSON.stringify({ stage, task: task.id, seed, protocolSHA256, games }) + '\n',
          );
          unlinkSync(join(run, `trace-${shard}-pending.json`));
          state.completedPairs++;
          state[stage === 'gap' ? 'gapPairs' : 'trajectoryPairs']++;
          save();
        }
      }
    }
    state.phase = 'complete';
  } catch (error) {
    state.phase = stopped() ? 'stopped' : 'failed';
    state.error = error.stack;
    throw error;
  } finally {
    state.stoppedAtUTC = new Date().toISOString();
    save();
    await pool.close();
    unlinkSync(lock);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url))
  await runDecisionTrace({
    protocol: resolve(option('protocol', '')),
    run: resolve(option('run', '')),
    shard: Number(option('shard', '0')),
    shards: Number(option('shards', '4')),
  });
