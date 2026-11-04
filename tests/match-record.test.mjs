import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import {
  rememberPublicRound,
  matchStats,
  publicMatchText,
  MAX_PUBLIC_ROUNDS,
} from '../src/replay/match-record.js';
import { rotateSnapshot } from '../src/network/snapshot.js';

const deck = makeDeck();
const names = ['你', '朋友甲', '朋友乙', '朋友丙'];
function game() {
  return {
    round: 1,
    L: 2,
    levels: [5, 2],
    hands: [deck, [], [], []],
    deck,
    log: [
      { p: 0, cards: [deck[0]], type: 'single', n: 1, value: 2, lead: true },
      { p: 1, cards: null },
      { p: 2, cards: deck.slice(2, 6), type: 'bomb', n: 4, value: 4 },
    ],
    result: { team: 0, up: 3, before: 2, after: 5, order: [0, 2, 3, 1], aTeam: 0, win: false },
  };
}
test('completed match records freeze only public actions and replace repeated completion', () => {
  const state = game();
  rememberPublicRound(state, names, '牌友');
  rememberPublicRound(state, names, '牌友');
  assert.equal(state.roundHistory.length, 1);
  const saved = structuredClone(state.roundHistory[0]);
  state.log[0].cards[0] = deck[52];
  state.result.order.reverse();
  state.hands = [[], deck, [], []];
  assert.deepEqual(state.roundHistory[0], saved);
  assert(!('hands' in saved) && !('deck' in saved));
  assert(!JSON.stringify(saved).includes('"r":17'));
  const stats = matchStats([saved, { log: [{ p: 1, cards: null }] }]);
  assert.equal(stats.rounds, 1);
  assert.deepEqual(stats.wins, [1, 0]);
  assert.equal(stats.seats[0].firsts, 1);
  assert.equal(stats.seats[1].passes, 2);
  assert.equal(stats.seats[2].bombs, 1);
  const text = publicMatchText([saved]);
  assert(text.includes('牌友 → 朋友乙 → 朋友丙 → 朋友甲'));
  assert(!text.includes('大王'));
});
test('archived rounds rotate with restored seats and keep a bounded match history', () => {
  const state = game();
  for (let round = 1; round <= MAX_PUBLIC_ROUNDS + 2; round++) {
    state.round = round;
    rememberPublicRound(state, names, '牌友');
  }
  assert.equal(state.roundHistory.length, MAX_PUBLIC_ROUNDS);
  assert.equal(state.roundHistory[0].round, 3);
  const snapshot = { levels: [5, 2], lvlTeam: 0, roundHistory: state.roundHistory };
  for (let offset = 0; offset < 4; offset++) {
    const rotated = rotateSnapshot(snapshot, offset);
    assert.equal(rotated.roundHistory[0].names[0], state.roundHistory[0].names[offset]);
    assert.equal(matchStats(rotated.roundHistory).wins[offset % 2], MAX_PUBLIC_ROUNDS);
    assert.deepEqual(rotateSnapshot(rotated, (4 - offset) % 4), snapshot);
  }
});
