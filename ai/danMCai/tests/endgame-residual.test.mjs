/**
 * The fused champion + endgame-residual ONNX keeps the champion I/O contract: the Node model pool
 * (the same feed as the browser) reproduces champion + residual computed in PyTorch, and a zero
 * residual reproduces the champion exactly.
 *
 * Needs a Python with torch, onnx and numpy (DANMCAI_PYTHON, the repository's mac environment, or
 * the main checkout's environment for a git worktree); skipped otherwise. The champion defaults to
 * the section-68 champion 017 when present (DANMCAI_CHAMPION overrides), else the baseline export.
 * Section-68 shard rows (DANMCAI_RESIDUAL_SHARD, a path prefix without extension) are added when
 * present; self-played candidate rows on reserved development seeds are always used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { advanceRound, createRound } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import {
  ACTION,
  FEATURES,
  STATE,
  argmax,
  createModelPool,
  encodeSample,
} from '../training/continuous/lib.mjs';

// Small reads come from Node's shared Buffer pool: copy exactly this file's bytes (byteOffset
// may be non-zero), not the whole pool.
const fileBytes = (path) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const EXPORT = join(REPO, 'ai/danMCai/training/continuous/residual_export.py');
const CHAMPION_017 =
  '/Users/stevensun/guandan-runtime.noindex/endgame-oracle-20261108-r2/models/champion.onnx';
const SHARD_68 = '/Users/stevensun/guandan-runtime.noindex/endgame-pimc-20261108/shards/s6-000000';
// Reserved development seeds for this builder's smoke tests (3,838,120,000-3,838,120,999).
const SEED = 3_838_120_100;

function findPython() {
  const candidates = [process.env.DANMCAI_PYTHON];
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  const roots = [REPO];
  if (common.status === 0) roots.push(dirname(common.stdout.trim()));
  for (const root of roots)
    candidates.push(
      join(root, 'ai/danMCai/environment/mac/bin/python'),
      join(root, 'ai/danMCai/environment/windows/Scripts/python.exe'),
    );
  for (const python of candidates.filter(Boolean)) {
    if (!existsSync(python)) continue;
    const probe = spawnSync(python, ['-c', 'import torch, onnx, numpy'], { timeout: 60_000 });
    if (probe.status === 0) return python;
  }
  return null;
}

function run(python, args) {
  const result = spawnSync(python, [EXPORT, ...args], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

/** Real candidate decisions from champion self-play: { state, x: Int8Array rows }. */
async function selfPlayDecisions(pool, champion, minimumRows) {
  const decisions = [];
  let rows = 0;
  for (let seed = SEED; rows < minimumRows; seed++) {
    const game = createRound(seed);
    for (let ply = 0; ply < 1000; ply++) {
      const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
      let index = 0;
      if (plays.length > 1) {
        const state = policyState(game, game.turn, 0, plays);
        index = argmax(await pool.values(champion, state));
        decisions.push({ state, x: state.actions.map((action) => encodeSample(state, action)) });
        rows += plays.length;
      }
      if (advanceRound(game, plays[index])) break;
    }
  }
  return decisions;
}

/** Shard rows grouped into decisions with the learner's rule (state change or after a pass). */
function shardDecisions(prefix, maximumRows) {
  const x = new Int8Array(readFileSync(`${prefix}.x.i8`)).subarray(0, maximumRows * FEATURES);
  const n = x.length / FEATURES;
  const row = (i) => x.subarray(i * FEATURES, (i + 1) * FEATURES);
  const isPass = (r) => r.subarray(STATE).every((v) => v === 0);
  const sameState = (a, b) => a.subarray(0, STATE).every((v, k) => v === b[k]);
  const groups = [];
  for (let i = 0; i < n; i++) {
    if (!i || isPass(row(i - 1)) || !sameState(row(i), row(i - 1))) groups.push([]);
    groups.at(-1).push(row(i));
  }
  groups.pop(); // the last group may be cut by maximumRows
  return groups;
}

async function runRaw(session, rows) {
  const state = Float32Array.from(rows[0].subarray(0, STATE));
  const actions = new Float32Array(rows.length * ACTION);
  rows.forEach((r, i) => actions.set(r.subarray(STATE), i * ACTION));
  const output = await session.run({
    state: new ort.Tensor('float32', state, [1, STATE]),
    actions: new ort.Tensor('float32', actions, [rows.length, ACTION]),
  });
  return Array.from(output.values.data);
}

