import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowFor, promotion, COMPUTE } from '../tools/overnight-champion.mjs';
test('saved windows cannot restart their clock or pass the new cutoff', () => {
  const now = Date.parse('2026-11-12T05:00:00Z');
  const w = windowFor(null, 7, now);
  assert.equal(windowFor(w, 7, now + 1000), w);
  assert.throws(() => windowFor(w, 6, now));
  assert.throws(() => windowFor(w, 7, Date.parse(w.deadlineUTC)));
  assert.throws(() => windowFor({ ...w, deadlineUTC: '2026-11-12T13:00:00Z' }, 7, now));
  assert.equal(windowFor(null, 7, Date.parse('2026-11-12T12:00:00Z')).deadlineUTC, COMPUTE);
});
test('champion requires all games, positive primary and both non-regression checks', () => {
  const s = {
    completedRounds: 10000,
    completedPairs: 5000,
    reports: { 'head-to-head': { signedUpgradePoints: { mean: 0.09, ci: [0.01, 0.17] } } },
    secondaryContrasts: { 'vs-clint': { ci: [-0.09, 0.12] }, 'vs-p0': { ci: [-0.03, 0.04] } },
  };
  assert.equal(promotion(s).accepted, true);
  assert.equal(promotion({ ...s, completedRounds: 9998 }).accepted, false);
  s.secondaryContrasts['vs-p0'].ci[0] = -0.11;
  assert.equal(promotion(s).accepted, false);
  s.secondaryContrasts['vs-p0'].ci[0] = -0.03;
  s.reports['head-to-head'].signedUpgradePoints.ci[0] = 0;
  assert.equal(promotion(s).accepted, false);
});

import { actorSeedReader } from '../../danMCai/training/continuous/actor-seeds.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../danMCai/training/continuous/lib.mjs';
test('sparse reservations use indices, cannot exhaust or change silently; legacy unchanged', () => {
  assert.equal(actorSeedReader({}, 3)(42), 1150000042);
  const folder = mkdtempSync(join(tmpdir(), 'actor-roots-')),
    file = join(folder, 'seeds.json');
  try {
    writeFileSync(
      file,
      JSON.stringify({ seeds: [2000000001, 2000000029, 2000000051, 2000000061] }),
    );
    const config = { actorSeedList: { file, sha256: sha256(file), perSlot: 2 } };
    const read = actorSeedReader(config, 1);
    assert.equal(read(0), 2000000051);
    assert.equal(read(1), 2000000061);
    assert.throws(() => read(2));
    assert.throws(() => read(-1));
    writeFileSync(file, '{}');
    assert.throws(() => actorSeedReader(config, 1));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
