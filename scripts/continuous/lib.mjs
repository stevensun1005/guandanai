/** Shared pieces of the continuous self-play system: files, models, samples, league and SPRT. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encode, cardsArray } from '../../src/ai/encoding.mjs';

export const STATE = 513;
export const ACTION = 54;
export const FEATURES = STATE + ACTION;
/** Per-row float32 targets: signed round level points, match result, round index, match rounds. */
export const TARGETS = 4;

/**
 * Seed ranges. Every development / held-out seed used by the study so far is below 1e9, so
 * continuous training never draws a match seed from that range. Each actor slot owns a block.
 */
export const TRAIN_SEED_BASE = 1_000_000_000;
export const TRAIN_SEED_SPAN = 50_000_000;
export const PROBE_SEED_BASE = 3_400_000_000;
export const GATE_SEED_BASE = 3_500_000_000;
export const GATE_SEED_SPAN = 100_000;
export const ANCHOR_SEED_BASE = 3_600_000_000;
export const ANCHOR_SEED_SPAN = 100_000;
export const ANCHOR_SEED_LIMIT = 3_700_000_000;
export const MAX_ACTORS = 40;

export const DEFAULT_CONFIG = Object.freeze({
  schema: 1,
  initial: 'ai/policy.onnx',
  actors: 6,
  actorSeedOffset: 0,
  evaluationBlockOffset: 0,
  actorMix: { self: 0.5, league: 0.3, rule: 0.2 },
  // Measured: uniform epsilon 0.01 cost about 8 points of match score, softmax 0.02 none detectable.
  exploration: { type: 'softmax', temperature: 0.02 },
  shardRows: 16384,
  shardSeconds: 120,
  learner: {
    device: 'cpu',
    threads: 4,
    batch: 2048,
    learningRate: 1e-5,
    gradClip: 1.0,
    capacity: 2_000_000,
    minSamples: 100_000,
    replayRatio: 4,
    exportSeconds: 600,
    targetMatchWeight: 0,
    anchorWeight: 0,
    keepVersions: 6,
    seed: 20261104,
  },
  snapshotMinutes: 60,
  leagueSize: 24,
  gate: { alpha: 0.05, beta: 0.05, mu0: 0.5, mu1: 0.53, minPairs: 100, maxPairs: 1000 },
  anchor: { intervalHours: 3, pairs: 150, regressionLimit: 2 },
  restarts: { limit: 5, windowMinutes: 10 },
  diskLimitGB: 20,
});

export const option = (name, fallback) =>
  process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

export function runPaths(run) {
  const root = resolve(run);
  return {
    root,
    config: join(root, 'config.json'),
    stop: join(root, 'STOP'),
    status: join(root, 'status.json'),
    events: join(root, 'events.jsonl'),
    models: join(root, 'models'),
    latest: join(root, 'models', 'latest.json'),
    champion: join(root, 'champion'),
    championMeta: join(root, 'champion', 'champion.json'),
    league: join(root, 'league'),
    leagueMeta: join(root, 'league', 'league.json'),
    shards: join(root, 'shards'),
    actors: join(root, 'actors'),
    learner: join(root, 'learner'),
    gate: join(root, 'gate'),
    anchor: join(root, 'anchor'),
  };
}

export function ensureDirs(paths) {
  for (const key of [
    'models',
    'champion',
    'league',
    'shards',
    'actors',
    'learner',
    'gate',
    'anchor',
  ])
    mkdirSync(paths[key], { recursive: true });
}

export const readJSON = (file, fallback = null) =>
  existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;

export function writeJSON(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporary, file);
      break;
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
}

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Small integer features are stored as int8; anything else would mean an encoder change. */
export function encodeSample(state, actionIds) {
  const row = new Int8Array(FEATURES);
  const parts = [encode(state), cardsArray(actionIds)];
  let at = 0;
  for (const part of parts)
    for (const value of part) {
      if (!Number.isInteger(value) || value < -1 || value > 2)
        throw Error(`Feature outside int8 sample range: ${value}`);
      row[at++] = value;
    }
  return row;
}

