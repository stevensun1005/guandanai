import test from 'node:test';
import assert from 'node:assert/strict';
import { initialTableState, startOptions } from '../src/lobby/start-state.mjs';
import { makeDeck } from '../src/core/cards.js';
import { clintTimeout } from '../src/rule-bot/timeout.js';
import { analyze, beats } from '../src/core/combinations.js';

test('restored levels, failed A attempts and tribute order rotate together in every direction', () => {
  const order = ['S', 'N', 'E', 'W'],
    dirs = ['S', 'E', 'N', 'W'];
  const rules = {
    startState: { levels: { SN: 14, EW: 8 }, playSide: 'EW', order, aFails: { SN: 2, EW: 1 } },
  };
  for (const dir of dirs)
    for (const hostTeam of [0, 1]) {
      const i = dirs.indexOf(dir),
        g = initialTableState(rules, dir, hostTeam);
      assert.equal(g.L, 8);
      assert.equal(g.levels[(1 - i + 4) % 2], 8);
      assert.equal(g.aFails[(0 - i + 4) % 2], 2);
      assert.deepEqual(
        g.prevOut,
        order.map((d) => (dirs.indexOf(d) - i + 4) % 4),
      );
      assert.deepEqual(initialTableState(rules, dir, hostTeam, true).levels, [2, 2]);
    }
  const automatic = structuredClone(rules);
  automatic.startState.playSide = '';
  assert.equal(initialTableState(automatic, 'S').L, 14);
});
test('invalid and incomplete setup cannot manufacture a tribute order or invalid levels', () => {
  const rules = {
    startState: {
      levels: { SN: 99, EW: 7 },
      playSide: 'bad',
      order: ['S', 'S', 'W', 'x'],
      aFails: { SN: 8, EW: -1 },
    },
  };
  const s = startOptions(rules);
  assert.deepEqual(s.levels, { SN: 2, EW: 7 });
  assert.deepEqual(s.aFails, { SN: 0, EW: 0 });
  assert.equal(initialTableState(rules, 'E').prevOut, null);
  assert.equal(initialTableState({ startLevel: 12, startSide: 'EW' }, 'W').L, 12);
});
test('Clint timeout follows with pass and leads whole rank groups without splitting pairs', () => {
  const deck = makeDeck();
  const pick = (rank, n) => deck.filter((c) => c.r === rank).slice(0, n);
  let hand = pick(3, 2).concat(pick(4, 1), pick(7, 3));
  const lead = clintTimeout(hand, 2, null);
  assert.equal(lead.type, 'single');
  assert.equal(lead.cards[0].r, 4);
  assert.equal(clintTimeout(hand, 2, { play: { type: 'single', value: 2, n: 1 } }), null);
  hand = pick(3, 2).concat(pick(7, 3));
  assert.equal(clintTimeout(hand, 2, null).type, 'pair');
  const fixed = pick(5, 2);
  hand = pick(3, 4).concat(fixed);
  const selected = clintTimeout(hand, 2, null, [fixed.map((c) => c.id)]);
  assert.equal(selected.type, 'pair');
  assert.equal(selected.cards[0].r, 5);
});
test('Clint timeout stays legal over real hands and never receives opponent cards', () => {
  const deck = makeDeck();
  for (let offset = 0; offset < 81; offset++) {
    const hand = deck.slice(offset, offset + 27),
      pl = clintTimeout(hand, 2 + (offset % 13), null, [], () => 0.25);
    assert(pl);
    assert(pl.cards.every((c) => hand.includes(c)));
    assert(
      analyze(pl.cards, 2 + (offset % 13)).some((s) => s.type === pl.type && s.value === pl.value),
    );
    assert(beats(pl, null));
  }
});
