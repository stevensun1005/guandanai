/**
 * Dedicated worker of the belief-search research bot (menu id 9001). It holds its own champion
 * and belief ONNX sessions and one exact solver, so a slow search never blocks the shared AI
 * worker (Top 5, Clint, champion decisions). Messages:
 *   {id, type: 'init', bot, budget}      load both networks and create the solver;
 *   {id, type: 'search', payload, remainingMs}
 *                                        one decision; replies {ok, index, ids, shape, kind, ...}
 *                                        or {fallback: true, reason} (the table then plays 017).
 *                                        `remainingMs` is the time left to the 50 s reasoning mark
 *                                        of the seat's turn (turn-timing.mjs); the search and every
 *                                        exact-solver call stop by then.
 *   {id, type: 'coach', payload}         the human player's move-coach values (search/coach.mjs);
 *                                        replies {ok, kind, plays, base, values, ...} or
 *                                        {fallback: true, reason} (the coach shows 017's values).
 *   {type: 'cancel', id}                 stop coach job `id` at its next check (the table needs
 *                                        the worker). Table searches never yield or cancel, so
 *                                        their decisions are unchanged.
 */
import * as ort from './vendor/ort.wasm.min.mjs';
import { searchBot, botModel } from './model-catalog.mjs';
import { createSolver } from '../../../ai/danMCai/endgame/solver.mjs';
import { restoreGame } from './search/payload.mjs';
import { KnownCardsError } from './search/known-cards.mjs';
import {
  SearchBudgetError,
  remainingCards,
  searchBand,
  searchBotDecision,
} from './search/core.mjs';
import { coachSearchValues } from './search/coach.mjs';
import { beliefProbabilities, championValues } from './search/inference.mjs';
import { NODE_SOLVER_MS, SEARCH_BOT_V1 } from './search/constants.mjs';
import { createRound } from '../../../ai/shared/simulation/simulation.mjs';
import { publicView } from '../../../ai/danMCai/belief/features.mjs';
import { candidates } from './candidates.js';
import { policyState } from './observation.js';

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;

let engine = null;

