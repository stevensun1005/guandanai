import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { tributeOptions, returnOptions } from '../src/core/tribute.js';
import { isReturnCard } from '../src/core/validation.js';
import { selectionFeedback } from '../src/hand/selection-feedback.js';
const deck = makeDeck();
test('tribute offers the largest non-wild physical cards including jokers', () => {
  const hand = deck.filter((card) => card.r === 2 || card.r >= 16);
  assert.deepEqual(
    tributeOptions(hand, 2).map((card) => card.r),
    [17, 17],
  );
  assert(
    tributeOptions(
      hand.filter((card) => card.r < 16),
      2,
    ).every((card) => card.r === 2 && card.s !== 'H'),
  );
});
test('return options prefer low cards and forbid wilds and high cards while lows exist', () => {
  const hand = deck.filter((card) => card.id < 54);
  const options = returnOptions(hand, 2);
  assert(options.every((card) => card.r <= 10 && !(card.r === 2 && card.s === 'H')));
  assert(
    !isReturnCard(
      hand.find((card) => card.r === 11),
      2,
      hand,
    ),
  );
});
test('a high-only hand can return its smallest non-wild card and cannot stall the round', () => {
  const hand = deck.filter((card) => card.r >= 11 && card.r <= 14).slice(0, 28);
  const options = returnOptions(hand, 2);
  assert(options.length > 0);
  assert(options.every((card) => card.r === 11));
  assert(isReturnCard(options[0], 2, hand));
  assert(
    !isReturnCard(
      hand.find((card) => card.r === 12),
      2,
      hand,
    ),
  );
  assert.equal(selectionFeedback([options[0]], 2, { mode: 'return', hand }).tone, 'ready');
  assert.match(selectionFeedback([], 2, { mode: 'return', hand }).message, /最小/);
});
