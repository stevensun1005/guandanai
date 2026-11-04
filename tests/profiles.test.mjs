import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { candidates } from '../src/ai/candidates.js';
import { decisionContext, observeResponses, policyState } from '../src/ai/observation.js';
import {
  adaptiveWeights,
  profileId,
  selectProfileAction,
  usesResponseModel,
} from '../src/ai/profiles.js';

const deck = makeDeck();
const context = {
  p: 0,
  hand: deck.slice(0, 20),
  counts: [20, 20, 20, 20],
  level: 2,
  log: [],
  trick: { player: 1, play: { type: 'single', value: 4, n: 1 } },
};
const single = { type: 'single', n: 1, value: 8, cards: [deck[6]] };
const bomb = { type: 'bomb', n: 4, value: 8, cards: [deck[6], deck[19], deck[32], deck[45]] };

test('balanced preserves the learned argmax and unsupported profile names are normalized', () => {
  assert.equal(profileId('invented-model'), 'balanced');
  assert.equal(selectProfileAction([single, bomb, null], [0.7, 0.6, 0.8], 'balanced', context), 2);
  assert.throws(() => selectProfileAction([single], [NaN], 'aggressive', context));
});
test('aggressive contests a close decision while conservative preserves its bomb', () => {
  const plays = [null, bomb],
    values = [0.51, 0.5];
  assert.equal(
    selectProfileAction(plays, values, 'aggressive', { ...context, counts: [20, 2, 20, 20] }),
    1,
  );
  assert.equal(selectProfileAction(plays, values, 'conservative', context), 0);
  assert.equal(selectProfileAction(plays, [0.8, 0.5], 'aggressive', context), 0);
});
test('styles preserve a nearly finished partner and never ignore a large policy gap', () => {
  const cooperating = {
    ...context,
    counts: [20, 20, 2, 20],
    trick: { ...context.trick, player: 2 },
  };
  assert.equal(selectProfileAction([null, single], [0.5, 0.5], 'observant', cooperating), 0);
  assert.equal(selectProfileAction([single, bomb], [0.8, 0.6], 'aggressive', context), 0);
});
test('observation reacts to public response frequencies without treating a pass as impossibility', () => {
  const pair = { type: 'pair', n: 2, value: 8, cards: [deck[6], deck[19]] };
  const base = { ...context, trick: null };
  assert.equal(selectProfileAction([single, pair], [0.5, 0.496], 'observant', base), 0);
  const log = [];
  for (let index = 0; index < 10; index++)
    log.push({ p: 0, cards: pair.cards, lead: true }, { p: 1, cards: null }, { p: 3, cards: null });
  const observed = { ...base, log };
  assert.equal(observeResponses(log)[1].bySize[2].passes, 10);
  assert.equal(selectProfileAction([single, pair], [0.5, 0.496], 'observant', observed), 1);
  assert.equal(selectProfileAction([single, pair], [0.8, 0.5], 'observant', observed), 0);
});
test('model and style observations do not change when hidden opponent cards change', () => {
  const game = {
    hands: [deck.slice(0, 12), deck.slice(12, 24), deck.slice(24, 36), deck.slice(36, 48)],
    log: [],
    L: 2,
    levels: [2, 3],
    trick: null,
  };
  const plays = candidates(game.hands[0], 2, null);
  const features = policyState(game, 0, 0, plays),
    view = decisionContext(game, 0);
  game.hands[1] = deck.slice(54, 66);
  game.hands[2] = deck.slice(66, 78);
  game.hands[3] = deck.slice(78, 90);
  assert.deepEqual(policyState(game, 0, 0, plays), features);
  assert.deepEqual(decisionContext(game, 0), view);
});

test('blended preferences respond to public urgency, partner lead and accumulated evidence', () => {
  assert.equal(profileId('adaptive'), 'adaptive');
  assert(usesResponseModel('adaptive'));
  const normal = adaptiveWeights(context);
  const urgent = adaptiveWeights({ ...context, counts: [20, 1, 20, 20] });
  const partner = adaptiveWeights({ ...context, trick: { ...context.trick, player: 2 } });
  const observed = adaptiveWeights({
    ...context,
    log: Array.from({ length: 12 }, () => ({ p: 1, cards: null })),
  });
  assert(urgent.aggressive > normal.aggressive);
  assert(partner.conservative > normal.conservative);
  assert(observed.observant > normal.observant);
  for (const weights of [normal, urgent, partner, observed]) {
    assert(Object.values(weights).every((weight) => weight > 0));
    assert(Math.abs(Object.values(weights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
  }
  assert.equal(selectProfileAction([single, bomb], [0.8, 0.6], 'adaptive', context), 0);
});
