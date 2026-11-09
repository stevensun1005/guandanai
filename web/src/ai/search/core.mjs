/**
 * Browser port of the held-out-tested belief-search bot (MODEL_STUDY 70.4 / 71.2):
 *   ai/danMCai/belief/midgame-search.mjs --worlds-source=belief --endgame=pimc --endgame-hi=20
 *   --endgame-worlds=belief, defaults lo 21, hi 40, worlds 8, k 6, net 2.
 * The research files stay byte-frozen (their run.json source closures record them), so the
 * decision code is copied here; `web/tests/search-bot.test.mjs` checks that it makes exactly the
 * Node choices on fixed positions. Differences from Node, all outside a completed decision:
 *   - champion values, belief probabilities and the clock are injected (WASM in the browser);
 *   - `offset` is passed to policyState (Node always plays offset 0; the deciding device in the
 *     web game is solo or the host, whose offset is also 0);
 *   - a deadline is checked before every champion / belief inference and every exact-solver call;
 *     exceeding it throws SearchBudgetError and the whole search is discarded (never a partial
 *     midgame or an endgame that has not attempted all 8 worlds);
 *   - an exact-solver call is capped by the time left to that deadline (ctx.cappedSolver), and a
 *     capped call that stops discards the whole search too.
 * Only the mover's hand and public information reach this module (see payload.mjs).
 */
import { advanceRound } from '../../../../ai/shared/simulation/simulation.mjs';
import { searchObservation } from '../../../../ai/shared/search/pimc.mjs';
import { sampleBeliefWorlds } from '../../../../ai/danMCai/belief/sampler.mjs';
import { publicView } from '../../../../ai/danMCai/belief/features.mjs';
import { SolverBudget } from '../../../../ai/danMCai/endgame/solver.mjs';
import { candidates } from '../candidates.js';
import { policyState } from '../observation.js';
import { makeDeck } from '../../core/cards.js';
import { NODE_SOLVER_MS, SEARCH_BOT_V1, searchBand, worldSeed } from './constants.mjs';

export { searchBand };

const deck = makeDeck();

export class SearchBudgetError extends Error {
  constructor(stage) {
    super(`Search budget exceeded (${stage})`);
    this.name = 'SearchBudgetError';
    this.stage = stage;
  }
}

/** First index of the maximum (as argmax in ai/danMCai/training/continuous/lib.mjs). */
export function argmax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

export const remainingCards = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);

/** Net-d choice (midgame-search.mjs netChoice). */
export function netChoice({ roots, championIndex, means, outcome, base, net }) {
  const c = roots.indexOf(championIndex);
  if (c < 0) throw Error('Champion move must be among the searched roots');
  const allowed = roots.map((_, r) => {
    if (r === c || !(net > 0)) return true;
    let wins = 0;
    for (const o of outcome) wins += Math.sign(o[r] - o[c]);
    return wins >= net && means[r] > means[c] + 1e-9;
  });
  const top = Math.max(...means.filter((_, r) => allowed[r]));
  const tied = roots.filter((_, r) => allowed[r] && means[r] >= top - 1e-9);
  const index = tied.reduce((best, i) => (base[i] > base[best] ? i : best), tied[0]);
  return { index, tied, allowed, gain: top - means[c] };
}

/** Champion top-K distinct action indices by Q (ties by index), plus pass if legal. */
export function searchRootsOf(base, plays, k) {
  const order = Array.from(base, (_, i) => i).sort((a, b) => base[b] - base[a] || a - b);
  const roots = order.slice(0, k);
  const passIndex = plays.findIndex((p) => p === null);
  if (passIndex >= 0 && !roots.includes(passIndex)) roots.push(passIndex);
  return roots;
}

/** Game copy whose hands are a sampled world (physical ids); public fields copied from `game`. */
function worldGame(game, hands) {
  return {
    hands: hands.map((hand) => hand.map((id) => deck[id])),
    L: game.L,
    levels: game.levels.slice(),
    log: game.log.slice(),
    trick: game.trick ? { player: game.trick.player, play: game.trick.play } : null,
    passes: game.passes,
    out: game.out.slice(),
    turn: game.turn,
  };
}

