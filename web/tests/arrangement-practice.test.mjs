import assert from 'node:assert/strict';
import test from 'node:test';
import { editGroups, readArrangementRecord } from '../src/practice/groups.mjs';

const base = [[0, 54], [1], [55, 56]];
const options = {
  auto: (ids) => ids.map((id) => [id]),
  tidy: (ids) => ids,
  order: (groups) => groups,
};
test('manual regroup, split and join keep both physical copies and every remaining card', () => {
  assert.deepEqual(editGroups(base, [0, 1], { ...options, mode: 'group' }), [
    [55, 56],
    [54],
    [0, 1],
  ]);
  assert.deepEqual(editGroups(base, [0, 54], { ...options, mode: 'split' }), [
    [1],
    [55, 56],
    [0],
    [54],
  ]);
  assert.deepEqual(editGroups(base, [0], { ...options, mode: 'join', to: 2 }), [
    [1],
    [54],
    [55, 56, 0],
  ]);
  assert.deepEqual(base, [[0, 54], [1], [55, 56]]);
  assert.throws(() => editGroups(base, [108], { ...options, mode: 'split' }));
  assert.throws(() => editGroups(base, [0], { ...options, mode: 'join', to: 99 }));
  assert.throws(() => editGroups(base, [0, 1], { ...options, mode: 'group', auto: () => [] }));
});

test('saved exercise records require complete partitions and cannot impersonate unassisted data', () => {
  const hand = Array.from({ length: 27 }, (_, i) => i);
  const record = {
    schema: 1,
    uid: 'exercise-1',
    at: '2026-11-07T15:00:00Z',
    deal: 1,
    L: 2,
    seat: 1,
    hand,
    comp: hand.map((id) => [id]),
    mine: [hand.slice()],
    compPower: 45,
    minePower: 30,
    assisted: false,
    same: true,
  };
  const read = readArrangementRecord(record);
  assert.equal(read.assisted, true);
  assert.equal(read.source, 'unverified_browser');
  assert.equal(read.same, false);
  assert.equal(read.only.mine.length, 1);
  assert.throws(() => readArrangementRecord({ ...record, mine: [Array(27).fill(0)] }));
  assert.throws(() => readArrangementRecord({ ...record, compPower: NaN }));
  assert.throws(() => readArrangementRecord({ ...record, L: 20 }));
  assert.throws(() => readArrangementRecord({ ...record, kind: 'human-unassisted' }));
  assert.throws(() => readArrangementRecord(null));
});
