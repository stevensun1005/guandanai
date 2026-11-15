import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../../../web/src/core/cards.js';
import { policyState } from '../../../web/src/ai/observation.js';
import {
  cohortOf,
  compareDecision,
  summarizeRows,
  pairedMatchIntervals,
} from '../tools/analyze-human-play.mjs';

test('human comparison separates assistance, excludes forced actions, and compares paired opportunities', async () => {
  assert.equal(cohortOf({ actor: 'human', assisted: true }), 'human-assisted');
  assert.equal(cohortOf({ actor: 'human' }), 'human-assistance-unknown');
  assert.equal(cohortOf({ actor: 'timeout' }), 'timeout');
  const base = {
    match: 'one',
    cohort: 'human-assistance-unknown',
    plans: 3,
    covered: true,
    lead: false,
    partnerTrick: true,
    canRespond: true,
    canBomb: true,
    handSize: 12,
    actualType: 'pass',
    actualCards: 0,
    choices: { '029': { samePlan: false, auto: null, type: 'bomb', cards: 4 } },
  };
  const rows = [
    base,
    { ...base, cohort: 'human-assisted' },
    { ...base, cohort: 'bot' },
    {
      ...base,
      match: 'two',
      actualType: 'single',
      actualCards: 1,
      choices: { '029': { samePlan: false, auto: null, type: 'pass', cards: 0 } },
    },
    {
      ...base,
      plans: 1,
      choices: { '029': { samePlan: true, auto: 'single', type: 'pass', cards: 0 } },
    },
  ];
  const s = summarizeRows(rows);
  assert.equal(s.observedActions, 3);
  assert.equal(s.decisionOpportunities, 2);
  assert.deepEqual(s.follow.pass, {
    human: { numerator: 1, denominator: 2, rate: 0.5 },
    model: { numerator: 1, denominator: 2, rate: 0.5 },
  });
  assert.equal(s.partner.play.human.rate, 0.5);
  assert.equal(s.bomb.play.model.rate, 0.5);
  assert.deepEqual(pairedMatchIntervals(rows, '029', 20), pairedMatchIntervals(rows, '029', 20));
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
  const values = async (_file, state) => {
    assert.ok(!('hands' in state));
    assert.deepEqual(
      state.hand,
      game.hands[0].map((c) => c.id),
    );
    return state.actions.map((ids) => (ids.includes(card(9).id) ? 1 : 0));
  };
  const first = await compareDecision(game, null, [{ id: '029', file: 'fake' }], values);
  assert.equal(first.choices['029'].type, 'single');
  assert.equal(first.choices['029'].samePlan, false);
  const altered = { ...game, hands: game.hands.map((h, i) => (i ? h.map(() => card(13)) : h)) };
  assert.deepEqual(policyState(game, 0, 0, []), policyState(altered, 0, 0, []));
  assert.deepEqual(
    first,
    await compareDecision(altered, null, [{ id: '029', file: 'fake' }], values),
  );
});