/** Context helpers: budget-checked champion values and belief probabilities. */
export function guarded(ctx, stage) {
  const check = () => {
    if (ctx.deadline !== undefined && ctx.now() > ctx.deadline) throw new SearchBudgetError(stage);
  };
  return {
    check,
    async values(state) {
      check();
      ctx.counter.inferences++;
      return ctx.values(state);
    },
    async probabilities(view) {
      check();
      return ctx.probabilities(view);
    },
  };
}

async function greedy(game, offset, guard) {
  const player = game.turn;
  const plays = candidates(game.hands[player], game.L, game.trick?.play);
  let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
  if (index < 0 && plays.length === 1) index = 0;
  if (index < 0) index = argmax(await guard.values(policyState(game, player, offset, plays)));
  return plays[index];
}

async function rollout(world, play, moverTeam, offset, guard) {
  let result = advanceRound(world, play);
  for (let ply = 0; !result && ply < 1000; ply++)
    result = advanceRound(world, await greedy(world, offset, guard));
  if (!result) throw Error('Rollout did not terminate');
  return result.winner === moverTeam ? result.points : -result.points;
}

/** Belief worlds from the mover's public information only (sampleSearchWorlds, belief branch). */
export async function beliefWorlds(game, seed, count, guard) {
  const player = game.turn;
  const observation = searchObservation(game, player);
  const probs = await guard.probabilities(publicView(game, player));
  return sampleBeliefWorlds(observation, probs, {
    count,
    seed: worldSeed(seed, game.log.length),
  });
}

/**
 * Midgame net-2 rollout search on a MASKED game (midgame-search.mjs searchDecision).
 * ctx = {values(state), probabilities(view), now(), deadline?, offset?, counter?}; the endgame
 * also takes ctx.solver, ctx.solverTimeIsBudget and, to cap calls at the deadline, ctx.solverMs
 * and ctx.cappedSolver(ms).
 */
export async function midgameDecision(game, seed, ctx, params = SEARCH_BOT_V1) {
  ctx.counter ||= { inferences: 0 };
  const guard = guarded(ctx, 'midgame');
  const offset = ctx.offset || 0;
  const player = game.turn;
  const plays = candidates(game.hands[player], game.L, game.trick?.play);
  const base = await guard.values(policyState(game, player, offset, plays));
  const championIndex = argmax(base);
  const roots = searchRootsOf(base, plays, params.k);
  const worlds = await beliefWorlds(game, seed, params.worlds, guard);
  const sums = new Float64Array(roots.length);
  const outcome = worlds.map(() => new Float64Array(roots.length));
  for (let w = 0; w < worlds.length; w++)
    for (let r = 0; r < roots.length; r++) {
      outcome[w][r] = await rollout(
        worldGame(game, worlds[w]),
        plays[roots[r]],
        player % 2,
        offset,
        guard,
      );
      sums[r] += outcome[w][r];
    }
  const means = Array.from(sums, (s) => s / worlds.length);
  const choice = netChoice({ roots, championIndex, means, outcome, base, net: params.net });
  return { kind: 'midgame', ...choice, plays, base, championIndex, roots, means, outcome, worlds };
}

const forMover = (team0Value, seat) => (seat % 2 === 0 ? team0Value : -team0Value);

/**
 * midgame-search.mjs pimcLabelFromWorlds with a deadline before every exact-solver call. With
 * `timeIsBudget` (a per-call solver limit shorter than Node's NODE_SOLVER_MS), a call stopped by the
 * clock rather than by the node limit throws SearchBudgetError instead of skipping the world.
 * With `remaining` (ms left to the deadline) and `cappedSolver(ms)`, a call that starts with less
 * than `solverMs` left runs on a solver limited to the time left, so no call runs past the
 * deadline; any stop of such a capped call throws SearchBudgetError (the tested rule would have
 * given that world the full per-call limit and the shared table), and a capped call that finishes
 * returns the same exact value.
 */
