import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { parseRecordText, readSavedRecord } from '../src/replay/record-schema.js';

const deck = makeDeck();
const record = () => ({
  no: 1,
  L: 2,
  uid: 'round-1',
  hands: [
    deck.slice(0, 27).map((card) => card.id),
    deck.slice(27, 54).map((card) => card.id),
    deck.slice(54, 81).map((card) => card.id),
    deck.slice(81).map((card) => card.id),
  ],
  nk: 'all',
  notes: { 1: '<b>保留对子</b>' },
  log: [{ p: 0, c: [3], type: 'single', value: 5, n: 99 }],
});
test('portable records normalize play shape, preserve plain-text notes and avoid unknown properties', () => {
  const input = record();
  input.unexpected = { script: 'evil' };
  const clean = readSavedRecord(input);
  assert.equal(clean.log[0].n, 1);
  assert.equal(clean.notes[1], '<b>保留对子</b>');
  assert.equal(clean.unexpected, undefined);
  assert.equal(clean.schemaVersion, 1);
  assert.deepEqual(readSavedRecord(clean), clean);
});
test('duplicate physical cards, foreign cards, repeated plays and invalid shapes are rejected', () => {
  for (const mutate of [
    (input) => input.hands[1].push(input.hands[0][0]),
    (input) => (input.hands[0][0] = '0'),
    (input) => (input.log[0].c = [100]),
    (input) => (input.log[0].c = [3, 3]),
    (input) => input.log.push(input.log[0]),
    (input) => (input.log[0].type = 'bomb'),
    (input) => (input.log[0].p = 4),
  ]) {
    const input = record();
    mutate(input);
    assert.throws(() => readSavedRecord(input));
  }
});
test('legacy note numbering migrates past pass entries and grouping always keeps every card', () => {
  const input = record();
  delete input.nk;
  delete input.uid;
  input.log.unshift({ p: 1, c: null });
  input.notes = { 0: '开局', 1: '第一手出牌' };
  input.myGroups = [[0, 0, 999]];
  const clean = readSavedRecord(input);
  assert.equal(clean.notes[2], '第一手出牌');
  assert.equal(clean.notes[1], undefined);
  assert(clean.uid.startsWith('legacy-'));
  assert.deepEqual(
    clean.myGroups.flat().sort((a, b) => a - b),
    input.hands[0],
  );
});
test('text import separates damaged rounds and bounds file and batch sizes', () => {
  const source = '复盘说明\n#DATA ' + JSON.stringify([record(), null, { L: 99 }]);
  const parsed = parseRecordText(source);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.rejected, 2);
  assert.throws(() => parseRecordText('not a record'));
  assert.throws(() => parseRecordText('#DATA ' + JSON.stringify(Array(201).fill(record()))));
  assert.throws(() => parseRecordText('中'.repeat(3 * 1024 * 1024)));
});
