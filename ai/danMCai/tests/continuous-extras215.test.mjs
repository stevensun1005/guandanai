/**
 * 215-wide extras (53 public policy extras + 162 belief-v1 marginals) for the continuous trainer.
 *
 * The model-dependent checks need the champion 017 and belief v1 ONNX files (git-ignored caches)
 * and, for the wrapped initial model, either W3_WRAPPED_MODEL or a Python with torch and onnx
 * (DANMCAI_PYTHON); they skip when those are absent.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as ort from 'onnxruntime-node';
import { beliefMarginals, createBeliefModel } from '../belief/sampler.mjs';
import { createBatchedPool } from '../training/continuous/batch-inference.mjs';
import { playMatchWith } from '../training/continuous/fast-rollout.mjs';
import {
  BELIEF_MARGINALS,
  ShardWriter,
  createModelPool,
  extrasWidth,
} from '../training/continuous/lib.mjs';
import { cardIndex } from '../../../web/src/ai/encoding.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const firstExisting = (...files) => files.find((f) => f && existsSync(f)) ?? null;
const CHAMPION = firstExisting(
  process.env.W3_CHAMPION_MODEL,
  join(
    ROOT,
    'ai/publishing/cache/462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7.onnx',
  ),
  join(ROOT, 'web/dist/models/bot-017.onnx'),
);
const BELIEF = firstExisting(
  process.env.W3_BELIEF_MODEL,
  join(ROOT, 'ai/publishing/cache/belief-v1-16d76783.onnx'),
  join(ROOT, 'web/dist/models/belief-v1-16d76783.onnx'),
);

/** The mover's public view, as fast-actor.mjs builds it from a policy state. */
const viewOf = (state) => ({
  p: state.p,
  hand: state.hand,
  counts: state.counts,
  level: state.level,
  log: state.context.log.map((e) =>
    e.cards?.length
      ? { p: e.p, cards: e.cards.map((card) => card.id), type: e.type, value: e.value, n: e.n }
      : { p: e.p, cards: null },
  ),
});

/** Policy states with at least two candidates from rule-opponent matches (test-only seeds). */
async function positions(count) {
  const out = [];
  for (let seed = 2_991_500_000; out.length < count; seed++) {
    let k = 0;
    await playMatchWith({
      seed,
      team: seed % 2,
      mode: 'rule',
      decide: async (state) => {
        if (out.length < count && k++ % 3 === 0) out.push(state);
        return { index: (state.hand.length * 7 + state.log.length) % state.actions.length };
      },
    });
  }
  return out;
}

function wrappedModel(directory) {
  if (process.env.W3_WRAPPED_MODEL && existsSync(process.env.W3_WRAPPED_MODEL))
    return process.env.W3_WRAPPED_MODEL;
  const python = process.env.DANMCAI_PYTHON || 'python3';
  const out = join(directory, 'v000000000.onnx');
  const run = spawnSync(
    python,
    [
      join(ROOT, 'ai/danMCai/training/continuous/wrap_initial.py'),
      `--champion=${CHAMPION}`,
      `--out=${out}`,
      '--width=215',
    ],
    { encoding: 'utf8' },
  );
  return run.status === 0 ? out : null;
}

test('extras widths are registered per mode', () => {
  assert.equal(extrasWidth(null), 0);
  assert.equal(extrasWidth('public'), 53);
  assert.equal(extrasWidth('zero'), 53);
  assert.equal(extrasWidth('public-belief'), 215);
  assert.equal(BELIEF_MARGINALS, 162);
  assert.throws(() => extrasWidth('belief'));
});

