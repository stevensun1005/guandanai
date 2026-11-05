import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../../../web/src/core/cards.js';
import { decisionContext } from '../../../web/src/ai/observation.js';
import { encodeResponse, RESPONSE_FEATURES } from '../../../web/src/ai/response-features.mjs';
import { responseCandidates, predictResponses } from '../../../web/src/ai/response.mjs';
import { selectProfileAction } from '../../../web/src/ai/profiles.js';

const deck = makeDeck();
const game = {
  hands: [deck.slice(0, 20), deck.slice(20, 40), deck.slice(54, 74), deck.slice(74, 94)],
  log: [
    { p: 1, cards: [deck[40]], lead: true },
    { p: 2, cards: null },
  ],
  L: 2,
  trick: null,
};
const single = (card) => ({ type: 'single', value: card.rank || 8, n: 1, cards: [card] });
const plays = [single(deck[6]), single(deck[7]), null];

test('response encoding has a fixed finite dimension and ignores hidden opponent identities', () => {
  const context = decisionContext(game, 0);
  const before = encodeResponse(context, plays[0], 1);
  assert.equal(before.length, RESPONSE_FEATURES);
  assert(before.every(Number.isFinite));
  const changed = {
    ...game,
    hands: [game.hands[0], deck.slice(21, 41), deck.slice(55, 75), deck.slice(75, 95)],
  };
  assert.deepEqual(encodeResponse(decisionContext(changed, 0), plays[0], 1), before);
  assert.notDeepEqual(encodeResponse({ ...context, log: [] }, plays[0], 1), before);
});

test('the conditional model only ranks several close plays against the next active opponent', () => {
  const context = decisionContext(game, 0);
  assert.equal(responseCandidates(plays, [0.5, 0.49, 0.51], context, 2), null);
  assert.equal(responseCandidates(plays, [0.8, 0.49, 0.51], context, 0), null);
  assert.equal(
    responseCandidates(plays, [0.5, 0.49, 0.51], { ...context, counts: [20, 0, 20, 20] }, 0),
    null,
  );
  assert.deepEqual(responseCandidates(plays, [0.5, 0.49, 0.51], context, 0), {
    indices: [0, 1],
    recipient: 1,
  });
});

test('response estimates preserve the original play/pass decision and the learned value band', () => {
  const context = decisionContext(game, 0);
  const biased = { ...context, responseRisks: [1, 0, null] };
  assert.equal(selectProfileAction(plays, [0.5, 0.49, 0.4], 'observant', context), 0);
  assert.equal(selectProfileAction(plays, [0.5, 0.49, 0.4], 'observant', biased), 1);
  assert.equal(selectProfileAction(plays, [0.5, 0.49, 0.6], 'observant', biased), 2);
  assert.equal(selectProfileAction(plays, [0.8, 0.49, 0.4], 'observant', biased), 0);
  assert.equal(selectProfileAction(plays, [0.5, 0.49, 0.4], 'balanced', biased), 0);
  assert.equal(selectProfileAction(plays, [0.5, 0.49, 0.6], 'adaptive', biased), 2);
  assert.equal(selectProfileAction(plays, [0.8, 0.49, 0.4], 'adaptive', biased), 0);
});

test('response inference disposes tensors even when the model returns invalid probabilities', async () => {
  let disposed = 0;
  class Tensor {
    dispose() {
      disposed++;
    }
  }
  const engine = {
    run: async () => ({
      probability: {
        data: [NaN],
        dispose() {
          disposed++;
        },
      },
    }),
  };
  await assert.rejects(
    predictResponses({ Tensor }, engine, decisionContext(game, 0), plays, {
      indices: [0],
      recipient: 1,
    }),
    /Invalid response probability/,
  );
  assert.equal(disposed, 2);
});
