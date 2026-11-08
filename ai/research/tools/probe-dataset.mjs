/** Frozen champion trajectories for read-only representation diagnostics; never trains. */
import * as ort from 'onnxruntime-node';
import {
  openSync,
  closeSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freemem, endianness } from 'node:os';
import { createRound, advanceRound } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { encode, cardsArray } from '../../../web/src/ai/encoding.mjs';
import { encodePolicyExtras } from '../../../web/src/ai/policy-features.mjs';
import { analysisState } from '../../danMCai/evaluation/cooperation-labels.mjs';
import {
  createModelPool,
  argmax,
  readJSON,
  writeJSON,
  sha256,
  option,
} from '../../danMCai/training/continuous/lib.mjs';

export const DATASET_COLUMNS = { features: 567, extras: 53, metadata: 5, labels: 11 };
export const LABEL_NAMES = [
  'chosenQ',
  'finalSignedPoints',
  'finishingRank',
  'trickPresent',
  'relativeTrickOwnerOrNone',
  'passes',
  'partnerLeading',
  'partnerHasBomb',
  'ownHandCount',
  'blindKind',
  'level',
];
// Exact deployed slots: last global action at120..173; last partner action at174..227.
export function blindKind(features, hasTrick) {
  const a = features.slice(120, 174),
    b = features.slice(174, 228);
  if (a.some((x) => x > 0) || b.some((x) => x > 0)) return 0;
  const sentinel = a.some((x) => x < 0) || b.some((x) => x < 0);
  return (sentinel ? 3 : 1) + Number(hasTrick);
}

export function blindEstimate(deals) {
  const total = deals.reduce((n, d) => n + d.rows, 0),
    blind = deals.reduce((n, d) => n + d.rows - d.blindCounts[0], 0);
  const mean = total ? blind / total : null;
  const se =
    deals.length > 1
      ? Math.sqrt(
          (deals.length / (deals.length - 1)) *
            deals.reduce((n, d) => n + (d.rows - d.blindCounts[0] - mean * d.rows) ** 2, 0),
        ) / total
      : null;
  return {
    mean,
    clusters: deals.length,
    standardError: se,
    ci95: se === null ? null : [Math.max(0, mean - 1.96 * se), Math.min(1, mean + 1.96 * se)],
    method:
      'Ratio linearization normal interval over independent complete deals, not independent decisions',
  };
}

export async function collectProbeRound(seed, infer, { stop = () => false } = {}) {
  const game = createRound(seed),
    rows = [],
    values = [],
    bombs = new Map();
  for (let ply = 0; ply < 1000; ply++) {
    if (stop()) throw Error('Probe STOP or deadline');
    const p = game.turn,
      plays = candidates(game.hands[p], game.L, game.trick?.play);
    const state = analysisState(game, p, plays),
      q = Array.from(await infer(state));
    if (q.length !== plays.length || !q.every(Number.isFinite)) throw Error('Invalid probe values');
    const chosen = argmax(q),
      features = new Float32Array(567);
    features.set(encode(state));
    features.set(cardsArray(state.actions[chosen]), 513);
    const packed = Int8Array.from(features);
    if (!packed.every((x, i) => x === features[i])) throw Error('Lossy feature packing');
    const mate = (p + 2) % 4,
      key = game.L + ':' + game.hands[mate].map((c) => c.id).join(',');
    if (!bombs.has(key))
      bombs.set(
        key,
        Number(
          candidates(game.hands[mate], game.L, null).some(
            (x) => x && ['bomb', 'sflush', 'jokers'].includes(x.type),
          ),
        ),
      );
    const extra = encodePolicyExtras(state, chosen),
      kind = blindKind(features, !!game.trick);
    const labels = Float32Array.from([
      q[chosen],
      0,
      0,
      Number(!!game.trick),
      game.trick ? 1 + ((game.trick.player - p + 4) % 4) : 0,
      game.passes || 0,
      Number(game.trick?.player === mate),
      bombs.get(key),
      game.hands[p].length,
      kind,
      game.L,
    ]);
    rows.push({
      features: packed,
      extras: extra,
      metadata: Uint32Array.from([seed, p, ply, q.length, chosen]),
      labels,
    });
    values.push(Float32Array.from(q));
    const outcome = advanceRound(game, plays[chosen]);
    if (outcome) {
      for (const row of rows) {
        const seat = row.metadata[1];
        row.labels[1] = outcome.points * (outcome.winner === seat % 2 ? 1 : -1);
        row.labels[2] = outcome.order.indexOf(seat) + 1;
      }
      return { rows, values, outcome };
    }
  }
  throw Error('Probe round truncated; do not use partial trajectory');
}

