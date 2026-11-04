import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as ort from 'onnxruntime-node';
import { playMatch } from '../scripts/lib/match-rollout.mjs';
import {
  FEATURES,
  GATE_SEED_BASE,
  TARGETS,
  TRAIN_SEED_BASE,
  ShardWriter,
  argmax,
  createModelPool,
  encodeSample,
  explore,
  labelMatch,
  pfspWeights,
  sprt,
} from '../scripts/continuous/lib.mjs';

test('training and gate seeds never enter the study evaluation range', () => {
  assert.ok(TRAIN_SEED_BASE >= 1e9);
  assert.ok(GATE_SEED_BASE >= TRAIN_SEED_BASE + 40 * 50_000_000);
});

test('SPRT accepts a clearly stronger challenger and rejects a weaker one', () => {
  const settings = { alpha: 0.05, beta: 0.05, mu0: 0.5, mu1: 0.53 };
  const strong = Array.from({ length: 400 }, (_, i) => [1, 0.5, 1, 0.5, 0][i % 5]);
  const weak = Array.from({ length: 400 }, (_, i) => [0, 0.5, 0, 0.5, 1][i % 5]);
  assert.equal(sprt(strong, settings).decision, 'accept');
  assert.equal(sprt(weak, settings).decision, 'reject');
  assert.equal(sprt([1], settings).decision, null);
  assert.equal(sprt([1, 1, 0.75, 1], settings).decision, null, 'four lucky pairs are not proof');
});

test('exploration rules stay greedy at their limits and only sample near-best softmax moves', () => {
  const values = new Float32Array([0.1, 1.0, 0.95, -2]);
  let state = 1;
  const random = () => (state = (state * 48271) % 2147483647) / 2147483647;
  assert.equal(explore(values, { type: 'greedy' }, random).index, 1);
  assert.equal(explore(values, { type: 'epsilon', epsilon: 0 }, random).index, 1);
  assert.equal(explore(values, { type: 'softmax', temperature: 1e-4 }, random).index, 1);
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < 4000; i++)
    counts[explore(values, { type: 'softmax', temperature: 0.05 }, random).index]++;
  assert.ok(counts[1] > counts[2] && counts[2] > 500 && counts[0] + counts[3] < 20);
  assert.throws(() => explore(values, { type: 'other' }, random));
});

test('PFSP gives more weight to opponents the current model beats less often', () => {
  const members = [{ id: 'easy' }, { id: 'hard' }, { id: 'new' }];
  const [easy, hard, fresh] = pfspWeights(members, {
    easy: { games: 100, wins: 90, draws: 0 },
    hard: { games: 100, wins: 30, draws: 10 },
  });
  assert.ok(hard > fresh && fresh > easy);
});

test('a played match yields int8 rows labelled with signed round points and match result', async () => {
  const pool = await createModelPool(ort);
  const rows = [];
  const result = await playMatch({
    seed: TRAIN_SEED_BASE + 7,
    team: 0,
    mode: 'rule',
    decide: async (state) => {
      const index = argmax(await pool.values('ai/policy.onnx', state));
      rows.push({
        features: encodeSample(state, state.actions[index]),
        team: state.p % 2,
        round: state.match.round,
      });
      return { index };
    },
  });
  await pool.close();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.team === 0 && row.features.length === FEATURES));
  const labelled = labelMatch(rows, result);
  const rounds = new Map(result.history.map((h) => [h.round, h]));
  for (const [i, row] of labelled.entries()) {
    const round = rounds.get(rows[i].round);
    assert.equal(row.targets[0], (round.team === 0 ? 1 : -1) * round.up);
    assert.equal(row.targets[1], result.winner === null ? 0 : result.winner === 0 ? 1 : -1);
    assert.equal(row.targets[3], result.history.length);
  }

  const directory = mkdtempSync(join(tmpdir(), 'guandan-shard-'));
  try {
    const writer = new ShardWriter(directory, 'a00');
    writer.add(labelled, 'v000000000');
    const name = writer.flush({ actor: 0 });
    const manifest = JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
    const bytes = (suffix) => Uint8Array.from(readFileSync(join(directory, name + suffix))).buffer;
    const x = new Int8Array(bytes('.x.i8'));
    const y = new Float32Array(bytes('.y.f32'));
    assert.equal(manifest.rows, labelled.length);
    assert.equal(x.length, labelled.length * FEATURES);
    assert.equal(y.length, labelled.length * TARGETS);
    assert.deepEqual(Array.from(x.subarray(0, FEATURES)), Array.from(labelled[0].features));
    assert.deepEqual(Array.from(y.subarray(0, TARGETS)), labelled[0].targets);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