/**
 * Training-time action choice. 'epsilon': uniform over all candidates with probability epsilon.
 * 'softmax': sample from softmax(Q / temperature). Returns whether the choice differs from greedy.
 */
export function explore(values, exploration, random = Math.random) {
  const best = argmax(values);
  let index = best;
  if (exploration.type === 'epsilon') {
    if (random() < exploration.epsilon) index = Math.floor(random() * values.length);
  } else if (exploration.type === 'softmax') {
    const t = exploration.temperature;
    const weights = Array.from(values, (v) => Math.exp((v - values[best]) / t));
    index = sample(weights, random);
  } else if (exploration.type !== 'greedy') throw Error('Unknown exploration rule');
  return { index, explored: index !== best };
}

export function argmax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

/** Per-decision P0-layout inference with one cached native session per model file. */
export async function createModelPool(ort, { threads = 1, limit = 8 } = {}) {
  const sessions = new Map();
  async function session(file) {
    if (!sessions.has(file)) {
      if (sessions.size >= limit) {
        const [oldest, promise] = sessions.entries().next().value;
        sessions.delete(oldest);
        void promise.then((s) => s.release()).catch(() => {});
      }
      sessions.set(
        file,
        ort.InferenceSession.create(file, {
          intraOpNumThreads: threads,
          interOpNumThreads: 1,
          graphOptimizationLevel: 'all',
        }),
      );
    }
    return sessions.get(file);
  }
  return {
    async values(file, state) {
      const engine = await session(file);
      const n = state.actions.length;
      const actions = new Float32Array(n * ACTION);
      for (let i = 0; i < n; i++) actions.set(cardsArray(state.actions[i]), i * ACTION);
      const output = await engine.run({
        state: new ort.Tensor('float32', encode(state), [1, STATE]),
        actions: new ort.Tensor('float32', actions, [n, ACTION]),
      });
      const values = output.values.data;
      if (values.length !== n || !values.every(Number.isFinite))
        throw Error('Invalid model values');
      return values;
    },
    async close() {
      for (const promise of sessions.values()) (await promise).release();
      sessions.clear();
    },
  };
}

/** Learner seats' decisions of one match, labelled once the match result is known. */
export function labelMatch(rows, result) {
  const rounds = new Map(result.history.map((h) => [h.round, h]));
  return rows.map((row) => {
    const round = rounds.get(row.round);
    if (!round) throw Error('Decision from an unknown round');
    const points = (row.team === round.team ? 1 : -1) * round.up;
    const outcome = result.winner === null ? 0 : row.team === result.winner ? 1 : -1;
    return { features: row.features, targets: [points, outcome, row.round - 1, rounds.size] };
  });
}

/** Rows become visible to the learner only after the .json manifest is renamed into place. */
export class ShardWriter {
  constructor(directory, prefix, sequence = 0) {
    this.directory = directory;
    this.prefix = prefix;
    this.sequence = sequence;
    this.reset();
  }
  reset() {
    this.features = [];
    this.targets = [];
    this.matches = 0;
    this.models = new Set();
    this.started = Date.now();
  }
  get rows() {
    return this.features.length;
  }
  add(labelled, model) {
    for (const row of labelled) {
      this.features.push(row.features);
      this.targets.push(row.targets);
    }
    this.matches++;
    this.models.add(model);
  }
  flush(extra = {}) {
    if (!this.rows) return null;
    const name = `${this.prefix}-${String(this.sequence++).padStart(9, '0')}`;
    const features = new Int8Array(this.rows * FEATURES);
    this.features.forEach((row, i) => features.set(row, i * FEATURES));
    const targets = new Float32Array(this.rows * TARGETS);
    this.targets.forEach((row, i) => targets.set(row, i * TARGETS));
    writeFileSync(join(this.directory, `${name}.x.i8`), features);
    writeFileSync(join(this.directory, `${name}.y.f32`), targets);
    const manifest = {
      schema: 1,
      rows: this.rows,
      features: FEATURES,
      targets: ['roundPoints', 'matchResult', 'roundIndex', 'matchRounds'],
      matches: this.matches,
      models: [...this.models],
      createdAt: new Date().toISOString(),
      ...extra,
    };
    writeJSON(join(this.directory, `${name}.json`), manifest);
    this.reset();
    return name;
  }
}

