import test from 'node:test';
import assert from 'node:assert/strict';
import { improvementGate } from '../../publishing/endgame-release.mjs';
import { closeoutSnapshot } from '../../publishing/endgame-release.mjs';
import { mkdtempSync, writeFileSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('partial or failed windows still yield a factual closeout without publication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'endgame-closeout-'));
  try {
    assert.throws(() => closeoutSnapshot(dir, {}), /unfinished/);
    writeFileSync(join(dir, 'FINISHED'), JSON.stringify({ phase: 'partial' }));
    writeFileSync(
      join(dir, 'results.json'),
      JSON.stringify({ complete: false, completedPairs: { A: 12, B: 0, C: 0 } }),
    );
    const s = closeoutSnapshot(dir, { trainingDeadlineUTC: '2026-11-13T13:00:00Z' });
    assert.equal(s.acceptedForConditionalPublication, false);
    assert.equal(s.results.completedPairs.A, 12);
    assert.match(s.gateError, /not complete/);
    assert.equal(s.privateHandsOrReplayIncluded, false);
    writeFileSync(join(dir, 'FINISHED'), JSON.stringify({ phase: 'failed' }));
    writeFileSync(join(dir, 'failure.json'), JSON.stringify({ error: 'source audit failed' }));
    const failure = closeoutSnapshot(dir, {});
    assert.equal(failure.failure.error, 'source audit failed');
    assert.equal(failure.acceptedForConditionalPublication, false);
  } finally {
    for (const name of ['FINISHED', 'results.json', 'failure.json'])
      if (existsSync(join(dir, name))) unlinkSync(join(dir, name));
    rmdirSync(dir);
  }
});
test('conditional endgame release requires full paired groups and all strict positive lower bounds', () => {
  const rows = (v) => Array.from({ length: 3000 }, (_, seed) => ({ seed, mean: v }));
  assert.equal(improvementGate({ A: rows(1), B: rows(0), C: rows(0) }).accepted, true);
  for (const groups of [
    { A: rows(0), B: rows(-1), C: rows(-1) },
    { A: rows(1), B: rows(1), C: rows(0) },
    { A: rows(1), B: rows(0), C: rows(2) },
  ])
    assert.equal(improvementGate(groups).accepted, false);
  assert.throws(
    () => improvementGate({ A: rows(1).slice(1), B: rows(0), C: rows(0) }),
    /Incomplete/,
  );
  const duplicate = rows(0);
  duplicate[1].seed = 0;
  assert.throws(() => improvementGate({ A: rows(1), B: duplicate, C: rows(0) }), /duplicate/);
  const nan = rows(1);
  nan[0].mean = NaN;
  assert.throws(() => improvementGate({ A: nan, B: rows(0), C: rows(0) }), /Nonfinite/);
});
