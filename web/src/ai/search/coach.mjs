/**
 * Move-coach values of the belief-search research bot (danMCai-reason, menu id 9001) for the
 * human player's own turn. Same public information, worlds, budgets and settings as the bot's
 * decision in core.mjs; only the output differs: the coach keeps the searched VALUES instead of
 * one chosen move.
 *   midgame (lo..hi cards): mean signed round points over the belief worlds for the searched
 *     roots (champion top-k + pass), exactly midgameDecision's `means`; the other candidates
 *     are not evaluated (null);
 *   endgame (<= endgameHi cards): the mean exact PIMC value over the solved belief worlds for
 *     EVERY candidate, the same sums as pimcLabelFromWorlds; fewer than minWorlds solved worlds
 *     returns values null (the coach then shows the champion values, as the bot plays the
 *     champion move);
 *   other card counts: null.
 * The endgame solves world by world with `await ctx.pause?.()` in between, so a worker can take
 * a cancellation message between worlds; this does not change any value (same order of sums).
 * Exceeding the deadline throws SearchBudgetError, as for the bot: the coach then falls back to
 * the champion values as a whole.
 */
import { candidates } from '../candidates.js';
import { policyState } from '../observation.js';
import { SEARCH_BOT_V1 } from './constants.mjs';
import {
  argmax,
  beliefWorlds,
  guarded,
  midgameDecision,
  pimcLabelFromWorlds,
  remainingCards,
  searchBand,
} from './core.mjs';

export async function coachSearchValues(game, seed, ctx, params = SEARCH_BOT_V1) {
  const band = searchBand(remainingCards(game), params);
  if (band === 'midgame') {
    const decision = await midgameDecision(game, seed, ctx, params);
    const values = Array(decision.plays.length).fill(null);
    decision.roots.forEach((root, r) => (values[root] = decision.means[r]));
    return {
      kind: 'midgame',
      plays: decision.plays,
      base: decision.base,
      values,
      worlds: decision.worlds.length,
      evaluated: decision.roots.length,
      index: decision.index,
      championIndex: decision.championIndex,
    };
  }
  if (band !== 'endgame') return null;
  ctx.counter ||= { inferences: 0 };
  const guard = guarded(ctx, 'endgame');
  const player = game.turn;
  const plays = candidates(game.hands[player], game.L, game.trick?.play);
  const base = await guard.values(policyState(game, player, ctx.offset || 0, plays));
  const worlds = await beliefWorlds(game, seed, params.endgameWorlds, guard);
  const sums = new Float64Array(plays.length);
  let used = 0;
  for (const world of worlds) {
    await ctx.pause?.();
    const one = pimcLabelFromWorlds(game, plays, [world], ctx.solver, 1, guard.check, {
      timeIsBudget: !!ctx.solverTimeIsBudget,
      maxNodes: params.solverMaxNodes,
    });
    if (!one.q) continue; // the node limit skipped this world, as in the bot
    one.q.forEach((value, i) => (sums[i] += value));
    used++;
  }
  const values = used < params.minWorlds ? null : Array.from(sums, (sum) => sum / used);
  return {
    kind: 'endgame',
    plays,
    base,
    values,
    worlds: worlds.length,
    used,
    evaluated: values ? plays.length : 0,
    championIndex: argmax(base),
  };
}
