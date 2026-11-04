import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { playMatch } from '../scripts/lib/match-rollout.mjs';
import {
  FEATURES,
  DEFAULT_CONFIG,
  GATE_SEED_BASE,
  ANCHOR_SEED_BASE,
  ANCHOR_SEED_LIMIT,
  PROBE_SEED_BASE,
  TARGETS,
  TRAIN_SEED_BASE,
  ShardWriter,
  argmax,
  anchorRegression,
  createModelPool,
  encodeSample,
  ensureDirs,
  explore,
  evaluationSeedStart,
  labelMatch,
  pfspWeights,
  pairedScoreSummary,
  runPaths,
  sprt,
  writeJSON,
} from '../scripts/continuous/lib.mjs';

test('training and gate seeds never enter the study evaluation range', () => {
  assert.ok(TRAIN_SEED_BASE >= 1e9);
  assert.ok(GATE_SEED_BASE >= TRAIN_SEED_BASE + 40 * 50_000_000);
});

test('an isolated run starts at its reserved training offset and resumes the next unused seed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'guandan-seed-offset-'));
  const paths = runPaths(directory);
  ensureDirs(paths);
  writeJSON(paths.config, { ...DEFAULT_CONFIG, actors: 1, actorSeedOffset: 1_000_000 });
  copyFileSync('ai/policy.onnx', join(paths.models, 'initial.onnx'));
  writeJSON(paths.latest, { version: 'initial', file: 'initial.onnx' });
  writeJSON(paths.leagueMeta, { members: [], stats: {} });
  try {
    for (const matches of [1, 2]) {
      const child = spawnSync(
        process.execPath,
        ['scripts/continuous/actor.mjs', `--run=${directory}`, `--matches=${matches}`],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          windowsHide: true,
          timeout: 20_000,
        },
      );
      assert.equal(child.status, 0, child.stderr.toString());
    }
    const rows = readFileSync(join(paths.actors, 'results-0.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(
      rows.map((r) => r.seed),
      [1_001_000_000, 1_001_000_001],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('gate and anchor blocks are disjoint and never wrap into another purpose', () => {
  assert(PROBE_SEED_BASE < GATE_SEED_BASE);
  assert.equal(evaluationSeedStart('gate', 0, 150), GATE_SEED_BASE);
  assert.equal(evaluationSeedStart('anchor', 0, 150), ANCHOR_SEED_BASE);
  assert(evaluationSeedStart('gate', 999, 150) + 100_000 <= ANCHOR_SEED_BASE);
  assert(evaluationSeedStart('anchor', 999, 150) + 100_000 <= ANCHOR_SEED_LIMIT);
  for (const kind of ['gate', 'anchor']) {
    assert.throws(() => evaluationSeedStart(kind, 1000, 150), /exhausted/);
    assert.throws(() => evaluationSeedStart(kind, -1, 150));
  }
});

test('anchor stop needs two complete 150-pair regressions and resets on recovery or interruption', () => {
  const pairs = Array.from({ length: 150 }, (_, i) => ({
    seed: ANCHOR_SEED_BASE + i,
    scores: [0, 0],
  }));
  const report = { kind: 'anchor', status: 'complete', pairs };
  const summary = pairedScoreSummary(pairs);
  assert.equal(summary.meanScore, 0);
  assert(summary.clusterHoeffding95CI[1] > 0 && summary.clusterHoeffding95CI[1] < 0.5);
  assert.deepEqual(anchorRegression(0, report), { streak: 1, stop: false });
  assert.deepEqual(anchorRegression(1, report), { streak: 2, stop: true });
  assert.deepEqual(anchorRegression(1, { ...report, status: 'stopped' }), {
    streak: 0,
    stop: false,
  });
  assert.deepEqual(anchorRegression(1, { ...report, pairs: pairs.slice(0, 2) }), {
    streak: 0,
    stop: false,
  });
  assert.deepEqual(
    anchorRegression(1, { ...report, pairs: pairs.map((p) => ({ ...p, scores: [1, 1] })) }),
    { streak: 0, stop: false },
  );
  assert.throws(() => pairedScoreSummary([{ seed: 1, scores: [0] }]));
  assert.throws(() => pairedScoreSummary([pairs[0], pairs[0]]));
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

test('STOP before the first polling tick shuts down without restarting finished children', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'guandan-stop-'));
  const child = spawn(
    process.execPath,
    ['scripts/continuous/supervisor.mjs', `--run=${directory}`, '--config={"actors":1}'],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true },
  );
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => (errors += chunk));
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.includes('"kind":"start"')) writeFileSync(join(directory, 'STOP'), '{}');
  });
  const timeout = setTimeout(() => child.kill(), 25_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on('exit', resolve);
      child.on('error', reject);
    });
    assert.equal(code, 0, errors || output);
    const events = readFileSync(join(directory, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert(!events.some((event) => event.kind === 'process-exit'), output);
    const status = JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'));
    assert.equal(status.stopReason, 'operator-stop');
    assert.deepEqual(status.running, []);
  } finally {
    clearTimeout(timeout);
    rmSync(directory, { recursive: true, force: true });
  }
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
