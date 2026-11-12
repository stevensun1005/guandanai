import test from 'node:test';
import assert from 'node:assert/strict';
import { prepMs, playMs, turnClock, clockShown, commitReserve } from '../src/core/table-timing.mjs';
import { hardLeft, clintBrainMs } from '../src/ai/turn-timing.mjs';
import { rotateSnapshot } from '../src/network/snapshot.js';

test('room time choices retain legacy defaults and reject malformed settings', () => {
  for (const rules of [{}, { prepSec: '30', playMode: '__proto__' }]) {
    assert.equal(prepMs(rules), 90000);
    assert.equal(playMs(rules), 60000);
  }
  assert.equal(prepMs({ prepSec: 30 }), 30000);
  assert.equal(playMs({ playMode: '20+60' }), 20000);
});

test('overtime is per seat per round, spent only after base time; computers have no reserve', () => {
  const game = {},
    rules = { playMode: '20+60' };
  let clock = turnClock(game, 2, true, rules);
  assert.equal(clock.res, 60000);
  clock.left = 5000;
  commitReserve(game, clock);
  assert.equal(game.res, undefined);
  clock.left = -15000;
  assert.equal(clockShown(clock), 45000);
  commitReserve(game, clock);
  assert.equal(turnClock(game, 2, true, rules).res, 45000);
  assert.equal(turnClock(game, 0, true, rules).res, 60000);
  assert.equal(turnClock(game, 1, false, rules).res, 0);
  clock = turnClock(game, 2, true, rules);
  clock.left = -100000;
  commitReserve(game, clock);
  assert.equal(turnClock(game, 2, true, rules).res, 0);
  assert.equal(turnClock({}, 2, true, rules).res, 60000);
});

test('recovery rotates overtime balances with their seats and preserves the active clock', () => {
  const game = {
    hands: [[], [], [], []],
    levels: [2, 3],
    res: [0, 10000, 20000, 30000],
    clock: { who: 2, left: -1000, res: 20000 },
  };
  const local = rotateSnapshot(game, 2);
  assert.deepEqual(local.res, [20000, 30000, 0, 10000]);
  assert.equal(local.clock.who, 0);
  assert.equal(local.clock.res, 20000);
  assert.deepEqual(game.res, [0, 10000, 20000, 30000]);
});

test('shorter room clocks cap Clint reasoning and hard replacement before the move deadline', () => {
  assert.equal(clintBrainMs(0, 20000), 10000);
  assert.equal(clintBrainMs(4000, 30000), 16000);
  assert.equal(hardLeft(0, 1000, 20000), 11000);
  assert.equal(clintBrainMs(0), 30000);
  assert.equal(hardLeft(0, 1000), 51000);
});
