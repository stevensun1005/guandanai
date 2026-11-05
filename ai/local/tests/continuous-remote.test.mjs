import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  actorTotals,
  localSourceHashes,
  parseSlots,
  sourceMismatches,
} from '../training/continuous/remote.mjs';

test('slot lists accept ranges and single slots, and reject malformed input', () => {
  assert.deepEqual(parseSlots('8-11'), [8, 9, 10, 11]);
  assert.deepEqual(parseSlots('12, 9,9-10'), [9, 10, 12]);
  assert.throws(() => parseSlots('5-3'));
  assert.throws(() => parseSlots('a'));
});

test('a checkout is accepted only when every frozen source matches', () => {
  const files = ['ai/local/training/continuous/actor.mjs', 'web/src/ai/encoding.mjs'];
  const config = { sourceSHA256: localSourceHashes(files) };
  assert.deepEqual(sourceMismatches(config), []);
  config.sourceSHA256['web/src/ai/encoding.mjs'] = '0'.repeat(64);
  assert.deepEqual(sourceMismatches(config), ['web/src/ai/encoding.mjs']);
  config.sourceSHA256['ai/local/training/missing.mjs'] = '0'.repeat(64);
  assert.ok(sourceMismatches(config).includes('ai/local/training/missing.mjs'));
  assert.equal(sourceMismatches({}).length, 1);
});

test('totals count every actor slot, including remote ones, and skip unreadable files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'guandan-actors-'));
  try {
    mkdirSync(join(directory, 'actors'));
    const write = (name, value) => writeFileSync(join(directory, 'actors', name), value);
    write('actor-0.json', JSON.stringify({ matches: 3, decisions: 30, rows: 30 }));
    write('actor-12.json', JSON.stringify({ matches: 2, decisions: 20, rows: 20 }));
    write('actor-13.json', '{"matches":');
    write('claim-12.json', JSON.stringify({ slot: 12, host: 'laptop' }));
    assert.deepEqual(actorTotals(join(directory, 'actors')), {
      matches: 5,
      decisions: 50,
      rows: 50,
      slots: [0, 12],
    });
    assert.deepEqual(actorTotals(join(directory, 'missing')).slots, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
