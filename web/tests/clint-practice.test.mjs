import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { candidates } from '../src/ai/candidates.js';
import {
  solveEndgame,
  exactMoves,
  stepPosition,
  finished,
  finalPoints,
} from '../src/rule-bot/practice-endgame.mjs';
import { advanceRound } from '../../ai/shared/simulation/simulation.mjs';

test('open Clint minimax agrees with a full-width exhaustive reference, including following and wilds', () => {
  const deck = makeDeck();
  for (let i = 0; i < 16; i++) {
    const cards =
      i === 15
        ? [deck[13], deck[0], deck[3], deck[52], deck[53], deck[54], deck[55], deck[57]]
        : deck.slice(i, i + 8);
    const initial = {
      hands: [0, 1, 2, 3].map((p) => cards.slice(p * 2, p * 2 + 2)),
      L: 2 + (i % 13),
      turn: i % 4,
      trick: null,
      passes: 0,
      out: [],
    };
    const memo = new Map();
    function reference(state) {
      if (finished(state)) return finalPoints(state);
      const key = JSON.stringify(state);
      if (memo.has(key)) return memo.get(key);
      const values = exactMoves(state.hands[state.turn], state.L, state.trick?.play).map((pl) =>
        reference(stepPosition(state, pl)),
      );
      const value = (state.turn % 2 ? Math.min : Math.max)(...values);
      memo.set(key, value);
      return value;
    }
    const result = solveEndgame(initial, { maxMs: 10000 });
    assert(result.complete);
    assert.equal(result.value, reference(initial));
    let state = initial;
    for (const action of result.line) {
      assert.equal(action.player, state.turn);
      const actual = { ...structuredClone(state), log: [] };
      const settled = advanceRound(actual, action.play);
      state = stepPosition(state, action.play);
      assert.deepEqual(state.hands, actual.hands);
      if (!settled) assert.equal(state.turn, actual.turn);
      else assert.equal((settled.winner === 0 ? 1 : -1) * settled.points, result.value);
    }
    assert(finished(state));
    assert.equal(finalPoints(state), result.value);
  }
});
test('Clint-only subset enumeration retains semantic shapes, suits and physical aliases', () => {
  const deck = makeDeck();
  for (let i = 0; i < 40; i++) {
    const hand =
        i === 0
          ? [deck[52], deck[53], deck[106], deck[107], deck[13], deck[67], deck[1]]
          : i < 20
            ? deck.slice(i, i + 7)
            : deck.slice(i, i + 5).concat(deck[i + 54], deck[i + 55]),
      key = (p) =>
        p
          ? `${p.type}:${p.value}:${p.n}:${p.cards
              .map((c) => c.r + c.s)
              .sort()
              .join(',')}`
          : 'pass';
    const L = 2 + (i % 13);
    assert.deepEqual(new Set(exactMoves(hand, L).map(key)), new Set(candidates(hand, L).map(key)));
  }
});
test('budget exits never return a claimed optimal value or replay, and malformed hands fail', () => {
  const d = makeDeck(),
    s = {
      hands: [0, 1, 2, 3].map((p) => d.slice(p * 3, p * 3 + 3)),
      L: 2,
      turn: 0,
      trick: null,
      passes: 0,
      out: [],
    };
  const r = solveEndgame(s, { maxMs: 0 });
  assert.equal(r.complete, false);
  assert.equal(r.value, null);
  assert.deepEqual(r.line, []);
  const bad = structuredClone(s);
  bad.hands[1][0] = bad.hands[0][0];
  assert.throws(() => solveEndgame(bad), /实体牌/);
});
