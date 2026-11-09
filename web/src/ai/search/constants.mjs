/**
 * Frozen settings of the belief-search research bot (menu id 9001): the held-out-tested Node bot
 * `ai/danMCai/belief/midgame-search.mjs --worlds-source=belief --endgame=pimc --endgame-hi=20
 * --endgame-worlds=belief` with its defaults (MODEL_STUDY 70.4 / 71.2). A Node test checks these
 * against midgame-search DEFAULTS and evaluate.mjs SEARCH, so a drift fails `npm test`.
 */
export const SEARCH_CORE_VERSION = 'search-v1';

export const SEARCH_BOT_V1 = Object.freeze({
  lo: 21,
  hi: 40,
  worlds: 8,
  k: 6,
  net: 2,
  endgameHi: 20,
  endgameWorlds: 8,
  minWorlds: 4,
  tieTolerance: 1e-9,
  solverMaxNodes: 1_500_000,
  worldSeed: '(seed*1009 + ply*7919)>>>0',
});

/** Which search the band of `cards` on the table uses: 'midgame', 'endgame' or null. */
export function searchBand(cards, params = SEARCH_BOT_V1) {
  if (cards >= params.lo && cards <= params.hi) return 'midgame';
  if (cards <= params.endgameHi) return 'endgame';
  return null;
}

/** World seed of a search decision: depends only on the round seed and the public ply. */
export const worldSeed = (seed, ply) => (seed * 1009 + ply * 7919) >>> 0;

/**
 * Browser time and memory budgets. A search that does not finish inside `midgameMs` /
 * `endgameMs` is discarded and the table plays champion 017's move instead. `solverMs` is the
 * per-call exact-solver limit (Node: 3,000 ms) and `solverTable` the transposition-table size at
 * which the table is cleared before a call (Node: 1,000,000); neither changes a solved value.
 */
export const SEARCH_BUDGETS = Object.freeze({
  desktop: Object.freeze({
    midgameMs: 3000,
    endgameMs: 4000,
    solverMs: 3000,
    solverTable: 300_000,
  }),
  mobile: Object.freeze({ midgameMs: 3500, endgameMs: 3500, solverMs: 1000, solverTable: 100_000 }),
});

/**
 * Per-call exact-solver time limit of the tested Node bot (evaluate.mjs SEARCH.solver.maxMs). A
 * world the Node bot cannot solve in this time is skipped there, so a browser call stopped by the
 * clock at this limit follows the tested rule. A browser budget with a SHORTER per-call limit
 * (mobile) would skip worlds Node solves; there a clock stop discards the whole search instead and
 * the table plays champion 017 (a node-limit stop at solverMaxNodes is the tested rule and skips).
 */
export const NODE_SOLVER_MS = 3000;

/** Hard limit for one worker reply: budget, one solver call of overshoot and three seconds. */
export const hardTimeoutMs = (budget) =>
  Math.max(budget.midgameMs, budget.endgameMs) + budget.solverMs + 3000;
