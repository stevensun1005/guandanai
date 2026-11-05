import { ENDGAME_MAX_CARDS, solvePublicEndgame } from '../../../web/src/ai/endgame.js';

export function publicEnding(context, plays, values, endgameCards = ENDGAME_MAX_CARDS) {
  const active = context.counts
    .map((count, seat) => (count ? seat : -1))
    .filter((seat) => seat >= 0);
  if (active.length !== 2 || context.counts.reduce((a, b) => a + b, 0) > endgameCards) return null;
  let passes = 0;
  if (context.trick)
    for (let index = context.log.length - 1; index >= 0 && !context.log[index].cards; index--)
      passes++;
  const state = {
    p: context.p,
    hand: context.hand.map((card) => card.id),
    counts: context.counts,
    log: context.log.map((entry) => ({
      p: entry.p,
      cards: entry.cards?.map((card) => card.id) || null,
    })),
    level: context.level,
    actions: plays.map((play) => play?.cards.map((card) => card.id) || []),
    endgame: {
      trick: context.trick,
      passes,
      shapes: plays.map((play) => play && { type: play.type, n: play.n, value: play.value }),
    },
  };
  return solvePublicEndgame(state, values);
}
