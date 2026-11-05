import { runtime } from '../../../web/src/app/runtime.js';
import { initialize as initializeHandValue } from '../../../web/src/ai/hand-value.js';
import { aiDecide, initialize as initializeRules } from '../../../web/src/ai/rule-policy.js';
import { initialize as initializeArrangement } from '../../../web/src/hand/arrangement.js';
import { initialize as initializeHints } from '../../../web/src/hand/hints.js';
import { seededRandom } from './simulation.mjs';
import { chooseRuleAction } from '../../../web/src/rule-bot/strategy.js';

let initialized = false;

export const RULE_OPPONENT_VERSION = 'rules-v2';

/** Rule-only decisions; select original explicitly when reproducing historical evaluations. */
export function createRuleOpponent(seed) {
  return createRuleBaseline(seed, { version: RULE_OPPONENT_VERSION });
}

export function createRuleBaseline(seed, { version = 'original' } = {}) {
  if (!['original', RULE_OPPONENT_VERSION].includes(version)) throw Error('Unknown rule opponent');
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
      trib: game.trib || [],
    });
    const previousGame = runtime.game;
    const previousRandom = Math.random;
    runtime.game = view;
    Math.random = random;
    try {
      return version === 'original' ? aiDecide(player) : chooseRuleAction(player);
    } finally {
      runtime.game = previousGame;
      Math.random = previousRandom;
    }
  };
}
