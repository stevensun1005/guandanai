import test from 'node:test';
import assert from 'node:assert/strict';
import { cardsArray } from '../../../web/src/ai/encoding.mjs';
import {
  POLICY_EXTRA_FEATURES,
  encodePolicyExtras,
  encodePolicyExtrasBatch,
} from '../../../web/src/ai/policy-features.mjs';

function position() {
  return {
    p: 0,
    hand: [80, 67, 14, 68, 25, 52, 106],
    counts: [7, 9, 2, 8],
    log: [
      { p: 1, cards: [1] },
      { p: 2, cards: null },
    ],
    level: 14,
    canPass: true,
    trick: { player: 1, play: { type: 'single', value: 3, n: 1 } },
    actions: [[], [52]],
    actionShapes: [null, { type: 'single', value: 16, n: 1 }],
  };
}

test('residual features retain the live trick after a pass and describe remaining cards', () => {
  const state = position();
  const pass = encodePolicyExtras(state, 0);
  assert.equal(pass.length, POLICY_EXTRA_FEATURES);
  assert.equal(pass[0], 1);
  assert.equal(pass[2], 1);
  assert.equal(pass[5], 1);
  assert.equal(pass[17], Math.fround(1 / 3));
  assert.equal(pass[18], 1);
  assert.equal(pass[21], 1);
  assert.equal(pass[49], 0.5);
  assert.equal(pass[50], 0.5);
  const play = encodePolicyExtras(state, 1);
  assert.equal(play[22], 1);
  assert.equal(play[36], Math.fround(6 / 27));
  assert.equal(play[50], 0.25);
  assert.ok(play.every(Number.isFinite));
  const batch = encodePolicyExtrasBatch(state);
  assert.deepEqual(batch.slice(0, POLICY_EXTRA_FEATURES), pass);
  assert.deepEqual(batch.slice(POLICY_EXTRA_FEATURES), play);
});

test('residual features distinguish wildcard interpretations with identical legacy inputs', () => {
  const state = position();
  state.canPass = false;
  state.trick = null;
  state.actions = [
    [80, 67, 14, 68, 25],
    [80, 67, 14, 68, 25],
  ];
  state.actionShapes = [
    { type: 'full', value: 2, n: 5 },
    { type: 'full', value: 3, n: 5 },
  ];
  assert.deepEqual(cardsArray(state.actions[0]), cardsArray(state.actions[1]));
  const low = encodePolicyExtras(state, 0);
  const high = encodePolicyExtras(state, 1);
  assert.notDeepEqual(low, high);
  assert.equal(low[32], Math.fround(2 / 17));
  assert.equal(high[32], Math.fround(3 / 17));
});

test('residual features are seat relative, deck-copy invariant and ignore private other hands', () => {
  const state = position();
  const before = JSON.stringify(state);
  const expected = encodePolicyExtrasBatch(state);
  Object.defineProperty(state, 'hands', { get: () => assert.fail('Private hands were accessed') });
  assert.deepEqual(encodePolicyExtrasBatch(state), expected);
  assert.equal(JSON.stringify(state), before);
  const swapped = structuredClone(position());
  const swap = (id) => (id + 54) % 108;
  swapped.hand = swapped.hand.map(swap);
  swapped.actions = swapped.actions.map((action) => action.map(swap));
  swapped.log = swapped.log.map((entry) => ({ ...entry, cards: entry.cards?.map(swap) || null }));
  assert.deepEqual(encodePolicyExtrasBatch(swapped), expected);
  for (let shift = 1; shift < 4; shift++) {
    const rotated = position();
    rotated.p = shift;
    rotated.trick.player = (rotated.trick.player + shift) % 4;
    rotated.log = rotated.log.map((entry) => ({ ...entry, p: (entry.p + shift) % 4 }));
    rotated.counts = Array.from({ length: 4 }, (_, p) => state.counts[(p - shift + 4) % 4]);
    assert.deepEqual(encodePolicyExtrasBatch(rotated), expected);
  }
});

test('first-out and next-active signals use public history, and missing shapes fail explicitly', () => {
  const state = position();
  state.log = [{ p: 2, cards: Array.from({ length: 27 }, (_, id) => id) }];
  state.counts[2] = 0;
  state.counts[1] = 0;
  const extras = encodePolicyExtras(state, 1);
  assert.equal(extras[19], 1);
  assert.equal(extras[40], 1);
  assert.equal(extras[42], 0.5);
  assert.throws(() => encodePolicyExtras({ ...state, actionShapes: [] }, 0));
  assert.throws(() => encodePolicyExtras({ ...state, trick: null }, 0));
  assert.throws(() => encodePolicyExtras(state, -1));
});
