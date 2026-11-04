import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { analyze, beats, power } from '../src/core/combinations.js';
import { genPlays } from '../src/core/moves.js';
import { readPlay, canPass, isReturnCard } from '../src/core/validation.js';

const deck = makeDeck();
const one = (rank, suit = 'S', copy = 0) => deck.filter((c) => c.r === rank && c.s === suit)[copy];

test('two decks have distinct physical IDs and complete suits', () => {
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map((c) => c.id)).size, 108);
  for (let rank = 2; rank <= 14; rank++) assert.equal(deck.filter((c) => c.r === rank).length, 8);
  assert.equal(deck.filter((c) => c.r >= 16).length, 4);
});

test('wild cards fill normal groups but never a joker pair', () => {
  const wild = one(2, 'H');
  assert(analyze([one(7), wild], 2).some((p) => p.type === 'pair' && p.value === 7));
  assert.equal(analyze([one(17, 'J'), wild], 2).length, 0);
  const straight = [one(14), one(2), one(3, 'D'), one(4, 'C'), one(5)];
  assert(analyze(straight, 9).some((p) => p.type === 'straight' && p.value === 1));
});

test('bomb hierarchy separates length, straight flushes and four jokers', () => {
  const four = { type: 'bomb', n: 4, value: 15 },
    five = { type: 'bomb', n: 5, value: 15 };
  const flush = { type: 'sflush', n: 5, value: 1 },
    six = { type: 'bomb', n: 6, value: 2 };
  const kings = { type: 'jokers', n: 4, value: 99 };
  assert(beats(five, four));
  assert(beats(flush, five));
  assert(beats(six, flush));
  assert(beats(kings, six));
  assert.equal(beats(four, five), false);
  assert(power(kings) > power(six));
});

test('untrusted selections cannot duplicate cards, forge shapes or use cards outside the hand', () => {
  const hand = [one(7), one(7, 'D'), one(8)];
  assert.equal(readPlay(hand, { ids: [hand[0].id, hand[0].id] }, null, 2), null);
  assert.equal(readPlay(hand, { ids: [999] }, null, 2), null);
  assert.equal(readPlay(hand, { ids: 'not a list' }, null, 2), null);
  assert.equal(readPlay(hand, { ids: [String(hand[0].id)] }, null, 2), null);
  const pair = readPlay(
    hand,
    { ids: hand.slice(0, 2).map((c) => c.id), type: 'jokers', value: 99, n: 1 },
    null,
    2,
  );
  assert.equal(pair.type, 'pair');
  assert.equal(pair.value, 7);
  assert.equal(pair.n, 2);
  assert.equal(
    readPlay(hand, { ids: pair.cards.map((c) => c.id) }, { type: 'pair', value: 8, n: 2 }, 2),
    null,
  );
  assert.equal(canPass(null), false);
  assert.equal(canPass({ player: 1 }), true);
});

test('return tribute accepts low non-wild cards only', () => {
  assert(isReturnCard(one(10), 2));
  assert(isReturnCard(one(2), 2));
  assert.equal(isReturnCard(one(2, 'H'), 2), false);
  assert.equal(isReturnCard(one(11), 2), false);
  assert.equal(isReturnCard(one(17, 'J'), 2), false);
  assert.equal(isReturnCard(undefined, 2), false);
});

test('generated moves use unique held cards and have a valid legal reading', () => {
  for (let seed = 0; seed < 80; seed++) {
    const hand = deck.filter((_, i) => (i * 17 + seed * 13) % 108 < 27),
      level = 2 + (seed % 13);
    const held = new Set(hand.map((c) => c.id));
    for (const move of genPlays(hand, level)) {
      assert.equal(new Set(move.cards.map((c) => c.id)).size, move.cards.length);
      assert(move.cards.every((c) => held.has(c.id)));
      assert(
        analyze(move.cards, level).some(
          (p) => p.type === move.type && p.value === move.value && p.n === move.n,
        ),
      );
    }
  }
});
