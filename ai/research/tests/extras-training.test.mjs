import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ShardWriter, labelMatch } from '../../danMCai/training/continuous/lib.mjs';
import { trainControlled } from '../tools/run-controlled-training.mjs';

test('extras sidecars preserve float rows and only terminal round points are the primary target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extras-shard-'));
  try {
    const e = new Float32Array(53).fill(1 / 3),
      x = new Int8Array(567);
    const rows = labelMatch([{ features: x, extras: e, team: 1, round: 1 }], {
      winner: 0,
      history: [{ round: 1, team: 1, up: 3 }],
    });
    assert.deepEqual(rows[0].targets, [3, -1, 0, 1]);
    const writer = new ShardWriter(dir, 'test');
    writer.add(rows, 'v0');
    const name = writer.flush();
    assert.equal(JSON.parse(readFileSync(join(dir, `${name}.json`))).extraFeatures, 53);
    const bytes = readFileSync(join(dir, `${name}.e.f32`));
    assert.equal(bytes.length, 212);
    assert.equal(bytes.readFloatLE(0), e[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registered input training respects STOP before touching configuration or spawning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'extras-train-stop-'));
  try {
    const bytes = JSON.stringify({ deadlineUTC: '2026-11-11T14:45:00Z' });
    writeFileSync(join(dir, 'protocol.json'), bytes);
    writeFileSync(
      join(dir, 'campaign-task.json'),
      JSON.stringify({
        protocolSHA256: createHash('sha256').update(bytes).digest('hex'),
        window: { deadlineUTC: '2026-11-11T14:45:00Z' },
      }),
    );
    writeFileSync(join(dir, 'STOP'), '{}');
    assert.equal((await trainControlled(dir)).optimizerUpdates, 0);
    assert.equal(existsSync(join(dir, 'registered-training.lock')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
