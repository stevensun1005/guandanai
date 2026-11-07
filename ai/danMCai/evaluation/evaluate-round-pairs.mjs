/** Fixed held-out single-round comparisons. Never trains or changes a champion. */
import * as ort from 'onnxruntime-node';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, setPriority } from 'node:os';
import { createRound, advanceRound } from '../../shared/simulation/simulation.mjs';
import { createRuleOpponent } from '../../shared/simulation/rule-baseline.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { argmax, createModelPool, option, writeJSON } from '../training/continuous/lib.mjs';
import { memoryAvailability } from '../training/continuous/resources.mjs';
import { analysisState } from './cooperation-labels.mjs';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function lineup(task, team, seed) {
  if (![0, 1].includes(team)) throw Error('Invalid team');
  const focus = team + (seed % 2) * 2;
  return [0, 1, 2, 3].map((p) =>
    p % 2 !== team
      ? task.opponent
      : p !== focus
        ? task.teammate || (task.mixed ? 'clint' : task.model)
        : task.model,
  );
}

export async function playRound({ seed, seats, values, capture = false, modelConfigs = {} }) {
  const game = createRound(seed);
  const trace = capture ? { initial: structuredClone(game), moves: [] } : null;
  const initial = {
    level: game.L,
    leader: game.turn,
    dealSHA256: hash(JSON.stringify(game.hands.map((h) => h.map((c) => c.id)))),
  };
  const rule = createRuleOpponent(seed ^ 0x6a09e667);
  for (let turn = 0; turn < 1000; turn++) {
    const p = game.turn;
    let play,
      estimates = null;
    if (seats[p] === 'clint') play = rule(game, p);
    else {
      const plays = candidates(game.hands[p], game.L, game.trick?.play);
      if (!plays.length) throw Error('No legal actions');
      let index = 0;
      if (plays.length > 1) {
        // policyState exposes only the acting player's cards and public information.
        const config = modelConfigs[seats[p]] || {};
        const state =
          config.extraFeatures || config.history
            ? analysisState(game, p, plays)
            : policyState(game, p, 0, plays);
        const scores = await values(seats[p], state);
        if (scores.length !== plays.length || !Array.from(scores).every(Number.isFinite))
          throw Error('Invalid policy values');
        index = argmax(scores);
        if (capture) estimates = Array.from(scores);
      }
      play = plays[index];
    }
    if (capture)
      trace.moves.push({
        p,
        cards: play?.cards.map((c) => c.id) || null,
        ...(play ? { type: play.type, value: play.value, n: play.n } : {}),
        estimates,
      });
    const result = advanceRound(game, play);
    if (result) return { ...initial, ...result, turns: turn + 1, ...(capture ? { trace } : {}) };
  }
  throw Error('Round truncated; never count as a draw');
}

export async function runRoundPairs({ protocol, run, shard = 0, shards = 4 }) {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const bytes = readFileSync(protocol),
    plan = JSON.parse(bytes),
    protocolSHA256 = hash(bytes);
  if (
    !Number.isFinite(Date.parse(plan.evaluationDeadlineUTC)) ||
    Object.values(plan.models).some(
      (m) => typeof m.file !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256),
    )
  )
    throw Error('Freeze all evaluation weights and a bounded evaluation deadline before starting');
  if (!Number.isInteger(shard) || shard < 0 || shard >= shards || shards !== plan.workers)
    throw Error('Invalid worker');
  for (const [name, sha] of Object.entries(plan.sourceSHA256))
    if (hash(readFileSync(join(root, name))) !== sha) throw Error('Frozen source changed: ' + name);
  const files = {};
  for (const [id, model] of Object.entries(plan.models)) {
    files[id] = resolve(dirname(protocol), model.file);
    if (hash(readFileSync(files[id])) !== model.sha256) throw Error('Frozen model changed: ' + id);
  }
  if (existsSync(join(run, `worker-${shard}.jsonl`))) throw Error('Output already exists');
  mkdirSync(run, { recursive: true });
  setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
  const pool = await createModelPool(ort, { threads: 1 });
  const output = join(run, `worker-${shard}.jsonl`);
  let count = 0,
    currentTask = null,
    phase = 'running',
    failure = null;
  const status = () =>
    writeJSON(join(run, `worker-${shard}.json`), {
      shard,
      pid: process.pid,
      phase,
      failure,
      currentTask,
      completedPairs: count,
      protocolSHA256,
      updatedAtUTC: new Date().toISOString(),
      rssBytes: process.memoryUsage().rss,
    });
  const stop = () =>
    Date.now() >= Date.parse(plan.evaluationDeadlineUTC) || existsSync(join(run, 'STOP'));
  try {
    for (const task of plan.tasks) {
      currentTask = task.id;
      for (let i = shard; i < task.seeds.length; i += shards) {
        while (!stop() && memoryAvailability().availableBytes < plan.reserveGiB * 1024 ** 3) {
          phase = 'waiting-for-memory';
          status();
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (stop()) {
          phase = 'stopped';
          return;
        }
        phase = 'running';
        const seed = task.seeds[i],
          games = [];
        for (const team of [0, 1]) {
          if (stop()) {
            phase = 'stopped';
            return;
          }
          const seats = lineup(task, team, seed);
          const result = await playRound({
            seed,
            seats,
            values: (id, s) => pool.values(files[id], s, plan.models[id].config),
            modelConfigs: Object.fromEntries(
              Object.entries(plan.models).map(([id, m]) => [id, m.config || {}]),
            ),
            capture: !!plan.capture,
          });
          games.push({
            team,
            seats,
            ...result,
            signedPoints: result.points * (result.winner === team ? 1 : -1),
          });
        }
        if (games[0].dealSHA256 !== games[1].dealSHA256 || games[0].leader !== games[1].leader)
          throw Error('Paired deals differ');
        appendFileSync(
          output,
          JSON.stringify({ task: task.id, seed, protocolSHA256, games }) + '\n',
        );
        count++;
        if (count % 10 === 0) status();
      }
    }
    phase = 'complete';
  } catch (error) {
    phase = 'failed';
    failure = error.stack;
    throw error;
  } finally {
    status();
    await pool.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runRoundPairs({
    protocol: resolve(option('protocol', '')),
    run: resolve(option('run', '')),
    shard: Number(option('shard', '0')),
    shards: Number(option('shards', '4')),
  });