/** Prioritized fictitious self-play: opponents the current model beats less often get more games. */
export function pfspWeights(members, stats = {}, power = 2) {
  return members.map((member) => {
    const s = stats[member.id] || { games: 0, wins: 0, draws: 0 };
    const score = (s.wins + 0.5 * s.draws + 1) / (s.games + 2);
    return (1 - score) ** power + 0.02;
  });
}

export function sample(weights, random = Math.random) {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = random() * total;
  for (let i = 0; i < weights.length; i++) if ((x -= weights[i]) < 0) return i;
  return weights.length - 1;
}

/** Normal-approximation sequential probability ratio test on paired-seed mean scores. */
export function sprt(scores, { alpha, beta, mu0, mu1 }) {
  const n = scores.length;
  const bounds = { lower: Math.log(beta / (1 - alpha)), upper: Math.log((1 - beta) / alpha) };
  if (n < 2) return { n, llr: 0, ...bounds, decision: null };
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  // Floor the variance so a short lucky streak cannot look certain (per-pair variance is ~0.1).
  const variance = Math.max(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1), 0.05);
  const llr = ((mu1 - mu0) / variance) * (n * mean - (n * (mu0 + mu1)) / 2);
  const decision = llr >= bounds.upper ? 'accept' : llr <= bounds.lower ? 'reject' : null;
  return { n, mean, variance, llr, ...bounds, decision };
}

export const matchScore = (winner, team) => (winner === null ? 0.5 : winner === team ? 1 : 0);

/** Reserve separate finite blocks; indices are persisted before an evaluation starts. */
export function evaluationSeedStart(kind, index, pairs) {
  if (
    !['gate', 'anchor'].includes(kind) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !Number.isSafeInteger(pairs) ||
    pairs < 1 ||
    pairs > GATE_SEED_SPAN
  )
    throw Error('Invalid evaluation seed allocation');
  const base = kind === 'anchor' ? ANCHOR_SEED_BASE : GATE_SEED_BASE;
  const limit = kind === 'anchor' ? ANCHOR_SEED_LIMIT : ANCHOR_SEED_BASE;
  const start = base + index * GATE_SEED_SPAN;
  if (start + GATE_SEED_SPAN > limit) throw Error(`${kind} seed range exhausted`);
  return start;
}

/** Paired-seed uncertainty; correlated swapped matches are never counted as independent. */
export function pairedScoreSummary(pairs) {
  if (
    !pairs.length ||
    new Set(pairs.map((p) => p.seed)).size !== pairs.length ||
    pairs.some(
      (p) =>
        !Number.isSafeInteger(p.seed) ||
        p.scores?.length !== 2 ||
        p.scores.some((s) => ![0, 0.5, 1].includes(s)),
    )
  )
    throw Error('Invalid paired scores');
  const scores = pairs.map((p) => (p.scores[0] + p.scores[1]) / 2);
  const meanScore = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const radius = Math.sqrt(Math.log(40) / (2 * scores.length));
  return {
    meanScore,
    clusterHoeffding95CI: [Math.max(0, meanScore - radius), Math.min(1, meanScore + radius)],
  };
}

/** Only complete, fixed 150-pair checks can contribute to the operational stop heuristic. */
export function anchorRegression(streak, report, limit = 2) {
  if (!Number.isInteger(limit) || limit < 2) throw Error('Invalid anchor regression limit');
  const valid =
    report?.kind === 'anchor' && report.status === 'complete' && report.pairs?.length === 150;
  const summary = valid ? pairedScoreSummary(report.pairs) : null;
  const next = summary?.clusterHoeffding95CI[1] < 0.5 ? streak + 1 : 0;
  return { streak: next, stop: next >= limit };
}
