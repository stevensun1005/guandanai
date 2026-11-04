import { createRound } from './simulation.mjs';
import { roundOutcome } from '../../src/core/match.js';
import { val, sortHand } from '../../src/core/cards.js';
import { tributeOptions } from '../../src/core/tribute.js';
import { aiReturnCard } from '../../src/ai/rule-policy.js';
import { createRuleBaseline } from './rule-baseline.mjs';

export function applyMatchTribute(game, order) {
  const dbl = order[0] % 2 === order[1] % 2;
  const givers = dbl ? [order[2], order[3]] : [order[3]];
  if (givers.reduce((sum, p) => sum + game.hands[p].filter((c) => c.r === 17).length, 0) >= 2)
    return { leader: order[0], resisted: true, transfers: [] };
  const offers = givers.map((p) => ({ p, card: tributeOptions(game.hands[p], game.L)[0] }));
  if (dbl) offers.sort((a, b) => val(b.card, game.L) - val(a.card, game.L));
  const receivers = dbl ? order.slice(0, 2) : [order[0]];
  const transfers = [];
  function give(from, to, card) {
    game.hands[from] = game.hands[from].filter((c) => c.id !== card.id);
    game.hands[to].push(card);
    sortHand(game.hands[to], game.L);
    transfers.push({ from, to, id: card.id });
  }
  offers.forEach((offer, i) => give(offer.p, receivers[i], offer.card));
  const returns = offers.map((offer, i) => ({
    from: receivers[i],
    to: offer.p,
    card: aiReturnCard(game.hands[receivers[i]], game.L),
  }));
  returns.forEach((x) => give(x.from, x.to, x.card));
  if (
    game.hands.some((hand) => hand.length !== 27) ||
    new Set(game.hands.flat().map((c) => c.id)).size !== 108
  )
    throw Error('Tribute violated card conservation');
  return { leader: offers[0].p, resisted: false, transfers };
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