export async function runProbeDataset(run) {
  const task = readJSON(join(run, 'campaign-task.json')),
    protocol = join(run, 'protocol.json'),
    plan = readJSON(protocol);
  if (!task || sha256(protocol) !== task.protocolSHA256)
    throw Error('Unregistered or changed probe protocol');
  if (
    !Number.isFinite(Date.parse(plan.deadlineUTC)) ||
    !Number.isInteger(plan.targetDecisions) ||
    plan.targetDecisions < 1
  )
    throw Error('Freeze a finite deadline and positive decision target');
  const stop = () =>
    existsSync(join(run, 'STOP')) ||
    Date.now() >= Math.min(Date.parse(task.window.deadlineUTC), Date.parse(plan.deadlineUTC));
  const state = {
    pid: process.pid,
    phase: 'development',
    displayName: plan.displayName,
    positionUnit: '条完整单局决策',
    completedPositions: 0,
    plannedPositions: plan.targetDecisions,
    completedDeals: 0,
    optimizerUpdates: 0,
    strengthGames: 0,
    provider: 'CPUExecutionProvider (explicit, one thread)',
    minimumAvailableGiB: freemem() / 1024 ** 3,
  };
  const save = () => {
    state.updatedAt = new Date().toISOString();
    state.minimumAvailableGiB = Math.min(state.minimumAvailableGiB, freemem() / 1024 ** 3);
    writeJSON(join(run, 'status.json'), state);
  };
  if (stop()) {
    state.phase = 'stopped-before-spawn';
    save();
    return state;
  }
  for (const [f, h] of Object.entries(plan.sourceSHA256))
    if (sha256(join(plan.sourceRoot, f)) !== h) throw Error('Frozen source changed: ' + f);
  if (sha256(plan.teacher.file) !== plan.teacher.sha256) throw Error('Champion changed');
  if (endianness() !== 'LE') throw Error('Dataset binary schema requires little endian');
  const lock = join(run, 'probe.lock'),
    fd = openSync(lock, 'wx');
  closeSync(fd);
  const dir = plan.dataDirectory;
  if (existsSync(dir)) {
    unlinkSync(lock);
    throw Error('Dataset already exists; do not overwrite or restart');
  }
  mkdirSync(dir, { recursive: true });
  const names = ['features.i8', 'extras.f32', 'metadata.u32', 'labels.f32', 'candidate-values.f32'];
  const streams = names.map((n) => openSync(join(dir, n), 'wx'));
  const pool = await createModelPool(ort, { threads: 1, limit: 1, provider: 'cpu' });
  const timer = setInterval(save, 3000);
  const deals = [];
  let candidateValues = 0;
  try {
    save();
    for (const seed of plan.seeds) {
      if (stop()) throw Error('Probe STOP or deadline');
      if (freemem() < plan.reserveGiB * 1024 ** 3) {
        state.phase = 'waiting-for-memory';
        save();
        while (!stop() && freemem() < plan.resumeGiB * 1024 ** 3)
          await new Promise((r) => setTimeout(r, 1000));
      }
      if (stop()) throw Error('Probe STOP or deadline');
      state.phase = 'development';
      const collected = await collectProbeRound(seed, (s) => pool.values(plan.teacher.file, s), {
        stop,
      });
      const buffer = (arrays) =>
        Buffer.concat(arrays.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
      const counts = [0, 0, 0, 0, 0];
      const choiceCounts = [0, 0, 0, 0, 0];
      for (const row of collected.rows) counts[row.labels[9]]++;
      for (const row of collected.rows) if (row.metadata[3] > 1) choiceCounts[row.labels[9]]++;
      const startRow = state.completedPositions;
      for (const [i, key] of ['features', 'extras', 'metadata', 'labels'].entries())
        writeFileSync(streams[i], buffer(collected.rows.map((r) => r[key])));
      writeFileSync(streams[4], buffer(collected.values));
      candidateValues += collected.values.reduce((n, a) => n + a.length, 0);
      state.completedPositions += collected.rows.length;
      state.completedDeals++;
      deals.push({
        seed,
        startRow,
        rows: collected.rows.length,
        blindCounts: counts,
        choiceRows: choiceCounts.reduce((a, b) => a + b, 0),
        choiceBlindCounts: choiceCounts,
      });
      save();
      if (state.completedPositions >= plan.targetDecisions) break;
    }
    if (state.completedPositions < plan.targetDecisions)
      throw Error('Insufficient preregistered seeds');
    state.phase = 'complete';
  } catch (e) {
    state.phase = stop() ? 'incomplete-deadline' : 'failed';
    state.failure = e.stack;
  } finally {
    clearInterval(timer);
    streams.forEach(closeSync);
    await pool.close();
    const counts = deals.reduce(
      (sum, d) => sum.map((n, i) => n + d.blindCounts[i]),
      [0, 0, 0, 0, 0],
    );
    writeJSON(join(dir, 'deals.json'), deals);
    writeJSON(join(run, 'summary.json'), {
      schema: 1,
      kind: 'representation-corpus-not-training-or-strength',
      phase: state.phase,
      completedAtUTC: new Date().toISOString(),
      protocolSHA256: task.protocolSHA256,
      teacher: plan.teacher,
      rows: state.completedPositions,
      completeDeals: state.completedDeals,
      candidateValues,
      blindCounts: counts,
      blindFrequency: blindEstimate(deals),
      choiceBlindFrequency: blindEstimate(
        deals
          .filter((d) => d.choiceRows > 0)
          .map((d) => ({ rows: d.choiceRows, blindCounts: d.choiceBlindCounts })),
      ),
      columns: DATASET_COLUMNS,
      labelNames: LABEL_NAMES,
      dataDirectory: dir,
      files: Object.fromEntries(
        names.map((n) => [n, { bytes: statSync(join(dir, n)).size, sha256: sha256(join(dir, n)) }]),
      ),
      minimumAvailableGiB: state.minimumAvailableGiB,
      optimizerUpdates: 0,
      strengthGames: 0,
      scope:
        'Independent complete single rounds; split/cluster by deal, never by decisions. Privileged labels never enter policy features, ranking, rewards or training. Corpus prevalence is not an input-arm benefit or closed residual-probe result.',
    });
    state.stoppedAt = new Date().toISOString();
    save();
    unlinkSync(lock);
  }
  return state;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const result = await runProbeDataset(resolve(option('run', '')));
  if (!['complete', 'stopped-before-spawn'].includes(result.phase)) process.exitCode = 1;
}
