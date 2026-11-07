import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateRegistered } from '../tools/run-round-evaluation.mjs';

test('CLI enters the controller through canonical directory aliases rather than silently skipping', () => {
  const run = mkdtempSync(join(tmpdir(), 'danmcai-evaluation-cli-'));
  try {
    const script = fileURLToPath(
      new URL('../tools/run-round-evaluation.mjs', import.meta.url),
    ).replace(/ai[\\/]local[\\/]/, 'ai/danMCai/');
    const result = spawnSync(process.execPath, [script, `--run=${run}`], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unregistered or changed protocol/);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

test('registered STOP or fixed expiry prevents any worker spawn or inference', async () => {
  for (const expired of [true, false]) {
    const run = mkdtempSync(join(tmpdir(), 'danmcai-evaluation-stop-'));
    try {
      const bytes = JSON.stringify({
        evaluationDeadlineUTC: new Date(Date.now() + (expired ? -1000 : 60000)).toISOString(),
      });
      writeFileSync(join(run, 'protocol.json'), bytes);
      writeFileSync(
        join(run, 'campaign-task.json'),
        JSON.stringify({ protocolSHA256: createHash('sha256').update(bytes).digest('hex') }),
      );
      if (!expired) writeFileSync(join(run, 'STOP'), '{}');
      const result = await evaluateRegistered(run);
      assert.equal(result.completedRounds, 0);
      assert.equal(result.phase, 'stopped-before-spawn');
      assert.equal(existsSync(join(run, 'evaluation-controller.lock')), false);
      assert.equal(existsSync(join(run, 'status.json')), false);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }
});