async function load(id, budget) {
  const bot = searchBot(id);
  if (!bot) throw Error('Unknown search bot');
  const base = botModel(bot.base);
  const open = (file, key) => {
    const url = new URL('../models/' + file, import.meta.url);
    url.searchParams.set('v', __MODEL_VERSIONS__[key]);
    return ort.InferenceSession.create(url.href, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  };
  const [champion, belief] = await Promise.all([
    open(base.file, 'bot:' + base.id),
    open(bot.belief.file, 'belief:' + bot.id),
  ]);
  const values = championValues(ort, champion),
    probabilities = beliefProbabilities(ort, belief, bot.belief.featureVersion);
  // Warm-up on a fixed opening so the first real decision does not pay WASM compilation.
  const opening = createRound(1);
  const plays = candidates(opening.hands[opening.turn], opening.L, null);
  await values(policyState(opening, opening.turn, 0, plays));
  await probabilities(publicView(opening, opening.turn));
  return {
    id,
    budget,
    values,
    probabilities,
    solver: createSolver({
      maxNodes: SEARCH_BOT_V1.solverMaxNodes,
      maxMs: budget.solverMs,
      maxTable: budget.solverTable,
    }),
  };
}

/** A one-call solver limited to the time left to the deadline (search/core.mjs pimcLabelFromWorlds). */
const cappedSolver = (ms) =>
  createSolver({
    maxNodes: SEARCH_BOT_V1.solverMaxNodes,
    maxMs: ms,
    maxTable: engine.budget.solverTable,
  });

/** Deadline of a job: its band budget, and never past the turn's 50 s mark. */
function deadlineOf(started, band, remainingMs) {
  const bandMs = band === 'midgame' ? engine.budget.midgameMs : engine.budget.endgameMs;
  return started + Math.min(bandMs, Number.isFinite(remainingMs) ? remainingMs : Infinity);
}

async function search(payload, remainingMs) {
  const started = performance.now();
  let game;
  try {
    game = restoreGame(payload);
  } catch (error) {
    if (error instanceof KnownCardsError) return { fallback: true, reason: 'known-cards' };
    throw error;
  }
  const band = searchBand(remainingCards(game));
  if (!band) return { fallback: true, reason: 'out-of-band' };
  const counter = { inferences: 0 };
  const ctx = {
    values: engine.values,
    probabilities: engine.probabilities,
    solver: engine.solver,
    solverTimeIsBudget: engine.budget.solverMs < NODE_SOLVER_MS,
    solverMs: engine.budget.solverMs,
    cappedSolver,
    offset: payload.offset,
    now: () => performance.now(),
    deadline: deadlineOf(started, band, remainingMs),
    counter,
  };
  let decision;
  try {
    decision = await searchBotDecision(game, payload.seed, ctx);
  } catch (error) {
    if (error instanceof SearchBudgetError)
      return {
        fallback: true,
        reason: 'budget',
        kind: band,
        ms: performance.now() - started,
        inferences: counter.inferences,
      };
    throw error;
  }
  const play = decision.plays[decision.index];
  return {
    ok: true,
    kind: decision.kind,
    index: decision.index,
    championIndex: decision.championIndex,
    candidates: decision.plays.length,
    ids: play ? play.cards.map((card) => card.id) : [],
    shape: play ? { type: play.type, value: play.value, n: play.n } : null,
    minWorldsFallback: !!decision.minWorldsFallback,
    worldsUsed: decision.used ?? decision.worlds.length,
    inferences: counter.inferences,
    ms: performance.now() - started,
  };
}

/** A task boundary (no timer clamping) so the worker can read a 'cancel' message. */
const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
let wake = null;
if (channel) channel.port1.onmessage = () => wake?.();
const nextTask = () =>
  new Promise((resolve) => {
    if (!channel) return setTimeout(resolve, 0);
    wake = resolve;
    channel.port2.postMessage(0);
  });

/** Coach values for the human player's turn; yields every ~50 ms so a table search can cut in. */
async function coach(payload, job, remainingMs) {
  const started = performance.now();
  let game;
  try {
    game = restoreGame(payload);
  } catch (error) {
    if (error instanceof KnownCardsError) return { fallback: true, reason: 'known-cards' };
    throw error;
  }
  const band = searchBand(remainingCards(game));
  if (!band) return { fallback: true, reason: 'out-of-band' };
  let last = performance.now();
  const pause = async () => {
    if (performance.now() - last < 50) return;
    await nextTask();
    last = performance.now();
  };
  const ctx = {
    values: async (state) => {
      await pause();
      return engine.values(state);
    },
    probabilities: engine.probabilities,
    // Its own solver (fresh table per job, freed afterwards): the table bots' transposition table
    // is never warmed or cleared by coach work, so which near-limit worlds a table search solves
    // does not depend on whether the coach is on. Solved values are exact either way.
    solver: createSolver({
      maxNodes: SEARCH_BOT_V1.solverMaxNodes,
      maxMs: engine.budget.solverMs,
      maxTable: engine.budget.solverTable,
    }),
    solverTimeIsBudget: engine.budget.solverMs < NODE_SOLVER_MS,
    solverMs: engine.budget.solverMs,
    cappedSolver,
    offset: payload.offset,
    pause,
    now: () => {
      if (job.cancelled) throw new SearchBudgetError('cancelled');
      return performance.now();
    },
    deadline: deadlineOf(started, band, remainingMs),
    counter: { inferences: 0 },
  };
  let result;
  try {
    result = await coachSearchValues(game, payload.seed, ctx);
  } catch (error) {
    if (error instanceof SearchBudgetError)
      return {
        fallback: true,
        reason: error.stage === 'cancelled' ? 'cancelled' : 'budget',
        kind: band,
        ms: performance.now() - started,
      };
    throw error;
  }
  if (!result?.values) return { fallback: true, reason: 'min-worlds', kind: band };
  return {
    ok: true,
    kind: result.kind,
    plays: result.plays.map((play) => (play ? play.cards.map((card) => card.id) : [])),
    base: Array.from(result.base),
    values: result.values,
    worlds: result.worlds,
    used: result.used ?? result.worlds,
    evaluated: result.evaluated,
    ms: performance.now() - started,
  };
}

let queue = Promise.resolve(),
  running = null;
self.onmessage = ({ data }) => {
  const { id, type } = data;
  if (type === 'cancel') {
    if (running && running.id === id) running.cancelled = true;
    return;
  }
  queue = queue.then(async () => {
    const job = { id, cancelled: false };
    running = job;
    try {
      if (type === 'init') {
        if (!engine || engine.id !== data.bot) engine = await load(data.bot, data.budget);
        self.postMessage({ id, result: { ready: true } });
        return;
      }
      if ((type !== 'search' && type !== 'coach') || !engine)
        throw Error('Search worker not ready');
      self.postMessage({
        id,
        result:
          type === 'coach'
            ? await coach(data.payload, job, data.remainingMs)
            : await search(data.payload, data.remainingMs),
      });
    } catch (error) {
      if (type === 'init') engine = null;
      self.postMessage({ id, error: String(error?.message || error) });
    } finally {
      running = null;
    }
  });
};
