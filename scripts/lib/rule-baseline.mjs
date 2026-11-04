import { runtime } from '../../src/app/runtime.js';
import { initialize as initializeHandValue } from '../../src/ai/hand-value.js';
import { aiDecide, initialize as initializeRules } from '../../src/ai/rule-policy.js';
import { initialize as initializeArrangement } from '../../src/hand/arrangement.js';
import { initialize as initializeHints } from '../../src/hand/hints.js';
import { seededRandom } from './simulation.mjs';

let initialized = false;

/** Run the existing rule player unchanged, with only public information and its own hand. */
export function createRuleBaseline(seed) {
  if (!initialized) {
    initializeHandValue();
    initializeArrangement();
    initializeHints();
    initializeRules();
    initialized = true;
  }
  const random = seededRandom(seed);
  const views = new WeakMap();
  return (game, player = game.turn) => {
    let view = views.get(game);
    if (!view) {
      view = { hands: [[], [], [], []], pw: [] };
      views.set(game, view);
    }
    // No opponent card objects cross this boundary; only public hand lengths do.
    for (let seat = 0; seat < 4; seat++)
      view.hands[seat] = seat === player ? game.hands[seat] : new Array(game.hands[seat].length);
    Object.assign(view, {
      L: game.L,
      trick: game.trick,
      log: game.log,
      seen: game.log.flatMap((entry) => entry.cards || []),
    });
    const previousGame = runtime.game;
    const previousRandom = Math.random;
    runtime.game = view;
    Math.random = random;
    try {
      return aiDecide(player);
    } finally {
      runtime.game = previousGame;
      Math.random = previousRandom;
    }
  };
}
