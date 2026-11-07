import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { trainRegistered } from '../tools/run-registered-training.mjs';

test('registered training refuses expired or STOP tasks before models, config, clocks or spawn', async () => {
  for (const stop of [true, false]) {
    const run = mkdtempSync(join(tmpdir(), 'registered-stop-'));
    try {
      const protocol = '{}';
      writeFileSync(join(run, 'protocol.json'), protocol);
      writeFileSync(
        join(run, 'campaign-task.json'),
        JSON.stringify({
          protocolSHA256: createHash('sha256').update(protocol).digest('hex'),
          window: { deadlineUTC: new Date(Date.now() + (stop ? 60000 : -1)).toISOString() },
        }),
      );
      if (stop) writeFileSync(join(run, 'STOP'), '{}');
      assert.equal((await trainRegistered(run)).phase, 'stopped-before-spawn');
      assert.equal(existsSync(join(run, 'status.json')), false);
      assert.equal(existsSync(join(run, 'registered-launch.json')), false);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }
});
