import test from 'node:test';
import assert from 'node:assert/strict';
import { improvementGate } from '../../publishing/endgame-release.mjs';
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
