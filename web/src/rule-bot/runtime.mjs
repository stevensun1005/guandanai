import { runtime } from '../app/runtime.js';
import { initialize as initializeValue } from '../ai/hand-value.js';
import { initialize as initializeHints } from '../hand/hints.js';
import { chooseRuleAction } from './strategy.js';
import { clintTimeout } from './timeout.js';

export function decideClintTimeout(observation) {
  const play = clintTimeout(
    observation.hands[observation.player],
    observation.L,
    observation.trick,
    observation.fixed || [],
  );
  return play && { ...play, cards: play.cards.map((c) => c.id) };
}

/** Only this seat's physical cards and public information cross the Worker boundary. */
export function ruleObservation(game, player) {
  return {
    player,
    roundKey: `${game.tok}:${game.round}`,
    L: game.L,
    hands: game.hands.map((hand, seat) => (seat === player ? hand : new Array(hand.length))),
    trick: game.trick,
    log: game.log,
    seen: game.log.flatMap((entry) => entry.cards || []),
    trib: game.trib || [],
  };
}

let initialized = false;
const views = new Map();
export function decideClintRule(observation) {
  if (!initialized) {
    initializeValue();
    initializeHints();
    initialized = true;
  }
  const player = observation.player;
  let view = views.get(player);
  if (view?.roundKey !== observation.roundKey) {
    view = { pw: [] };
    views.set(player, view);
  }
  Object.assign(view, observation);
  const previous = runtime.game;
  runtime.game = view;
  try {
    const play = chooseRuleAction(player);
    return play && { ...play, cards: play.cards.map((card) => card.id) };
  } finally {
    runtime.game = previous;
  }
}
