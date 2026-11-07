import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { publicTable, validPublicTable } from '../src/network/public-table.mjs';

test('spectator projection exposes public plays/counts but no hands, deck, seeds or assistance state', () => {
  const deck = makeDeck();
  const game = {
    round: 2,
    phase: 'play',
    L: 7,
    levels: [7, 2],
    lvlTeam: 0,
    turn: 1,
    out: [],
    hands: [deck.slice(0, 27), deck.slice(27, 54), deck.slice(54, 81), deck.slice(81)],
    last: [{ play: { cards: [deck[0]], type: 'single', value: 2 } }, 'pass', null, null],
    log: [
      { p: 0, cards: [deck[0]], seed: 99, assisted: true },
      { p: 1, cards: null },
    ],
    deck: [{ secret: 'PRIVATE' }],
    seed: 12345,
    myOrder: ['PRIVATE'],
    coach: { secret: 'PRIVATE' },
  };
  const before = structuredClone(game);
  const view = publicTable(game, { 0: '主人', 1: '朋友' }, new Set([0, 1]));
  assert.ok(validPublicTable(view));
  assert.deepEqual(
    view.players.map((p) => p.count),
    [27, 27, 27, 27],
  );
  assert.equal(view.players[0].name, '主人');
  assert.equal(view.players[2].name, '电脑');
  assert.deepEqual(view.players[0].last.cards, [deck[0]]);
  assert.equal(view.players[1].last, 'pass');
  assert.ok(!/PRIVATE|hands|deck|seed|assisted|coach|myOrder/.test(JSON.stringify(view)));
  assert.deepEqual(game, before);
  const bad = structuredClone(view);
  bad.log[0].cards[0].id = '" onclick="alert(1)';
  assert.equal(validPublicTable(bad), false);
  const badCount = structuredClone(view);
  badCount.players[0].count = 99;
  assert.equal(validPublicTable(badCount), false);
  const badSeat = structuredClone(view);
  badSeat.players[0].seat = 'x';
  assert.equal(validPublicTable(badSeat), false);
  const missingSeat = structuredClone(view);
  missingSeat.players[0] = null;
  assert.equal(validPublicTable(missingSeat), false);
});
