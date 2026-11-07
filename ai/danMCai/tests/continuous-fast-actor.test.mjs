import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as ort from 'onnxruntime-node';
import { candidates } from '../../../web/src/ai/candidates.js';
import { playMatch } from '../../shared/simulation/match-rollout.mjs';
import { advanceRound, createRound, seededRandom } from '../../shared/simulation/simulation.mjs';
import { createBatchedPool } from '../training/continuous/batch-inference.mjs';
import { createCandidateCache } from '../training/continuous/fast-candidates.mjs';
import { playMatchWith } from '../training/continuous/fast-rollout.mjs';
import {
  DEFAULT_CONFIG,
  createModelPool,
  ensureDirs,
  runPaths,
  writeJSON,
} from '../training/continuous/lib.mjs';
import { rowsModel } from '../training/continuous/onnx-rows.mjs';

const signature = (plays) =>
  plays
    .map((p) =>
      p ? `${p.type}:${p.value}:${p.n}:${p.wu}:${p.cards.map((c) => c.id).join('.')}` : '-',
    )
    .join('|');

test('cached candidates equal the original generator, including order and pass', () => {
  const cache = createCandidateCache();
  let checked = 0;
  for (let r = 0; r < 25; r++) {
    const game = createRound(2_990_000_000 + r),
      random = seededRandom(r);
    for (let turn = 0; turn < 1000; turn++) {
      const p = game.turn;
      const original = candidates(game.hands[p], game.L, game.trick?.play);
      assert.equal(
        signature(cache.candidates(game.hands[p], game.L, game.trick?.play)),
        signature(original),
      );
      checked++;
      if (advanceRound(game, original[Math.floor(random() * original.length)])) break;
    }
  }
  assert.ok(checked > 1000 && cache.stats.hits > 0);
});

test('the fast rollout copy plays exactly the same matches as the frozen rollout', async () => {
  const decide = async (state) => ({
    index: (state.hand.reduce((a, b) => a + b, 0) + 7 * state.log.length) % state.actions.length,
  });
  for (const [seed, mode] of [
    [2_990_100_000, 'self'],
    [2_990_100_001, 'rule'],
  ]) {
    const a = await playMatch({ seed, team: 1, mode, decide });
    const b = await playMatchWith({
      seed,
      team: 1,
      mode,
      decide,
      candidates: createCandidateCache().candidates,
    });
    assert.deepEqual(b, a);
  }
});

test('the per-row model copy reproduces the deployed graph on mixed decisions', async () => {
  const positions = JSON.parse(readFileSync('ai/shared/fixtures/positions.json', 'utf8')).slice(
    0,
    40,
  );
  const reference = await createModelPool(ort);
  const pool = await createBatchedPool(ort, { provider: 'cpu', batchDecisions: 7 });
  try {
    const batched = await Promise.all(
      positions.map((s) => pool.values('ai/danMCai/models/baseline/policy.onnx', s)),
    );
    for (const [i, state] of positions.entries()) {
      const expected = await reference.values('ai/danMCai/models/baseline/policy.onnx', state);
      assert.equal(batched[i].length, expected.length);
      for (let k = 0; k < expected.length; k++)
        assert.ok(Math.abs(batched[i][k] - expected[k]) < 1e-5);
    }
    assert.equal(pool.stats.provider, 'cpu');
    assert.equal(pool.stats.decisions, positions.length);
    assert.ok(pool.stats.batches >= Math.ceil(positions.length / 7));
  } finally {
    await reference.close();
    await pool.close();
  }
  assert.throws(() => rowsModel(new Uint8Array([0x0a, 0x00])), /P0-layout/);
});

test('concurrent model requests release evicted sessions before opening another one', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'guandan-session-cap-'));
  const pool = await createBatchedPool(ort, {
    provider: 'cpu',
    sessionLimit: 2,
    maxRows: 3,
    batchDecisions: 1,
  });
  try {
    const state = JSON.parse(readFileSync('ai/shared/fixtures/positions.json', 'utf8'))[0];
    const models = ['a', 'b', 'c'].map((name) => join(directory, name + '.onnx'));
    for (const file of models) copyFileSync('ai/danMCai/models/baseline/policy.onnx', file);
    const values = await Promise.all(models.map((file) => pool.values(file, state)));
    assert.deepEqual([...values[0]], [...values[1]]);
    assert.deepEqual([...values[0]], [...values[2]]);
    assert.equal(pool.stats.peakSessions, 2);
    assert.equal(pool.stats.sessionCount, 2);
    assert.equal(pool.stats.sessionsReleased, 1);
    await pool.values(models[0], state);
    assert.equal(pool.stats.sessionsReleased, 2);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a fast actor writes standard shards and status that record its implementation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'guandan-fast-'));
  try {
    const paths = runPaths(directory);
    ensureDirs(paths);
    writeJSON(paths.config, { ...DEFAULT_CONFIG, actorSeedOffset: 45_000_000 });
    copyFileSync('ai/danMCai/models/baseline/policy.onnx', join(paths.models, 'v000000000.onnx'));
    writeJSON(paths.latest, { version: 'v000000000', file: 'v000000000.onnx', step: 0 });
    writeJSON(paths.leagueMeta, { members: [], stats: {} });
    const result = spawnSync(
      process.execPath,
      [
        'ai/danMCai/training/continuous/fast-actor.mjs',
        `--run=${directory}`,
        '--slot=39',
        '--games=1',
        '--matches=1',
        '--provider=cpu',
        '--session-limit=12',
      ],
      // Generous limit: the suite may run while training saturates the CPU.
      { encoding: 'utf8', timeout: 600_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(readFileSync(join(paths.actors, 'actor-39.json'), 'utf8'));
    assert.equal(status.actorImplementation, 'fast');
    assert.equal(status.sessionLimit, 12);
    assert.equal(status.matches, 1);
    assert.equal(status.nextSeed, 45_000_001);
    const manifests = readdirSync(paths.shards).filter((f) => f.endsWith('.json'));
    const rows = manifests.reduce(
      (n, f) => n + JSON.parse(readFileSync(join(paths.shards, f), 'utf8')).rows,
      0,
    );
    assert.equal(rows, status.rows);
    const manifest = JSON.parse(readFileSync(join(paths.shards, manifests[0]), 'utf8'));
    assert.equal(manifest.actorImplementation, 'fast');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
