import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runPretrial } from '../tools/run-belief-pretrial.mjs';

test('pretrial STOP exits before model loading or inference-worker creation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'belief-pretrial-stop-'));
  try {
    const bytes = JSON.stringify({ sourceSHA256: {}, sourceRoot: dir });
    writeFileSync(join(dir, 'protocol.json'), bytes);
    writeFileSync(
      join(dir, 'campaign-task.json'),
      JSON.stringify({
        protocolSHA256: createHash('sha256').update(bytes).digest('hex'),
        window: { deadlineUTC: new Date(Date.now() + 60000).toISOString() },
      }),
    );
    writeFileSync(join(dir, 'STOP'), '{}');
    const result = await runPretrial(dir);
    assert.equal(result.phase, 'stopped-before-spawn');
    assert.equal(result.completedPositions, 0);
    assert.equal(existsSync(join(dir, 'summary.json')), false);
    assert.equal(JSON.parse(readFileSync(join(dir, 'status.json'))).optimizerUpdates, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
