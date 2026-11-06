import { createRound } from './simulation.mjs';
import { roundOutcome } from '../../../web/src/core/match.js';
import { makeDeck, val, sortHand } from '../../../web/src/core/cards.js';
import { tributeOptions, returnOptions } from '../../../web/src/core/tribute.js';
import { aiReturnCard } from '../../../web/src/ai/rule-policy.js';
import { createRuleBaseline } from './rule-baseline.mjs';

/** Public observations at simultaneous tribute/return decisions. Full hands stay inside the simulator. */
export function* matchTributeSteps(game, order) {
  const dbl = order[0] % 2 === order[1] % 2;
  const givers = dbl ? [order[2], order[3]] : [order[3]];
  if (givers.reduce((sum, p) => sum + game.hands[p].filter((c) => c.r === 17).length, 0) >= 2)
    return { leader: order[0], resisted: true, transfers: [] };
  const observation = (stage, p, recipient, leader, publicOffers) => ({
    stage,
    player: p,
    hand: game.hands[p].map((c) => c.id),
    level: game.L,
    levels: game.levels.slice(),
    previousOrder: order.slice(),
    recipient,
    leader,
    publicOffers: publicOffers.map((o) => ({ from: o.p, to: o.to, id: o.card.id })),
    options: (stage === 'tribute' ? tributeOptions : returnOptions)(game.hands[p], game.L).map(
      (c) => c.id,
    ),
  });
  const choose = function* (stage, p, recipient, leader, publicOffers) {
    const obs = observation(stage, p, recipient, leader, publicOffers);
    const id = yield obs;
    if (!obs.options.includes(id)) throw Error('Illegal tribute/return action');
    return game.hands[p].find((c) => c.id === id);
  };
  const offers = [];
  for (const p of givers)
    offers.push({ p, card: yield* choose('tribute', p, dbl ? null : order[0], null, []) });
  if (dbl) offers.sort((a, b) => val(b.card, game.L) - val(a.card, game.L));
  const receivers = dbl ? order.slice(0, 2) : [order[0]];
  const transfers = [];
  function give(from, to, card) {
    game.hands[from] = game.hands[from].filter((c) => c.id !== card.id);
    game.hands[to].push(card);
    sortHand(game.hands[to], game.L);
    transfers.push({ from, to, id: card.id });
  }
  offers.forEach((offer, i) => {
    offer.to = receivers[i];
    give(offer.p, receivers[i], offer.card);
  });
  const returns = [];
  for (let i = 0; i < offers.length; i++)
    returns.push({
      from: receivers[i],
      to: offers[i].p,
      card: yield* choose('return', receivers[i], offers[i].p, offers[0].p, offers),
    });
  returns.forEach((x) => give(x.from, x.to, x.card));
  if (
    game.hands.some((hand) => hand.length !== 27) ||
    new Set(game.hands.flat().map((c) => c.id)).size !== 108
  )
    throw Error('Tribute violated card conservation');
  return { leader: offers[0].p, resisted: false, transfers };
}

export function baselineTributeChoice(observation) {
  if (observation.stage === 'tribute') return observation.options[0];
  const deck = makeDeck();
  return aiReturnCard(
    observation.hand.map((id) => deck[id]),
    observation.level,
  ).id;
}

export function applyMatchTribute(game, order, select = baselineTributeChoice) {
  const steps = matchTributeSteps(game, order);
  let step = steps.next();
  while (!step.done) step = steps.next(select(step.value));
  return step.value;
}

export async function applyLearnedTribute(game, order, select) {
  const steps = matchTributeSteps(game, order);
  let step = steps.next();
  while (!step.done) step = steps.next(await select(step.value));
  return step.value;
}

export function createMatchRound(seed, match) {
  createRuleBaseline(seed); // Initialize the existing tribute/return policies for both teams.
  const game = createRound(seed);
  game.levels = match.levels.slice();
  game.L = match.levels[match.lvlTeam];
  game.match = match;
  game.hands.forEach((hand) => sortHand(hand, game.L));
  if (match.previousOrder) game.turn = applyMatchTribute(game, match.previousOrder).leader;
  return game;
}

export function advanceMatch(match, game, result, aFail = 'draw') {
  const next = roundOutcome({ ...match, L: game.L }, result.order, aFail);
  return { ...next, round: match.round + 1, previousOrder: result.order.slice() };
}
