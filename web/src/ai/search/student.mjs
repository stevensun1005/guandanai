/** The held-out-tested hybrid: champion above32 cards, trained student at32 or fewer.
 * No hidden cards, belief sampling, exact solver or online gradient updates.
 */
import { candidates } from '../candidates.js';
import { policyState } from '../observation.js';
export const STUDENT_CORE_VERSION = 'endgame-student-v1';
export const STUDENT_THRESHOLD = 32;
export async function studentDecision(game, values, studentValues, offset = 0) {
  const player = game.turn;
  const plays = candidates(game.hands[player], game.L, game.trick?.play);
  const state = policyState(game, player, offset, plays);
  const base = await values(state);
  const tail = game.hands.reduce((n, hand) => n + hand.length, 0) <= STUDENT_THRESHOLD;
  const scores = tail ? await studentValues(state) : base;
  let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
  if (index < 0) index = scores.reduce((best, v, i) => (v > scores[best] ? i : best), 0);
  return {
    kind: tail ? 'endgame-student' : 'champion',
    plays,
    base,
    values: Array.from(scores),
    index,
    championIndex: base.reduce((best, v, i) => (v > base[best] ? i : best), 0),
  };
}
