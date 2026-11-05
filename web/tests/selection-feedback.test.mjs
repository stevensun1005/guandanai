import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { selectionFeedback } from '../src/hand/selection-feedback.js';
const deck = makeDeck();
const find = (rank, suit) => deck.find((card) => card.r === rank && card.s === suit);
test('selection feedback distinguishes invalid shapes, legal follows and waiting turns', () => {
  const single = [find(9, 'S')],
    current = { type: 'single', n: 1, value: 8 };
  assert.equal(selectionFeedback(single, 2, { mode: 'play', current }).tone, 'ready');
  assert.equal(
    selectionFeedback(single, 2, { mode: 'play', current: { ...current, value: 10 } }).tone,
    'invalid',
  );
  assert.match(selectionFeedback(single, 2, { mode: 'wait' }).message, /已预选/);
  assert.match(
    selectionFeedback([find(3, 'S'), find(5, 'C')], 2, { mode: 'play' }).message,
    /不成牌型/,
  );
});
test('tribute and return feedback uses physical choices and the actual wild-card level', () => {
  const low = find(4, 'S'),
    wild = find(4, 'H');
  assert.equal(selectionFeedback([low], 4, { mode: 'return' }).tone, 'ready');
  assert.equal(selectionFeedback([wild], 4, { mode: 'return' }).tone, 'invalid');
  assert.equal(selectionFeedback([low, low], 4, { mode: 'return' }).tone, 'invalid');
  assert.equal(
    selectionFeedback([low], 4, { mode: 'tribute', tributeIds: [low.id] }).tone,
    'ready',
  );
  assert.equal(selectionFeedback([low], 4, { mode: 'tribute', tributeIds: [] }).tone, 'invalid');
});
test('ambiguous wild-card groups display a legal reading for the current trick', () => {
  const cards = [find(9, 'S'), find(9, 'C'), find(2, 'H')];
  assert.match(
    selectionFeedback(cards, 2, { mode: 'play', current: { type: 'triple', n: 3, value: 8 } })
      .message,
    /三张/,
  );
  assert.match(selectionFeedback(cards, 2, { mode: 'prep' }).message, /可成组/);
  assert.equal(selectionFeedback([], 2, { mode: 'play' }).count, 0);
});
