import { runtime } from '../app/runtime.js';
import { initialize as initializeValue } from '../ai/hand-value.js';
import { initialize as initializeHints } from '../hand/hints.js';
import { chooseClintAction } from './endgame-brain.mjs';
import { clintTimeout } from './timeout.js';
import { CLINT_BRAIN_MS } from '../ai/turn-timing.mjs';

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
    // public table state the 残局大脑 needs (upstream brainOn / brainCore)
    phase: game.phase || 'play',
    turn: game.turn,
    passes: game.passes || 0,
    out: (game.out || []).slice(),
  };
}

/*
 * Upstream allows 30 s (BRAIN.ms) per brain decision, and so does the page (owner rule 2026-11-09,
 * web/src/ai/turn-timing.mjs): the controller sends `brainMs`, the time left to the turn's 50 s
 * reasoning mark capped at 30 s, the rule-worker request waits until 52 s, and an overrun or a failed
 * worker plays the rules-only move. Not sticky: every move asks for the brain again.
 */
export const WEB_BRAIN = Object.freeze({ ms: CLINT_BRAIN_MS });
/** No hand is ever above -1 cards, so brainOn is false: the Clint rules alone (practice generation). */
export const RULES_ONLY = Object.freeze({ max: -1 });

/**
 * Brain settings for a request with `brainMs` left (undefined: the full WEB_BRAIN). Less than one
 * millisecond left plays the rules only.
 */
export function clintBrainSettings(brainMs) {
  if (brainMs === undefined || brainMs === null) return WEB_BRAIN;
  if (!(brainMs >= 1)) return RULES_ONLY;
  return Object.freeze({ ms: Math.min(CLINT_BRAIN_MS, brainMs) });
}

let initialized = false;
const views = new Map();
export function decideClintRule(observation, settings = WEB_BRAIN) {
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
    const play = chooseClintAction(player, settings);
    return play && { ...play, cards: play.cards.map((card) => card.id) };
  } finally {
    runtime.game = previous;
  }
}
