import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../../../web/src/core/cards.js';
import { imitationDecision } from '../tools/prepare-human-imitation.mjs';
import { validateImitationProtocol } from '../tools/run-human-imitation.mjs';

test('imitation data target is the human face-vector choice, with no opponent hand inputs', () => {
  const deck = makeDeck(),
    card = (r) => deck.find((c) => c.r === r && c.s === 'S');
  const game = {
    hands: [[card(2), card(5), card(9)], [card(3)], [card(4)], [card(6)]],
    turn: 0,
    L: 7,
    levels: [7, 7],
    log: [],
    trick: { player: 2, play: { type: 'single', value: 1, n: 1, cards: [card(2)] } },
  };
  const data = imitationDecision(game, null);
  assert.equal(data.types[data.target], 'pass');
  assert.ok(data.features.every((x) => x.length === 567));
  assert.deepEqual(
    data,
    imitationDecision(
      { ...game, hands: game.hands.map((h, i) => (i ? h.map(() => card(13)) : h)) },
      null,
    ),
  );
  assert.equal(
    imitationDecision({ ...game, hands: [[card(9)], ...game.hands.slice(1)] }, null),
    null,
  );
});

test('human imitation has one bounded registration, real human authorization, no deployment', () => {
  const start = Date.parse('2029-01-01T00:00:00Z'),
    p = {
      id: 'human-imitation-overall-20261115',
      humanTrainingAuthorized: true,
      webDeploymentAuthorized: false,
      restartExtendsDeadline: false,
      maxEpochs: 40,
      patience: 4,
      minDelta: 0.0001,
      startedAtUTC: new Date(start).toISOString(),
      trainingDeadlineUTC: new Date(start + 3600000).toISOString(),
      deadlineUTC: new Date(start + 5400000).toISOString(),
    };
  assert.doesNotThrow(() => validateImitationProtocol(p, start));
  assert.throws(() => validateImitationProtocol({ ...p, humanTrainingAuthorized: false }, start));
  assert.throws(() =>
    validateImitationProtocol(
      { ...p, deadlineUTC: new Date(start + 5500000).toISOString() },
      start,
    ),
  );
  assert.throws(() => validateImitationProtocol(p, start + 3600000));
});
