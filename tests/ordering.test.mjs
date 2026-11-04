import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import {
  normalizeOrder,
  sortActive,
  changeOrder,
  canUndoOrder,
  undoOrder,
  canRedoOrder,
  redoOrder,
} from '../src/hand/ordering.js';

const hand = () => makeDeck().filter((_, i) => i % 4 === 0);
test('normalization preserves manual groups and includes each held card once', () => {
  const cards = hand();
  const result = normalizeOrder(
    cards,
    {
      fixed: [
        [0, 0, 4, 999],
        [4, 8],
      ],
      myOrder: [8, 12, 12, 999],
    },
    2,
  );
  assert.deepEqual(result.fixed, [[0, 4], [8]]);
  const ids = result.fixed.flat().concat(result.myOrder);
  assert.equal(ids.length, cards.length);
  assert.equal(new Set(ids).size, cards.length);
  assert.deepEqual(new Set(ids), new Set(cards.map((c) => c.id)));
});
test('rank and suit sorting keep fixed groups intact and never mutate the physical hand', () => {
  const cards = hand(),
    original = cards.map((c) => c.id);
  const groups = [[cards[4].id, cards[0].id]];
  const rank = sortActive(cards, { fixed: groups }, 2);
  const suit = sortActive(cards, { fixed: groups }, 2, 'suit');
  assert.deepEqual(rank.fixed, groups);
  assert.deepEqual(suit.fixed, groups);
  assert.notDeepEqual(suit.myOrder, rank.myOrder);
  assert.deepEqual(
    cards.map((c) => c.id),
    original,
  );
});
test('undo restores a whole operation and does not roll back another player or played cards', () => {
  const game = { hands: [hand(), [], [], []], round: 1, L: 2, myOrder: [], fixed: [] };
  const before = normalizeOrder(game.hands[0], game, game.L);
  changeOrder(game, () => {
    game.fixed = [[0, 4]];
    game.myOrder = [];
  });
  assert(canUndoOrder(game));
  game.hands[1] = makeDeck().slice(1, 2);
  assert(undoOrder(game));
  assert.deepEqual(game.fixed, before.fixed);
  assert.deepEqual(game.myOrder, before.myOrder);
  assert.equal(game.hands[1].length, 1);
  changeOrder(game, () => {
    game.fixed = [[0, 4]];
  });
  game.hands[0] = game.hands[0].filter((c) => c.id !== 0);
  assert(!canUndoOrder(game));
  assert(!undoOrder(game));
});
test('no-op actions do not use undo history', () => {
  const game = { hands: [hand()], round: 1, L: 2 };
  assert.equal(
    changeOrder(game, () => {}),
    false,
  );
  assert(!canUndoOrder(game));
});

test('redo restores undone groups, preserves no-ops and clears after a new edit or hand change', () => {
  const game = { hands: [hand(), []], round: 1, L: 2, myOrder: [], fixed: [] };
  changeOrder(game, () => {
    game.fixed = [[0, 4]];
  });
  const grouped = normalizeOrder(game.hands[0], game, 2);
  assert(undoOrder(game));
  assert(canRedoOrder(game));
  assert.equal(
    changeOrder(game, () => {}),
    false,
  );
  game.hands[1] = makeDeck().slice(1, 2);
  assert(redoOrder(game));
  assert.deepEqual(normalizeOrder(game.hands[0], game, 2), grouped);
  assert(undoOrder(game));
  changeOrder(game, () => {
    game.fixed = [[8, 12]];
  });
  assert(!canRedoOrder(game));
  assert(!redoOrder(game));
  assert(undoOrder(game));
  game.hands[0] = game.hands[0].filter((card) => card.id !== 0);
  assert(!canRedoOrder(game));
  assert(!redoOrder(game));
});

test('undo and redo stay within thirty complete hand operations', () => {
  const game = { hands: [hand()], round: 1, L: 2, myOrder: [], fixed: [] };
  for (let index = 0; index < 40; index++)
    changeOrder(game, () => {
      const order = normalizeOrder(game.hands[0], game, 2).myOrder;
      game.myOrder = order.slice(1).concat(order[0]);
    });
  const final = game.myOrder.slice();
  let undo = 0,
    redo = 0;
  while (undoOrder(game)) undo++;
  while (redoOrder(game)) redo++;
  assert.equal(undo, 30);
  assert.equal(redo, 30);
  assert.deepEqual(game.myOrder, final);
  game.round++;
  assert(!canUndoOrder(game));
  assert(!canRedoOrder(game));
});
