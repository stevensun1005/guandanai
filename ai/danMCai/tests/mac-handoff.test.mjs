import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareMac,
  remainingHours,
  MAC_SEEDS,
  claimMacLock,
} from '../training/continuous/mac-24h.mjs';
import { DEFAULT_CONFIG, readJSON, writeJSON } from '../training/continuous/lib.mjs';
import { sourceHashes } from '../training/continuous/sources.mjs';

test('Mac preparation preserves imported state, separates counters/seeds and avoids shard collisions', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'danMCai-mac-'));
  try {
    const snapshot = join(temporary, 'snapshot'),
      source = join(snapshot, 'windows-gpu-main');
    for (const d of ['models', 'champion', 'league', 'shards', 'actors', 'learner'])
      mkdirSync(join(source, d), { recursive: true });
    writeJSON(join(source, 'config.json'), structuredClone(DEFAULT_CONFIG));
    writeJSON(join(source, 'status.json'), {
      stoppedAt: '2026-11-05T20:41:22Z',
      gateIndex: 126,
      anchorIndex: 107,
    });
    writeJSON(join(snapshot, 'manifest.json'), {
      latest: { version: 'v000682654' },
      champion: { version: 'v000293055' },
    });
    writeJSON(join(source, 'actors/actor-0.json'), {
      nextSeed: 1000800,
      shardSequence: 9,
      matches: 999,
    });
    writeFileSync(join(source, 'shards/a00-000000010.json'), '{}');
    writeFileSync(join(source, 'learner/checkpoint.pt'), 'unchanged optimizer checkpoint fixture');
    const baseline = readFileSync(new URL('../models/baseline/policy.onnx', import.meta.url));
    writeFileSync(join(source, 'models/anchor.onnx'), baseline);
    const before = readFileSync(join(source, 'config.json'));
    const run = join(temporary, 'mac');
    prepareMac(snapshot, run);
    assert.deepEqual(
      readFileSync(join(run, 'learner/checkpoint.pt')),
      readFileSync(join(source, 'learner/checkpoint.pt')),
    );
    assert.deepEqual(readFileSync(join(source, 'config.json')), before);
    const config = readJSON(join(run, 'config.json'));
    assert.equal(config.learner.device, 'mps');
    assert.equal(config.learner.targetMatchWeight, DEFAULT_CONFIG.learner.targetMatchWeight);
    assert.deepEqual(config.sourceSHA256, sourceHashes());
    assert.equal(config.actorSeedOffset, MAC_SEEDS.actorSeedOffset);
    assert.equal(readJSON(join(run, 'actors/actor-0.json')).shardSequence, 11);
    assert.equal(readJSON(join(run, 'actors/actor-0.json')).matches, undefined);
    assert.equal(readJSON(join(run, 'status.json')).elapsedSeconds, 0);
    assert.equal(readJSON(join(run, 'status.json')).gateIndex, 300);
    assert.throws(() => prepareMac(snapshot, run), /new/);
    writeJSON(join(source, 'actors/actor-0.json'), { nextSeed: 3000000 });
    assert.throws(() => prepareMac(snapshot, join(temporary, 'conflict')), /seed reservation/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('one Mac window lasts 24h, resumes only remaining time and cannot renew itself', () => {
  const schedule = { startUTC: '2026-11-05T23:00:00Z', deadlineUTC: '2026-11-06T23:00:00Z' };
  assert.equal(remainingHours(schedule, Date.parse(schedule.startUTC)), 24);
  assert.equal(remainingHours(schedule, Date.parse('2026-11-06T19:00:00Z')), 4);
  assert.equal(remainingHours(schedule, Date.parse('2026-11-07T00:00:00Z')), 0);
  assert.equal(schedule.deadlineUTC, '2026-11-06T23:00:00Z');
  assert.throws(
    () => remainingHours({ startUTC: schedule.startUTC, deadlineUTC: 'invalid' }),
    /Invalid/,
  );
});

test('a second Mac launcher cannot share a live run', () => {
  const run = mkdtempSync(join(tmpdir(), 'danMCai-mac-lock-'));
  try {
    const release = claimMacLock(run);
    assert.throws(() => claimMacLock(run), /already running/);
    release();
    claimMacLock(run)();
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
