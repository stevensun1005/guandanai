import test from 'node:test';
import assert from 'node:assert/strict';
import { observeOpponentHabits, HABIT_DECAY } from '../../../web/src/ai/habits.js';
import { decisionContext } from '../../../web/src/ai/observation.js';
import { selectProfileAction } from '../../../web/src/ai/profiles.js';
import { encodeResponse } from '../../../web/src/ai/response-features.mjs';
import { makeDeck } from '../../../web/src/core/cards.js';

const deck = makeDeck();
const pair = { cards: [deck[0], deck[54]], type: 'pair', n: 2, value: 2 };
const single = { cards: [deck[0]], type: 'single', n: 1, value: 2 };
test('recent habits separate partner restraint, opponent responses and five-card shapes', () => {
  const log = [
    { p: 0, ...pair, lead: true },
    { p: 2, cards: null },
    { p: 1, cards: null },
    { p: 3, ...pair },
    { p: 0, type: 'full', cards: deck.slice(0, 5), lead: true },
    { p: 1, cards: null },
    { p: 0, type: 'straight', cards: deck.slice(5, 10), lead: true },
    { p: 1, cards: null },
  ];
  const stats = observeOpponentHabits([{ log }], []);
  assert.equal(stats[2].responses, 0);
  assert.equal(stats[1].byType['pair:2'].passes, HABIT_DECAY);
  assert.equal(stats[3].byType['pair:2'].responds, HABIT_DECAY);
  assert.equal(stats[1].byType['full:5'].passes, HABIT_DECAY);
  assert.equal(stats[1].byType['straight:5'].passes, HABIT_DECAY);
  const capped = observeOpponentHabits(
    [{ log }, ...Array.from({ length: 4 }, () => ({ log: [] }))],
    [],
  );
  assert.equal(capped[1].responses, 0);
});
test('archived public habits affect close leads without changing frozen network features or exposing hidden cards', () => {
  const log = Array.from({ length: 15 }, () => [
    { p: 0, ...pair, lead: true },
    { p: 1, cards: null },
  ]).flat();
  const game = {
    hands: [deck.slice(0, 12), deck.slice(12, 24), deck.slice(24, 36), deck.slice(36, 48)],
    L: 2,
    log: [],
    trick: null,
    roundHistory: [{ log }],
  };
  const context = decisionContext(game, 0);
  const legacy = { ...context, habits: undefined };
  assert.equal(selectProfileAction([single, pair], [0.5, 0.496], 'observant', legacy), 0);
  assert.equal(selectProfileAction([single, pair], [0.5, 0.496], 'observant', context), 1);
  assert.equal(selectProfileAction([single, pair], [0.8, 0.5], 'observant', context), 0);
  assert.deepEqual(encodeResponse(context, pair, 1), encodeResponse(legacy, pair, 1));
  game.roundHistory[0].hands = [deck, deck, deck, deck];
  game.hands[1] = deck.slice(54, 66);
  assert.deepEqual(decisionContext(game, 0), context);
  assert(!JSON.stringify(context.habits).includes('"cards"'));
});
