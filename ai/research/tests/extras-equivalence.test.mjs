import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runEquivalence } from '../tools/run-extras-equivalence.mjs';
import { continuation } from '../../shared/tribute/neural.mjs';

test('extras compatibility STOP prevents opening models, Python, browsers or optimizer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'extras-stop-'));
  try {
    const bytes = JSON.stringify({});
    writeFileSync(join(dir, 'protocol.json'), bytes);
    writeFileSync(
      join(dir, 'campaign-task.json'),
      JSON.stringify({
        protocolSHA256: createHash('sha256').update(bytes).digest('hex'),
        window: { deadlineUTC: new Date(Date.now() + 60000).toISOString() },
      }),
    );
    writeFileSync(join(dir, 'STOP'), '{}');
    const result = await runEquivalence(dir);
    assert.equal(result.phase, 'stopped-before-spawn');
    assert.equal(result.completedPositions, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'status.json'))).optimizerUpdates, 0);
    assert.equal(existsSync(join(dir, 'summary.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tribute rejects extras before reading a model or creating any inference session', async () => {
  await assert.rejects(
    continuation('/missing-model', { config: { extraFeatures: 53 } }),
    /Unsupported continuation configuration/,
  );
});
