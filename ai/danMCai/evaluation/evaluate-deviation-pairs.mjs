/** One forced legal alternative with a common deterministic baseline; final round outcomes only. */
import * as ort from 'onnxruntime-node';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, openSync, closeSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freemem } from 'node:os';
import { playRound, hash } from './evaluate-round-pairs.mjs';
import {
  createModelPool,
  readJSON,
  writeJSON,
  sha256,
  option,
} from '../training/continuous/lib.mjs';

export function deviationSeats(task, index) {
  const team = Math.floor(index / 2) % 2,
    focus = team + (index % 2) * 2;
  return {
    team,
    focus,
    seats: [0, 1, 2, 3].map((p) =>
      p % 2 !== team ? task.opponent : task.mixed && p !== focus ? 'clint' : 'champion',
    ),
  };
}

export function selectDeviation(moves, focus, salt, seed, task, draw = null) {
  const options = [];
  moves.forEach((move, turn) => {
    if (move.p !== focus || !move.estimates || move.estimates.length < 2) return;
    const ranking = move.estimates
      .map((q, index) => ({ q, index }))
      .sort((a, b) => b.q - a.q || a.index - b.index);
    for (let rank = 2; rank <= Math.min(5, ranking.length); rank++)
      options.push({
        turn,
        player: focus,
        index: ranking[rank - 1].index,
        rank,
        candidateSHA256: move.candidateSHA256,
        ownHandCount: move.ownHandCount,
        predictedGap: ranking[0].q - ranking[rank - 1].q,
        qBest: ranking[0].q,
        qAlternative: ranking[rank - 1].q,
      });
  });
  if (!options.length) return null;
  const high = options.filter((x) => x.predictedGap >= 0.1),
    low = options.filter((x) => x.predictedGap < 0.1);
  const random =
    draw ||
    ((tag) =>
      createHash('sha256').update(`${salt}:${task}:${seed}:${tag}`).digest().readUIntBE(0, 6) /
      2 ** 48);
  const both = high.length && low.length,
    chooseHigh = !low.length || (high.length && random('stratum') < 0.75);
  const choices = chooseHigh ? high : low,
    p = both ? (chooseHigh ? 0.75 : 0.25) : 1;
  const selected = choices[Math.floor(random('choice') * choices.length)];
  const proposalProbability = p / choices.length,
    targetProbability = 1 / options.length;
  return {
    ...selected,
    stratum: chooseHigh ? 'gap-at-least-point1' : 'gap-below-point1',
    candidatePositionRankPairs: options.length,
    highPairs: high.length,
    lowPairs: low.length,
    proposalProbability,
    targetProbability,
    weight: targetProbability / proposalProbability,
  };
}

export async function runDeviationPairs({ protocol, run, shard = 0, shards = 4 }) {
  const plan = readJSON(protocol),
    registered = readJSON(join(run, 'campaign-task.json'));
  const stop = () =>
    existsSync(join(run, 'STOP')) ||
    existsSync(join(run, '../../STOP')) ||
    Date.now() >=
      Math.min(Date.parse(plan.evaluationDeadlineUTC), Date.parse(registered.window.deadlineUTC));
  if (stop()) return;
  const protocolSHA256 = sha256(protocol);
  if (
    protocolSHA256 !== registered.protocolSHA256 ||
    shards !== plan.workers ||
    !Number.isInteger(shard) ||
    shard < 0 ||
    shard >= shards
  )
    throw Error('Invalid registered deviation worker');
  for (const [name, digest] of Object.entries(plan.sourceSHA256))
    if (sha256(join(plan.evaluationSource, name)) !== digest)
      throw Error('Frozen source changed: ' + name);
  for (const m of Object.values(plan.models))
    if (sha256(m.file) !== m.sha256) throw Error('Frozen model changed');
  const file = join(run, `worker-${shard}.jsonl`),
    lock = join(run, `deviation-worker-${shard}.lock`);
  if (existsSync(file) || existsSync(join(run, `worker-${shard}.json`)))
    throw Error('Existing attempt; no repeated roots or fits');
  const fd = openSync(lock, 'wx');
  closeSync(fd);
  const state = {
    pid: process.pid,
    phase: 'running',
    completedRoots: 0,
    completedPairs: 0,
    completedRounds: 0,
    ineligibleRoots: 0,
    plannedRoots: 2500,
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
    if (stop()) throw Error('STOP or fixed deadline');
    let memory = freemem() / 1024 ** 3;
    state.minimumAvailableGiB = Math.min(state.minimumAvailableGiB, memory);
    while (memory < (paused ? 5 : 4)) {
      paused = true;
      state.phase = 'waiting-for-memory';
      save();
      await new Promise((r) => setTimeout(r, 1000));
      if (stop()) throw Error('STOP or fixed deadline');
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
  const outcome = (result) => ({
    winner: result.winner,
    points: result.points,
    order: result.order,
    turns: result.turns,
  });
  try {
    for (const task of plan.tasks) {
      state.currentTask = task.id;
      for (let i = shard; i < task.seeds.length; i += shards) {
        await checkpoint();
        const seed = task.seeds[i],
          { team, focus, seats } = deviationSeats(task, i);
        const options = {
          seed,
          seats,
          capture: true,
          captureChoices: true,
          checkpoint,
          values: (id, s) => pool.values(plan.models[id].file, s, plan.models[id].config),
        };
        const baseline = await playRound(options);
        state.completedRounds++;
        const row = {
          task: task.id,
          seed,
          caseIndex: i,
          team,
          focus,
          protocolSHA256,
          dealSHA256: baseline.dealSHA256,
          level: baseline.level,
          leader: baseline.leader,
          baseline: outcome(baseline),
        };
        writeJSON(join(run, `deviation-${shard}-pending.json`), row);
        save();
        const choice = selectDeviation(
          baseline.trace.moves,
          focus,
          plan.selectionSalt,
          seed,
          task.id,
        );
        row.choice = choice;
        if (choice) {
          const altered = await playRound({ ...options, intervention: choice });
          state.completedRounds++;
          const prefixA = hash(JSON.stringify(baseline.trace.moves.slice(0, choice.turn))),
            prefixB = hash(JSON.stringify(altered.trace.moves.slice(0, choice.turn)));
          if (
            prefixA !== prefixB ||
            baseline.dealSHA256 !== altered.dealSHA256 ||
            altered.interventionApplied !== 1 ||
            Math.abs(choice.predictedGap - altered.interventionQGap) > 1e-7
          )
            throw Error('Counterfactual common-prefix/Q mismatch');
          row.deviation = outcome(altered);
          row.prefixSHA256 = prefixA;
          row.oneInterventionApplied = true;
          row.realizedDelta =
            (baseline.winner === team ? baseline.points : -baseline.points) -
            (altered.winner === team ? altered.points : -altered.points);
          state.completedPairs++;
        } else state.ineligibleRoots++;
        appendFileSync(file, JSON.stringify(row) + '\n');
        unlinkSync(join(run, `deviation-${shard}-pending.json`));
        state.completedRoots++;
        save();
      }
    }
    state.phase = 'complete';
  } catch (error) {
    state.phase = stop() ? 'stopped' : 'failed';
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
  await runDeviationPairs({
    protocol: resolve(option('protocol', '')),
    run: resolve(option('run', '')),
    shard: Number(option('shard', '0')),
    shards: Number(option('shards', '4')),
  });
