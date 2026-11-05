import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { canResume, rotateSnapshot } from '../src/network/snapshot.js';

test('all four rejoin views rotate seats and teams while preserving physical cards and tribute ranks', () => {
  const deck = makeDeck();
  const source = {
    levels: [5, 9],
    aFails: [1, 2],
    lvlTeam: 1,
    hands: [deck.slice(0, 27), deck.slice(27, 54), deck.slice(54, 81), deck.slice(81)],
    last: ['pass', null, { play: { cards: [deck[3]] } }, null],
    turn: 3,
    leader: 2,
    cutter: 1,
    shuffler: 0,
    dealIdx: 1,
    firstLeader: 2,
    nextLeader: -1,
    pausedBy: null,
    out: [2],
    prevOut: [2, 3, 1, 0],
    ready: [1, 3],
    nextReady: [],
    tribGivers: [3],
    retPick: { 2: 8 },
    tribPick: { 3: 5 },
    returns: [{ from: 2, to: 3 }],
    gives: [],
    trib: [{ g: 3, r: 2, tc: deck[5], rc: deck[8] }],
    log: [{ p: 2, cards: [deck[3]] }],
    trick: { player: 2, play: { cards: [deck[3]], value: 5 } },
    trickPlays: [{ p: 2, play: { cards: [deck[3]] } }],
    rest: [{ p: 0, cards: [deck[0]] }],
    kang: { has: [{ g: 3, n: 2 }], leader: 2 },
    clock: { who: 'return', seats: [2], left: 12345 },
    result: { team: 1, aTeam: 0, order: [2, 3, 1, 0], before: 8, after: 9 },
  };
  const original = structuredClone(source);
  for (let offset = 0; offset < 4; offset++) {
    const rotated = rotateSnapshot(source, offset);
    assert.deepEqual(rotated.hands[0], source.hands[offset]);
    assert.equal(rotated.trib[0].tc.r, source.trib[0].tc.r);
    assert.equal(rotated.trib[0].r, (2 - offset + 4) % 4);
    assert.equal(rotated.nextLeader, -1);
    assert.equal(rotated.pausedBy, null);
    assert.deepEqual(rotateSnapshot(rotated, (4 - offset) % 4), original);
  }
  assert.deepEqual(source, original);
});

test('rejoin waits for logical stable phases and a completed round reveal', () => {
  assert(canResume({ phase: 'prep', gives: [] }));
  assert(canResume({ phase: 'play', turn: 2 }));
  assert(!canResume({ phase: 'play', turn: -1 }));
  assert(!canResume({ phase: 'deal' }));
  assert(!canResume({ phase: 'tribute', gives: [{ from: 1, to: 2 }] }));
  assert(!canResume({ phase: 'roundEnd', reveal: 3 }));
  assert(canResume({ phase: 'roundEnd', reveal: 4 }));
});
