import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedLineup } from '../evaluation/evaluate-fixed.mjs';

test('fixed evaluation routes both teammates to the same model and swaps the whole team', async () => {
  const calls = [],
    champion = { decide: (_, p, style) => calls.push(['champion', p, style]) },
    latest = { decide: (_, p, style) => calls.push(['latest', p, style]) };
  for (const team of [0, 1]) {
    calls.length = 0;
    const options = fixedLineup('latest-model', team, champion, latest);
    assert.equal(options.mode, 'self');
    assert.equal(options.evaluate, true);
    for (let p = 0; p < 4; p++) await options.tablePolicy({}, p);
    assert.deepEqual(
      calls.map(([name, p]) => [name, p]),
      [0, 1, 2, 3].map((p) => [p % 2 === team ? 'champion' : 'latest', p]),
    );
  }
});
test('Clint comparison uses rules-v2 and forbids substituting a neural policy for rule seats', () => {
  const options = fixedLineup('clint-rule', 0, { decide: () => 'champion' });
  assert.equal(options.mode, 'rule');
  assert.equal(options.ruleVersion, 'rules-v2');
  assert.equal(options.tablePolicy({}, 0), 'champion');
  assert.throws(() => options.tablePolicy({}, 1));
  assert.throws(() => fixedLineup('original-rule', 0, {}));
});