export function pimcLabelFromWorlds(
  game,
  plays,
  worlds,
  solver,
  minWorlds,
  check = () => {},
  {
    timeIsBudget = false,
    maxNodes = SEARCH_BOT_V1.solverMaxNodes,
    remaining = null,
    cappedSolver = null,
    solverMs = NODE_SOLVER_MS,
  } = {},
) {
  const sums = new Float64Array(plays.length);
  let used = 0;
  for (const hands of worlds) {
    const position = {
      hands: hands.map((hand) => hand.map((id) => deck[id])),
      L: game.L,
      turn: game.turn,
      trick: game.trick ? { player: game.trick.player, play: game.trick.play } : null,
      passes: game.passes,
      out: game.out.slice(),
    };
    const values = [];
    let skipped = false;
    for (const play of plays) {
      check();
      const left = remaining ? remaining() : Infinity;
      const capped = !!cappedSolver && left < solverMs;
      try {
        const callSolver = capped ? cappedSolver(Math.max(0, left)) : solver;
        values.push(forMover(callSolver.actionValue(position, play), position.turn));
      } catch (error) {
        if (!(error instanceof SolverBudget)) throw error;
        if (capped || (timeIsBudget && !(error.nodes > maxNodes)))
          throw new SearchBudgetError('endgame');
        skipped = true;
        break;
      }
    }
    if (skipped) continue;
    values.forEach((v, i) => (sums[i] += v));
    used++;
  }
  if (used < minWorlds) return { q: null, used };
  return { q: Array.from(sums, (s) => s / used), used };
}

/** pimcLabelFromWorlds options of a search context (shared by the bot and the move coach). */
export const solverOptions = (ctx, params = SEARCH_BOT_V1) => ({
  timeIsBudget: !!ctx.solverTimeIsBudget,
  maxNodes: params.solverMaxNodes,
  remaining: ctx.deadline !== undefined ? () => ctx.deadline - ctx.now() : null,
  cappedSolver: ctx.cappedSolver || null,
  solverMs: ctx.solverMs ?? NODE_SOLVER_MS,
});

/** evaluate.mjs searchChoice's rule: argmax, ties within tolerance to the champion's Q. */
export function pimcPick({ q, used }, base, tolerance = SEARCH_BOT_V1.tieTolerance) {
  if (!q) return { index: null, used, tied: 0 };
  const top = Math.max(...q);
  const tied = [];
  q.forEach((y, i) => Math.abs(y - top) <= tolerance && tied.push(i));
  const index = tied.reduce((best, i) => (base[i] > base[best] ? i : best), tied[0]);
  return { index, used, tied: tied.length };
}

/**
 * Endgame 8-world exact PIMC with belief worlds on a MASKED game (midgame-search.mjs
 * endgameDecision, belief branch). `ctx.solver` = createSolver(...). Fewer than minWorlds solved
 * worlds plays the champion move (as in Node: `minWorldsFallback`, still the tested bot's rule).
 */
export async function endgameDecision(game, seed, ctx, params = SEARCH_BOT_V1) {
  ctx.counter ||= { inferences: 0 };
  const guard = guarded(ctx, 'endgame');
  const offset = ctx.offset || 0;
  const player = game.turn;
  const plays = candidates(game.hands[player], game.L, game.trick?.play);
  const base = await guard.values(policyState(game, player, offset, plays));
  const championIndex = argmax(base);
  const worlds = await beliefWorlds(game, seed, params.endgameWorlds, guard);
  const choice = pimcPick(
    pimcLabelFromWorlds(
      game,
      plays,
      worlds,
      ctx.solver,
      params.minWorlds,
      guard.check,
      solverOptions(ctx, params),
    ),
    base,
    params.tieTolerance,
  );
  return {
    kind: 'endgame',
    index: choice.index ?? championIndex,
    minWorldsFallback: choice.index === null,
    used: choice.used,
    tied: choice.tied,
    championIndex,
    plays,
    base,
    worlds,
  };
}

/**
 * Full decision of the research bot for the seat to move of a MASKED game: midgame search at
 * lo..hi cards, endgame search at <= endgameHi cards, else null (the caller plays the champion).
 * Finishing moves and single candidates are the caller's (they never reach the search in Node).
 */
export async function searchBotDecision(game, seed, ctx, params = SEARCH_BOT_V1) {
  const band = searchBand(remainingCards(game), params);
  if (band === 'midgame') return midgameDecision(game, seed, ctx, params);
  if (band === 'endgame') return endgameDecision(game, seed, ctx, params);
  return null;
}
