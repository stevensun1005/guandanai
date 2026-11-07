import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { sha256, writeJSON } from '../../danMCai/training/continuous/lib.mjs';

test('registered sampling probe respects STOP before launching any actor', () => {
  const run = mkdtempSync(join(tmpdir(), 'cache-sampling-stop-'));
  try {
    mkdirSync(join(run, 'league'));
    writeJSON(join(run, 'config.json'), {});
    writeJSON(join(run, 'league/league.json'), {});
    const protocol = join(run, 'protocol.json');
    writeJSON(protocol, {
      sourceSHA256: {},
      weights: [],
      plannedMatches: 4,
      actors: 4,
      matchesPerActor: 1,
      phases: [
        {
          run,
          sessionLimit: 6,
          configSHA256: sha256(join(run, 'config.json')),
          leagueSHA256: sha256(join(run, 'league/league.json')),
        },
      ],
    });
    writeJSON(join(run, 'campaign-task.json'), {
      protocolSHA256: sha256(protocol),
      window: { deadlineUTC: new Date(Date.now() + 60000).toISOString() },
    });
    writeFileSync(join(run, 'STOP'), 'test');
    const result = spawnSync(
      process.execPath,
      [
        resolve('ai/research/tools/benchmark-cache-sampling.mjs'),
        `--run=${run}`,
        `--protocol=${protocol}`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 2, result.stderr);
    const summary = JSON.parse(readFileSync(join(run, 'summary.json'), 'utf8'));
    assert.equal(summary.phase, 'stopped');
    assert.equal(summary.completedMatches, 0);
    assert.equal(summary.optimizerUpdates, 0);
    assert.deepEqual(summary.phases, []);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
