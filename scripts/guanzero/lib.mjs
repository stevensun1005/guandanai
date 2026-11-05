import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as ort from 'onnxruntime-node';
import { encode, cardsArray } from '../../src/ai/encoding.mjs';
import { history } from './history.mjs';
export { readJSON, writeJSON, sha256, option } from '../continuous/lib.mjs';
import { readJSON, writeJSON } from '../continuous/lib.mjs';
export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const FEATURES = 1647,
  TRAIN_BASE = 1_000_000_000,
  TRAIN_SPAN = 50_000_000,
  TRAIN_OFFSET = 30_000_000;
export const EVAL_BASE = 3_700_000_000,
  EVAL_SPAN = 100_000;
export function trainSeed(slot, count) {
  if (
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot >= 40 ||
    !Number.isInteger(count) ||
    count < 0 ||
    count >= 20_000_000
  )
    throw Error('Training seed block exhausted or invalid');
  return TRAIN_BASE + slot * TRAIN_SPAN + TRAIN_OFFSET + count;
}
export function evalSeed(index, pairs = 100) {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    !Number.isInteger(pairs) ||
    pairs < 1 ||
    pairs > EVAL_SPAN ||
    EVAL_BASE + (index + 1) * EVAL_SPAN > 2 ** 32
  )
    throw Error('Evaluation seed block exhausted or invalid');
  return EVAL_BASE + index * EVAL_SPAN;
}
export function paths(run) {
  const root = resolve(run);
  return Object.fromEntries(
    ['root', 'models', 'shards', 'actors', 'learner', 'eval'].map((k) => [
      k,
      k === 'root' ? root : join(root, k),
    ]),
  );
}
export function makePaths(p) {
  for (const folder of Object.values(p)) mkdirSync(folder, { recursive: true });
}
export function encodeRow(state, index) {
  const row = new Int8Array(FEATURES);
  let at = 0;
  for (const part of [encode(state), history(state), cardsArray(state.actions[index])]) {
    for (const value of part) {
      if (![-1, 0, 1, 2].includes(value)) throw Error('Invalid int8 feature');
      row[at++] = value;
    }
  }
  return row;
}
export function labels(rows, result) {
  const rounds = new Map(result.history.map((h) => [h.round, h]));
  return rows.map((row) => {
    const round = rounds.get(row.round);
    if (!round) throw Error('Missing round reward');
    const wp = row.team === round.team ? 1 : -1;
    return { ...row, targets: [wp * round.up, wp] };
  });
}
export function writeShard(directory, rows, meta = {}) {
  if (!rows.length) return null;
  const name = `a${String(meta.slot ?? 0).padStart(2, '0')}-${Date.now()}-${randomUUID()}`;
  const x = new Int8Array(rows.length * FEATURES),
    y = Buffer.alloc(rows.length * 8);
  rows.forEach((row, i) => {
    x.set(row.features, i * FEATURES);
    row.targets.forEach((v, j) => y.writeFloatLE(v, (i * 2 + j) * 4));
  });
  writeFileSync(join(directory, name + '.x.i8'), x);
  writeFileSync(join(directory, name + '.y.f32'), y);
  writeJSON(join(directory, name + '.json'), {
    schema: 1,
    rows: rows.length,
    features: FEATURES,
    targets: ['adp', 'wp'],
    createdAt: new Date().toISOString(),
    ...meta,
  });
  return name;
}
export async function createInference() {
  let current = null,
    engine = null;
  return {
    async load(file) {
      if (file === current) return;
      const next = await ort.InferenceSession.create(file, {
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all',
      });
      if (engine) await engine.release();
      engine = next;
      current = file;
    },
    async values(state) {
      if (!engine) throw Error('No GuanZero model loaded');
      const actions = new Float32Array(state.actions.length * 54);
      state.actions.forEach((a, i) => actions.set(cardsArray(a), i * 54));
      const output = await engine.run({
        state: new ort.Tensor('float32', encode(state), [1, 513]),
        history: new ort.Tensor('float32', Float32Array.from(history(state)), [1, 5, 216]),
        actions: new ort.Tensor('float32', actions, [state.actions.length, 54]),
      });
      const values = output.values.data;
      if (values.length !== state.actions.length || !values.every(Number.isFinite))
        throw Error('Invalid GuanZero Q values');
      return values;
    },
    async close() {
      if (engine) await engine.release();
      engine = null;
      current = null;
    },
  };
}
export function actorTotals(p) {
  const actors = readdirSync(p.actors)
    .filter((n) => /^actor-\d+\.json$/.test(n))
    .map((n) => readJSON(join(p.actors, n)));
  return {
    matches: actors.reduce((s, a) => s + a.matches, 0),
    rows: actors.reduce((s, a) => s + a.rows, 0),
    actors,
  };
}
export function stopped(p) {
  return existsSync(join(p.root, 'STOP'));
}
