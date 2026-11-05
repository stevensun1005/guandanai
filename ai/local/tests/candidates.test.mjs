import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../../../web/src/core/cards.js';
import { analyze, beats } from '../../../web/src/core/combinations.js';
import { candidates } from '../../../web/src/ai/candidates.js';
import { seededRandom } from '../../shared/simulation/simulation.mjs';

const signature = (play) =>
  `${play.type}:${play.value}:${play.cards
    .map((card) => card.r + card.s)
    .sort()
    .join(',')}`;
test('policy candidates match exhaustive legal subsets for small hands, including wilds and sequences', () => {
  const deck = makeDeck(),
    random = seededRandom(30071);
  const hands = [
    deck
      .filter((card) => card.s === 'S' && card.r >= 9 && card.r <= 14)
      .concat(deck.filter((card) => card.s === 'H' && card.r === 2)),
    deck.filter((card) => card.r >= 3 && card.r <= 5 && ['S', 'H'].includes(card.s)).slice(0, 10),
    deck.filter((card) => card.r === 7 || card.r === 16).slice(0, 10),
  ];
  for (let index = 0; index < 20; index++)
    hands.push(
      deck
        .map((card) => ({ card, key: random() }))
        .sort((a, b) => a.key - b.key)
        .slice(0, 10)
        .map(({ card }) => card),
    );
  for (const hand of hands) {
    const expected = new Set();
    for (let mask = 1; mask < 1 << hand.length; mask++) {
      const cards = hand.filter((_, index) => mask & (1 << index));
      for (const shape of analyze(cards, 2)) expected.add(signature({ ...shape, cards }));
    }
    const actual = new Set(candidates(hand, 2, null).map(signature));
    assert.deepEqual(actual, expected, `Hand: ${hand.map((card) => card.r + card.s)}`);
    const current = { type: 'pair', n: 2, value: 9 };
    const follow = candidates(hand, 2, current);
    assert.equal(follow.at(-1), null);
    assert(follow.slice(0, -1).every((play) => beats(play, current)));
  }
});
