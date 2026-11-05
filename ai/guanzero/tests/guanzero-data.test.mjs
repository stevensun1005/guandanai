import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TRAIN_SEED_BASE,
  TRAIN_SEED_SPAN,
  GATE_SEED_BASE,
  ANCHOR_SEED_BASE,
} from '../../local/training/continuous/lib.mjs';
import { trainSeed, evalSeed, labels, writeShard, FEATURES } from '../training/lib.mjs';
test('GuanZero seed blocks avoid development, main starts, and evaluation', () => {
  for (let slot = 0; slot < 40; slot++) {
    assert.equal(trainSeed(slot, 0), TRAIN_SEED_BASE + slot * TRAIN_SEED_SPAN + 30_000_000);
    assert.ok(trainSeed(slot, 0) > TRAIN_SEED_BASE + slot * TRAIN_SEED_SPAN + 1_000_000);
    assert.ok(trainSeed(slot, 19_999_999) < TRAIN_SEED_BASE + (slot + 1) * TRAIN_SEED_SPAN);
    assert.ok(trainSeed(slot, 19_999_999) < GATE_SEED_BASE);
  }
  assert.ok(evalSeed(0) > ANCHOR_SEED_BASE);
  assert.ok(evalSeed(0) > GATE_SEED_BASE);
  assert.equal(evalSeed(1) - evalSeed(0), 100_000);
  assert.throws(() => trainSeed(0, 20_000_000));
  assert.throws(() => trainSeed(40, 0));
  assert.throws(() => evalSeed(6000));
});
test('GuanZero labels are per round ADP and WP, independent of match winner', () => {
  const rows = [
    { team: 0, round: 1 },
    { team: 1, round: 1 },
    { team: 0, round: 2 },
    { team: 1, round: 2 },
  ];
  const result = {
    winner: 1,
    history: [
      { round: 1, team: 0, up: 3 },
      { round: 2, team: 1, up: 1 },
    ],
  };
  assert.deepEqual(
    labels(rows, result).map((r) => r.targets),
    [
      [3, 1],
      [-3, -1],
      [-1, -1],
      [1, 1],
    ],
  );
  assert.throws(() => labels([{ round: 3 }], result));
});
test('GuanZero manifest publishes complete int8 features and little endian targets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'guanzero-'));
  try {
    const features = Int8Array.from({ length: FEATURES }, (_, i) => (i % 4) - 1);
    const name = writeShard(
      directory,
      [
        { features, targets: [-3, -1] },
        { features, targets: [2, 1] },
      ],
      { slot: 3 },
    );
    const manifest = JSON.parse(readFileSync(join(directory, name + '.json')));
    assert.equal(manifest.rows, 2);
    assert.equal(manifest.features, FEATURES);
    const x = readFileSync(join(directory, name + '.x.i8')),
      y = readFileSync(join(directory, name + '.y.f32'));
    assert.equal(x.length, FEATURES * 2);
    assert.deepEqual(new Int8Array(x.buffer, x.byteOffset, FEATURES), features);
    assert.deepEqual(
      [0, 4, 8, 12].map((i) => y.readFloatLE(i)),
      [-3, -1, 2, 1],
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});
