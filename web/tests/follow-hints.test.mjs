import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/app/runtime.js';
import { makeDeck } from '../src/core/cards.js';
import { analyze } from '../src/core/combinations.js';
import { genPlays } from '../src/core/moves.js';
import { initialize as initializeValue } from '../src/ai/hand-value.js';
import { initialize as initializeHints } from '../src/hand/hints.js';
import { sortHints } from '../src/hand/follow-hints.js';

test('a fixed wildcard bomb remains available as a whole when following a normal full house', () => {
  initializeValue();
  initializeHints();
  const deck = makeDeck();
  const hand = deck
    .filter((c) => c.r === 8)
    .slice(0, 3)
    .concat(deck.find((c) => c.s === 'H' && c.r === 2));
  const cards = deck
    .filter((c) => c.r === 4)
    .slice(0, 3)
    .concat(deck.filter((c) => c.r === 5).slice(0, 2));
  const play = { ...analyze(cards, 2).find((p) => p.type === 'full'), cards };
  const previous = runtime.game;
  try {
    runtime.game = {
      L: 2,
      hands: [hand, [], [], []],
      fixed: [hand.map((c) => c.id)],
      trick: { player: 1, play },
    };
    const result = sortHints(genPlays(hand, 2));
    assert.ok(result.some((p) => p.type === 'bomb' && p.cards.length === 4));
    assert.ok(result.every((p) => p.cards.length === 4));
  } finally {
    runtime.game = previous;
  }
});
