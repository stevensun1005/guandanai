import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDeck } from '../../../web/src/core/cards.js';
import { analyze } from '../../../web/src/core/combinations.js';
import { cooperationLabels, humanRecordLabels } from '../evaluation/cooperation-labels.mjs';
import { collectedRound } from '../../../web/tests/fixtures/collected-round.mjs';
import { describeAction, unseenPhysicalCards } from '../../../web/src/analysis/concepts.mjs';
import { createRound } from '../../shared/simulation/simulation.mjs';
import { policyState } from '../../../web/src/ai/observation.js';

const deck = makeDeck();
test('D1 adapter excludes tests, assisted and automatic actions without exposing other hands', async () => {
  const record = collectedRound(9301000);
  assert.deepEqual(await humanRecordLabels(record), []);
  record.kind = 'game';
  record.actions.find((a) => a.actor === 'human').assisted = true;
  let calls = 0;
  const result = await humanRecordLabels(record, {
    score: async (state) => {
      calls++;
      assert.ok(!('hands' in state));
      assert.ok(state.hand.every((id) => record.hands[state.p].includes(id)));
      return new Float32Array(state.actions.length);
    },
  });
  assert.equal(calls, result.length);
  assert.equal(
    result.length,
    record.actions.filter((a) => a.actor === 'human' && !a.assisted).length,
  );
  assert.ok(result.every((r) => r.source === 'unverified_browser' && !r.assisted));
});
const cases = [
  [0, null, 'single', false, false],
  [1, null, 'single', false, false],
  [2, null, 'bomb', false, false],
  [3, null, 'bomb', false, false],
  [0, 2, 'single', true, false],
  [1, 3, 'single', true, false],
  [2, 0, 'single', true, false],
  [3, 1, 'single', true, false],
  [0, 2, 'bomb', true, true],
  [1, 3, 'bomb', true, true],
  [2, 0, 'bomb', true, true],
  [3, 1, 'bomb', true, true],
  [0, 1, 'single', false, false],
  [1, 2, 'bomb', false, false],
  [2, 3, 'single', false, false],
  [3, 0, 'bomb', false, false],
  [0, 2, 'pass', false, false],
  [1, 3, 'pass', false, false],
  [2, 1, 'pass', false, false],
  [3, 2, 'pass', false, false],
];
test('20 explicit replay cases: lead, pass, partner/opponent overtake and bomb labels', async () => {
  for (const [p, owner, kind, over, bomb] of cases) {
    const cards = kind === 'bomb' ? [1, 14, 27, 40] : [1];
    const game = {
      hands: [[8], [9], [10], [11]].map((h) => h.map((id) => deck[id])),
      L: 14,
      levels: [14, 14],
      turn: p,
      passes: 0,
      out: [],
      log: [],
      trick: owner === null ? null : { player: owner, play: analyze([deck[0]], 14)[0] },
    };
    game.hands[p] = [...cards, 7].map((id) => deck[id]);
    const before = structuredClone(game);
    const labels = await cooperationLabels(game, [{ p, cards: kind === 'pass' ? null : cards }]);
    assert.equal(labels[0].overPartner, over);
    assert.equal(labels[0].bombOverPartner, bomb);
    assert.equal(labels[0].passed, kind === 'pass');
    assert.deepEqual(game, before);
  }
});

test('descriptions preserve all values, candidates and ranking across 200 fixture states', () => {
  for (let i = 0; i < 200; i++) {
    const g = createRound(8000 + i),
      p = g.turn;
    const play = { ...analyze([g.hands[p][0]], g.L)[0], cards: [g.hands[p][0]] };
    const s = policyState(g, p, 0, [play]);
    const values = Float32Array.of(Math.sin(i), Math.cos(i), 0);
    const before = JSON.stringify(s),
      raw = values.slice();
    describeAction(s, play);
    assert.equal(JSON.stringify(s), before);
    assert.deepEqual(values, raw);
    assert.equal(unseenPhysicalCards(s).length, 81);
  }
  const text = readFileSync(
    new URL('../../../web/src/analysis/concepts.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(text, /rule-bot|chooseRuleAction/);
});
