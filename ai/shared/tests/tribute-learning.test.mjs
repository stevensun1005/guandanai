import test from 'node:test';
import assert from 'node:assert/strict';
import { scenario, decisionCases, intervene } from '../tribute/scenarios.mjs';
import { tributeActions, encodeTribute, TRIBUTE_FEATURES } from '../tribute/encoding.mjs';
import {
  matchTributeSteps,
  applyMatchTribute,
  baselineTributeChoice,
  applyLearnedTribute,
} from '../simulation/match-simulation.mjs';
import { tributeOptions } from '../../../web/src/core/tribute.js';
import { val, sortHand } from '../../../web/src/core/cards.js';
import { aiReturnCard } from '../../../web/src/ai/rule-policy.js';

// Frozen legacy transfer logic kept in this parity check, not used as a learned target.
function legacy(game, order) {
  const dbl = order[0] % 2 === order[1] % 2,
    givers = dbl ? [order[2], order[3]] : [order[3]];
  if (givers.reduce((n, p) => n + game.hands[p].filter((c) => c.r === 17).length, 0) >= 2)
    return { leader: order[0], resisted: true, transfers: [] };
  const offers = givers.map((p) => ({ p, card: tributeOptions(game.hands[p], game.L)[0] }));
  if (dbl) offers.sort((a, b) => val(b.card, game.L) - val(a.card, game.L));
  const receivers = dbl ? order.slice(0, 2) : [order[0]],
    transfers = [];
  const give = (from, to, card) => {
    game.hands[from] = game.hands[from].filter((c) => c.id !== card.id);
    game.hands[to].push(card);
    sortHand(game.hands[to], game.L);
    transfers.push({ from, to, id: card.id });
  };
  offers.forEach((o, i) => give(o.p, receivers[i], o.card));
  const returns = offers.map((o, i) => ({
    from: receivers[i],
    to: o.p,
    card: aiReturnCard(game.hands[receivers[i]], game.L),
  }));
  returns.forEach((o) => give(o.from, o.to, o.card));
  return { leader: offers[0].p, resisted: false, transfers };
}

test('default and async tribute drivers match the old transfer protocol exactly', async () => {
  for (let seed = 3799000000; seed < 3799000064; seed++) {
    const { game, order } = scenario(seed),
      old = structuredClone(game),
      asyncGame = structuredClone(game);
    assert.deepEqual(applyMatchTribute(game, order), legacy(old, order));
    assert.deepEqual(game.hands, old.hands);
    assert.deepEqual(
      await applyLearnedTribute(asyncGame, order, async (obs) => baselineTributeChoice(obs)),
      legacy(structuredClone(scenario(seed).game), order),
    );
  }
});

test('counterfactual tribute actions remain legal and conserve all physical cards', () => {
  let tested = 0;
  for (let seed = 3799000000; seed < 3799000016; seed++)
    for (const s of decisionCases(seed))
      for (const id of tributeActions(s)) {
        const game = intervene(seed, s, id);
        assert(game.hands.every((h) => h.length === 27));
        assert.equal(new Set(game.hands.flat().map((c) => c.id)).size, 108);
        tested++;
      }
  assert(tested > 100);
});

test('389-feature specialist input depends only on own cards and public transfers', () => {
  const state = decisionCases(3799000000).find((s) => s.stage === 'return'),
    id = tributeActions(state)[0];
  const a = encodeTribute(state, id);
  assert.equal(a.length, TRIBUTE_FEATURES);
  assert(a.every((v) => v >= 0 && v <= 2));
  assert.deepEqual(
    a,
    encodeTribute(
      { ...state, hands: [[99], [98], [97], [96]], secretOpponentCards: [1, 2, 3] },
      id,
    ),
  );
  const rotated = {
    ...state,
    player: (state.player + 1) % 4,
    levels: [state.levels[1], state.levels[0]],
    previousOrder: state.previousOrder.map((p) => (p + 1) % 4),
    recipient: (state.recipient + 1) % 4,
    leader: (state.leader + 1) % 4,
    publicOffers: state.publicOffers.map((o) => ({
      ...o,
      from: (o.from + 1) % 4,
      to: (o.to + 1) % 4,
    })),
  };
  assert.deepEqual(a, encodeTribute(rotated, id));
  const paying = decisionCases(3799000001).find((s) => s.stage === 'tribute');
  if (paying)
    assert.throws(
      () =>
        encodeTribute({ ...paying, publicOffers: [{ from: 1, id: 1 }] }, tributeActions(paying)[0]),
      /Unrevealed/,
    );
  assert.throws(() => encodeTribute(state, 108));
});
