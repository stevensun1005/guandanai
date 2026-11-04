import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { publicLog, publicLogText } from '../src/replay/public-log.js';

test('shareable scorecards include public actions with stable numbering and exclude all held cards', () => {
  const deck = makeDeck();
  const game = {
    round: 3,
    L: 14,
    hands: [deck.slice(3), [], [], []],
    log: [
      { p: 0, type: 'single', cards: [deck[0]], lead: true },
      { p: 1, cards: null },
      { p: 2, type: 'pair', cards: [deck[1], deck[55]] },
    ],
  };
  const record = publicLog(game, ['你', '朋友甲', '朋友乙', '朋友丙'], '牌友');
  assert.deepEqual(
    record.rows.map((row) => [row.number, row.name, row.type]),
    [
      [1, '牌友', '单张'],
      [2, '朋友甲', '过'],
      [3, '朋友乙', '对子'],
    ],
  );
  const text = publicLogText(record);
  assert(text.includes('第 3 局 · 打 A'));
  assert(text.includes('1. 牌友 领出 单张 · ♠2'));
  assert(!text.includes('大王'));
  assert(!text.includes('小王'));
  game.hands = [[], deck, [], []];
  assert.deepEqual(publicLog(game, ['你', '朋友甲', '朋友乙', '朋友丙'], '牌友'), record);
});
