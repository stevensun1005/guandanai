import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { roundEvt } from '../src/game/session.js';

test('a randomly dealt four-joker hand is kept without a second hidden shuffle', (t) => {
  const deck = makeDeck();
  const jokers = deck.filter((card) => card.r >= 16);
  const rest = deck.filter((card) => card.r < 16);
  const target = Array.from({ length: 108 }, (_, index) =>
    index < 16 && index % 4 === 0 ? jokers.shift().id : rest.shift().id,
  );
  const working = deck.map((card) => card.id);
  const draws = [0.2]; // first-round cutter
  for (let index = working.length - 1; index > 0; index--) {
    const chosen = working.indexOf(target[index]);
    draws.push((chosen + 0.25) / (index + 1));
    [working[index], working[chosen]] = [working[chosen], working[index]];
  }
  draws.push(0.75); // first leader
  t.mock.method(Math, 'random', () => {
    assert(draws.length, 'a second shuffle consumed more randomness');
    return draws.shift();
  });
  const event = roundEvt(true);
  assert.deepEqual(event.deck, target);
  assert.equal(new Set(event.deck).size, 108);
  assert.equal(draws.length, 0);
});