test('fused champion + residual ONNX matches PyTorch and a zero residual is the champion', async (t) => {
  const python = findPython();
  if (!python) return t.skip('no Python with torch/onnx/numpy');
  t.diagnostic(`python ${python}`);
  const champion = resolve(
    process.env.DANMCAI_CHAMPION ||
      (existsSync(CHAMPION_017)
        ? CHAMPION_017
        : join(REPO, 'ai/danMCai/models/baseline/policy.onnx')),
  );
  const directory = mkdtempSync(join(tmpdir(), 'guandan-residual-'));
  const pool = await createModelPool(ort, { threads: 1, limit: 4 });
  try {
    const file = (name) => join(directory, name);
    run(python, [
      'random-residual',
      '--champion',
      champion,
      '--seed',
      '17',
      '--scale',
      '0.05',
      '--out',
      file('r.npz'),
    ]);
    run(python, ['zero-residual', '--champion', champion, '--out', file('z.npz')]);
    run(python, [
      'export',
      '--champion',
      champion,
      '--residual',
      file('r.npz'),
      '--out',
      file('fused.onnx'),
    ]);
    run(python, [
      'export',
      '--champion',
      champion,
      '--residual',
      file('z.npz'),
      '--out',
      file('zero.onnx'),
    ]);

    const played = await selfPlayDecisions(pool, champion, 200);
    const shardPrefix = process.env.DANMCAI_RESIDUAL_SHARD || SHARD_68;
    const shard = existsSync(`${shardPrefix}.x.i8`) ? shardDecisions(shardPrefix, 400) : [];
    const allRows = [...played.flatMap((d) => d.x), ...shard.flat()];
    const packed = new Int8Array(allRows.length * FEATURES);
    allRows.forEach((r, i) => packed.set(r, i * FEATURES));
    writeFileSync(file('rows.i8'), packed);
    run(python, [
      'reference',
      '--champion',
      champion,
      '--residual',
      file('r.npz'),
      '--rows',
      file('rows.i8'),
      '--out',
      file('ref.f32'),
    ]);
    const reference = new Float32Array(fileBytes(file('ref.f32')));
    assert.equal(reference.length, allRows.length);

    let at = 0,
      maxError = 0,
      moved = 0;
    const playedRows = played.reduce((s, d) => s + d.x.length, 0);
    assert.ok(playedRows >= 200, `only ${playedRows} self-play candidate rows`);
    for (const { state, x } of played) {
      const fused = await pool.values(file('fused.onnx'), state);
      const base = await pool.values(champion, state);
      assert.deepEqual(Array.from(await pool.values(file('zero.onnx'), state)), Array.from(base));
      fused.forEach((v, i) => {
        maxError = Math.max(maxError, Math.abs(v - reference[at + i]));
        moved = Math.max(moved, Math.abs(v - base[i]));
      });
      at += x.length;
    }
    assert.ok(maxError <= 1e-4, `pool vs torch max error ${maxError}`);
    t.diagnostic(
      `${playedRows} self-play rows via createModelPool: max |fused - torch| ${maxError}`,
    );
    assert.ok(moved > 1e-3, 'the random residual should change values');

    if (shard.length) {
      const sessions = Object.fromEntries(
        await Promise.all(
          ['fused.onnx', 'zero.onnx'].map(async (n) => [
            n,
            await ort.InferenceSession.create(file(n)),
          ]),
        ),
      );
      sessions.champion = await ort.InferenceSession.create(champion);
      const shardRows = shard.reduce((s, g) => s + g.length, 0);
      assert.ok(shardRows >= 200, `only ${shardRows} shard rows`);
      let shardError = 0;
      for (const rows of shard) {
        const fused = await runRaw(sessions['fused.onnx'], rows);
        assert.deepEqual(
          await runRaw(sessions['zero.onnx'], rows),
          await runRaw(sessions.champion, rows),
        );
        fused.forEach(
          (v, i) => (shardError = Math.max(shardError, Math.abs(v - reference[at + i]))),
        );
        at += rows.length;
      }
      assert.ok(shardError <= 1e-4, `shard rows vs torch max error ${shardError}`);
      t.diagnostic(`${shardRows} section-68 shard rows: max |fused - torch| ${shardError}`);
      for (const s of Object.values(sessions)) await s.release();
    } else t.diagnostic('section-68 shard not present; self-play rows only');
    assert.equal(at, allRows.length);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