test('a 215-wide shard round-trips and rejects rows of the wrong width', () => {
  const directory = mkdtempSync(join(tmpdir(), 'extras215-'));
  try {
    const writer = new ShardWriter(directory, 'a00', 0, 215);
    const rows = [0, 1, 2].map((i) => ({
      features: new Int8Array(567).fill(i % 2),
      extras: Float32Array.from({ length: 215 }, (_, j) => i * 1000 + j / 7),
      targets: [i - 1, 0, 0, 1],
    }));
    writer.add(rows, 'v000000000');
    const name = writer.flush({ extrasMode: 'public-belief', beliefSHA256: 'x' });
    const manifest = JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
    assert.equal(manifest.extraFeatures, 215);
    assert.equal(manifest.rows, 3);
    assert.equal(manifest.extrasMode, 'public-belief');
    const e = new Float32Array(
      new Uint8Array(readFileSync(join(directory, `${name}.e.f32`))).buffer,
    );
    assert.equal(e.length, 3 * 215);
    rows.forEach((row, i) => assert.deepEqual(e.subarray(i * 215, (i + 1) * 215), row.extras));
    const bad = new ShardWriter(directory, 'a01', 0, 215);
    bad.add([{ ...rows[0], extras: new Float32Array(53) }], 'v000000000');
    assert.throws(() => bad.flush(), /Invalid extras shard/);
    const legacy = new ShardWriter(directory, 'a02');
    legacy.add([{ ...rows[0], extras: new Float32Array(53) }], 'v000000000');
    const legacyName = legacy.flush();
    assert.equal(
      JSON.parse(readFileSync(join(directory, `${legacyName}.json`), 'utf8')).extraFeatures,
      53,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'beliefMarginals: 162 card-scale values, faces sum to unseen copies, seats to hand counts',
  { skip: !BELIEF && 'belief v1 ONNX not available' },
  async () => {
    const model = await createBeliefModel(ort, BELIEF);
    try {
      const states = await positions(60);
      const views = states.map(viewOf);
      const rows = await beliefMarginals(model, views);
      const single = await beliefMarginals(model, views[7]);
      assert.deepEqual(single, rows[7]);
      views.forEach((view, i) => {
        const m = rows[i];
        assert.equal(m.length, 162);
        assert.ok(m.every((v) => Number.isFinite(v) && v >= 0 && v <= 2 + 1e-5));
        const unseen = new Array(54).fill(2);
        for (const id of view.hand) unseen[cardIndex(id)]--;
        for (const e of view.log) for (const id of e.cards || []) unseen[cardIndex(id)]--;
        for (let f = 0; f < 54; f++)
          assert.ok(Math.abs(m[f * 3] + m[f * 3 + 1] + m[f * 3 + 2] - unseen[f]) < 1e-4);
        for (let r = 1; r <= 3; r++) {
          let total = 0;
          for (let f = 0; f < 54; f++) total += m[f * 3 + r - 1];
          assert.ok(Math.abs(total - view.counts[(view.p + r) % 4]) < 1e-3, `seat ${r}`);
        }
      });
    } finally {
      await model.close();
    }
  },
);

test(
  'wrapped initial (017 + zero 215x512 projection) equals 017 on 200 positions to 1e-5',
  { skip: !(CHAMPION && BELIEF) && 'champion 017 or belief v1 ONNX not available' },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'wrap215-'));
    const wrapped = wrappedModel(directory);
    if (!wrapped) {
      rmSync(directory, { recursive: true, force: true });
      return t.skip('no W3_WRAPPED_MODEL and no Python with torch/onnx (DANMCAI_PYTHON)');
    }
    const model = await createBeliefModel(ort, BELIEF);
    const plain = await createModelPool(ort, { threads: 1 });
    const batched = await createBatchedPool(ort, { provider: 'cpu' });
    try {
      const states = await positions(200);
      const marginals = await beliefMarginals(model, states.map(viewOf));
      const [expected, actual] = await Promise.all([
        Promise.all(states.map((s) => plain.values(CHAMPION, s))),
        Promise.all(
          states.map((s, i) => batched.values(wrapped, s, 'public-belief', marginals[i])),
        ),
      ]);
      let worst = 0,
        rows = 0;
      states.forEach((_, i) => {
        assert.equal(actual[i].length, expected[i].length);
        for (let j = 0; j < expected[i].length; j++) {
          worst = Math.max(worst, Math.abs(actual[i][j] - expected[i][j]));
          rows++;
        }
      });
      t.diagnostic(`max |wrapped - 017| = ${worst} over ${rows} candidate rows`);
      assert.ok(worst <= 1e-5, `max |wrapped - 017| = ${worst} over ${rows} rows`);
      assert.ok(batched.stats.rows >= rows);
    } finally {
      await batched.close();
      await plain.close();
      await model.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
