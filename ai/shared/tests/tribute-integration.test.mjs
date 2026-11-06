import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionCases } from '../tribute/scenarios.mjs';
import { encodeTribute, tributeActions } from '../tribute/encoding.mjs';
import { selectTribute } from '../tribute/select.mjs';
import { summarize } from '../tribute/evaluate.mjs';
import { tributeObservation, specialistHead } from '../../../web/src/ai/tribute-observation.mjs';
import { makeDeck } from '../../../web/src/core/cards.js';
import { resolveChampion } from '../tribute/champion.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('browser public tribute observations match simulator and never publish simultaneous picks', () => {
  const deck = makeDeck();
  let count = 0;
  for (let seed = 3799000000; seed < 3799000016; seed++)
    for (const state of decisionCases(seed)) {
      const game = {
        hands: [[], [], [], []],
        prevOut: state.previousOrder,
        L: state.level,
        levels: state.levels,
        leader: state.leader,
        returns: [{ from: state.player, to: state.recipient }],
        trib: state.publicOffers.map((o) => ({ g: o.from, r: o.to, tc: deck[o.id] })),
        tribPick: { 0: 99, 1: 100 },
      };
      game.hands[state.player] = state.hand.map((id) => deck[id]);
      const observed = tributeObservation(game, state.player, state.stage),
        id = tributeActions(state)[0];
      assert.deepEqual(encodeTribute(observed, id), encodeTribute(state, id));
      assert.equal(observed.hands, undefined);
      if (state.stage === 'tribute') assert.deepEqual(observed.publicOffers, []);
      count++;
    }
  assert(count > 10);
});

test('two heads choose independently, preserve baseline ties and reject malformed values', async () => {
  const state = decisionCases(3799000000).find((s) => s.stage === 'return'),
    actions = tributeActions(state),
    baseline = state.baseline;
  assert(actions.length > 1);
  const scores = Float32Array.from(actions.flatMap((_, i) => [i, -i]));
  assert.equal(await selectTribute(state, 0, async () => scores, baseline), actions.at(-1));
  assert.equal(await selectTribute(state, 1, async () => scores, baseline), actions[0]);
  assert.equal(
    (await selectTribute(state, 0, async () => new Float32Array(scores.length), baseline)) % 54,
    baseline % 54,
  );
  await assert.rejects(
    selectTribute(state, 0, async () => [NaN], baseline),
    /output/,
  );
});

test('paired evaluation counts real rounds, both double outcomes, and rejects incomplete seeds', () => {
  const rows = [
    { seed: 1, side: 0, winner: 0, points: 3, order: [0, 2, 1, 3] },
    { seed: 1, side: 1, winner: 0, points: 3, order: [0, 2, 1, 3] },
  ];
  const s = summarize(rows);
  assert.equal(s.rounds, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.doubleUps, 1);
  assert.equal(s.doubleDowns, 1);
  assert.equal(s.meanPairedPoints, 0);
  assert.deepEqual(s.ci95, [0, 0]);
  assert.throws(() => summarize(rows.slice(0, 1)), /Incomplete/);
});

test('only evaluated full SHA cohorts receive specialist, including GuanZero separate head', () => {
  const manifest = { enabled: true, approvedBaseSHA256: [['a'], ['b']] };
  assert.equal(specialistHead(manifest, { sha256: 'a', config: {} }), 0);
  assert.equal(specialistHead(manifest, { sha256: 'b', config: { history: 'guanzero-v1' } }), 1);
  assert.equal(specialistHead(manifest, { sha256: 'c', config: {} }), null);
  assert.equal(specialistHead({ ...manifest, enabled: false }, { sha256: 'a', config: {} }), null);
});

test('training teacher resolves accepted champion, rejects ordinary exports and tampered promotion', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const catalog = JSON.parse(readFileSync(root + 'web/src/ai/model-catalog.json'));
  const champion = resolveChampion(root, catalog);
  assert.equal(champion.id, catalog.selection.danMCaiChampions[0]);
  const ordinary = catalog.models.find((m) => m.config.history === 'guanzero-v1');
  assert.throws(
    () => resolveChampion(root, { ...catalog, selection: { danMCaiChampions: [ordinary.id] } }),
    /champion/,
  );
  const tampered = structuredClone(catalog);
  tampered.models.find((m) => m.id === champion.id).source.champion.evidenceSHA256 = '0'.repeat(64);
  assert.throws(() => resolveChampion(root, tampered), /mismatch/);
});
