/**
 * Complete-match evaluation (整场: levels 2..A, tribute/return, A-level rules) of the deployed
 * web reasoning bot danMCai-reason-v000855042 (menu id 9001) against Clint rules-v2.
 *
 * Pairing (ai/guanzero/README.md convention): every seed is played twice, the focal team on
 * seats 0/2 (team 0) and then on seats 1/3 (team 1); 250 seeds = 500 complete matches. The
 * match engine is the GuanZero development-suite harness (ai/shared/simulation): createMatchRound
 * (deal, levels, tribute/return with the baseline choice), advanceRound, advanceMatch
 * (roundOutcome, aFail 'draw') and the same per-round seeds as playMatch ((seed*1009 + r)>>>0).
 * Clint (default --clint=web) is the deployed web Clint seat: decideClintRule(ruleObservation(game,
 * p), WEB_BRAIN) from web/src/rule-bot/runtime.mjs, i.e. strategy.js chooseRuleAction and then the
 * synced 残局大脑 (endgame-brain.mjs, every hand <= 12 cards, 10 s per decision), seeing only its own
 * hand and public data, with the suite's seeded random stream (roundSeed ^ 0x6a09e667).
 * --clint=rules-only is the development-suite opponent createRuleBaseline(..., 'rules-v2') =
 * chooseRuleAction WITHOUT the brain (comparable with the historical GuanZero Clint suites only).
 * One addition to playMatch's loop: the public tribute / anti-tribute records the web table keeps
 * (game.trib [{g, r, tc, rc}], game.kang {has, leader}) are rebuilt from the card movement, so
 * Clint's public inference and the search's publicly known cards see them as on the web.
 *
 * Focal seats mirror web/src/ai/controller.js + search/client.js + search-worker.mjs for a
 * computer seat set to 9001 on the deciding (solo/host, offset 0) device:
 *   - prepareTableDecision with champion 017's config: a finishing move or a single candidate is
 *     played at once;
 *   - 21-40 or <= 20 cards on the table: searchPayload -> restoreGame (masked hands, public known
 *     cards) -> searchBotDecision with the DESKTOP budget (SEARCH_BUDGETS.desktop): midgame
 *     3,000 ms, endgame 4,000 ms, solver calls 3,000 ms, one persistent solver per process with a
 *     300,000-entry table. A budget overrun (SearchBudgetError), a known-cards contradiction, an
 *     error, a reply past hardTimeoutMs (the worker is replaced: the solver table is dropped) or a
 *     reply that does not match the table falls back to champion 017 and is counted by reason;
 *   - otherwise / on fallback: decideTablePolicy (the AI worker's 017 pipeline, balanced profile,
 *     public two-player endgame proof included).
 * Tribute and return: the web's tribute specialist is disabled (tribute-model.json), so every
 * computer seat, 9001 and Clint alike, gives tributeOptions()[0] and returns aiReturnCard(): the
 * harness's baselineTributeChoice is exactly that choice.
 * Only the search seed differs from the web: the page draws crypto random numbers per round; here
 * it is searchSeedOf(round seed), a fixed hash that never reads a card (reproducible worlds).
 *
 * The budgets (focal search and the Clint brain) are wall-clock limits, so fallbacks, brain worlds
 * and hence results depend on machine load and on the number of workers; every match records its
 * searches, fallbacks, Clint brain counters and timings.
 *
 *   node ai/danMCai/belief/reason-match-eval.mjs --out=<dir> --seeds=<a>..<b> [--workers=6]
 *        [--deadline=<ISO time>] [--belief=<belief.onnx>] [--champion=<bot-017.onnx>]
 *        [--ort=wasm|node] [--clint=web|rules-only] [--nice=10]
 *   node ai/danMCai/belief/reason-match-eval.mjs --summarize --out=<dir>
 * Resumable by completed seed pairs (pairs.jsonl); a different protocol in a non-empty --out is
 * refused; creating <out>/STOP or passing --deadline stops dispatch and aborts unfinished pairs.
 */
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, getPriority, setPriority, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { advanceRound, createRound, seededRandom } from '../../shared/simulation/simulation.mjs';
import { advanceMatch, createMatchRound } from '../../shared/simulation/match-simulation.mjs';
import {
  RULE_OPPONENT_VERSION,
  createRuleBaseline,
} from '../../shared/simulation/rule-baseline.mjs';
import { createSolver } from '../endgame/solver.mjs';
import { publicView } from './features.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { decideTablePolicy, prepareTableDecision } from '../../../web/src/ai/table-policy.mjs';
import { analyze, beats } from '../../../web/src/core/combinations.js';
import { WEB_BRAIN, decideClintRule, ruleObservation } from '../../../web/src/rule-bot/runtime.mjs';
import { BRAIN, BRAIN_STAT } from '../../../web/src/rule-bot/endgame-brain.mjs';
import { botModel, botModelName, searchBot } from '../../../web/src/ai/model-catalog.mjs';
import {
  NODE_SOLVER_MS,
  SEARCH_BOT_V1,
  SEARCH_BUDGETS,
  SEARCH_CORE_VERSION,
  hardTimeoutMs,
  searchBand,
} from '../../../web/src/ai/search/constants.mjs';
import {
  SearchBudgetError,
  remainingCards,
  searchBotDecision,
} from '../../../web/src/ai/search/core.mjs';
import { restoreGame, searchPayload } from '../../../web/src/ai/search/payload.mjs';
import { KnownCardsError } from '../../../web/src/ai/search/known-cards.mjs';
import { beliefProbabilities, championValues } from '../../../web/src/ai/search/inference.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SELF), '../../..');
export const PROTOCOL = 'reason-vs-clint-match-v1';
export const BOT_ID = '9001';
const FOCAL = searchBot(BOT_ID);
const BASE = botModel(BOT_ID);
export const FOCAL_NAME = botModelName(BOT_ID);
export const DEFAULT_BELIEF =
  '/Users/stevensun/guandan-runtime.noindex/window1-20261109/H/model/belief.onnx';
export const DEFAULT_CHAMPION =
  '/Users/stevensun/guandan-runtime.noindex/endgame-oracle-20261108-r2/models/champion.onnx';
const MAX_ROUNDS = 200;
/**
 * Clint opponents: 'web' is the deployed Clint seat (web/src/ai/worker.mjs 'rule' request:
 * decideClintRule(ruleObservation(game, p)) = rules, then the 残局大脑 with WEB_BRAIN); 'rules-only'
 * is the GuanZero development-suite opponent createRuleBaseline(..., rules-v2) = chooseRuleAction
 * without the brain (comparable with the historical GuanZero Clint suites, not the latest Clint).
 */
export const CLINT_PATHS = ['web', 'rules-only'];
const A_FAIL = 'draw';
/** Files whose logic this tool mirrors without importing (browser-only modules). */
const MIRRORED = [
  'web/src/ai/controller.js',
  'web/src/ai/search/client.js',
  'web/src/ai/search-worker.mjs',
  'web/src/ai/worker.mjs',
  'web/src/ai/tribute-specialist.mjs',
  'web/src/ai/tribute-model.json',
  'web/src/game/tribute.js',
];

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sha256Text = (text) => createHash('sha256').update(text).digest('hex');

/** Search seed of one round: a fixed hash of the round seed (the web uses crypto random). */
export const searchSeedOf = (roundSeed) =>
  Math.imul((roundSeed ^ 0x2c1b3c6d) >>> 0, 0x297a2d39) >>> 0;

/**
 * Public exchange records of a round, rebuilt from where each card was dealt (`dealt`, the hands
 * of createRound(roundSeed)) and where it is after createMatchRound's tribute (`game`):
 * {trib: [{g, r, tc, rc}]} (the leader's tribute first, card objects as on the web table),
 * {trib: [], kang: {has: [{g, n}], leader}} for an anti-tribute, {} for the first round.
 */
export function exchangeRecords(dealt, game, order) {
  if (!order) return {};
  const dbl = order[0] % 2 === order[1] % 2;
  const givers = dbl ? [order[2], order[3]] : [order[3]];
  const owner = new Map();
  dealt.forEach((hand, seat) => hand.forEach((card) => owner.set(card.id, seat)));
  const moves = [];
  game.hands.forEach((hand, seat) =>
    hand.forEach((card) => {
      if (owner.get(card.id) !== seat) moves.push({ from: owner.get(card.id), to: seat, card });
    }),
  );
  if (!moves.length) {
    const has = givers
      .map((g) => ({ g, n: game.hands[g].filter((c) => c.r === 17).length }))
      .filter((x) => x.n);
    if (has.reduce((sum, x) => sum + x.n, 0) < 2 || game.turn !== order[0])
      throw Error('Tribute round without card movement');
    return { trib: [], kang: { has, leader: order[0] } };
  }
  if (moves.length !== 2 * givers.length || !givers.includes(game.turn))
    throw Error('Unexpected tribute movement');
  const trib = [game.turn, ...givers.filter((g) => g !== game.turn)].map((g) => {
    const out = moves.filter((m) => m.from === g),
      back = moves.filter((m) => m.to === g);
    if (out.length !== 1 || back.length !== 1 || out[0].to !== back[0].from)
      throw Error('Unexpected tribute movement');
    return { g, r: out[0].to, tc: out[0].card, rc: back[0].card };
  });
  return { trib };
}

/**
 * The deployed web Clint seat in Node: the AI worker's decideClintRule on the controller's
 * ruleObservation (own hand, public counts / log / trick / passes / finished order / tribute
 * records), then the controller's checks mapping card ids back to this table. Math.random is the
 * same seeded stream the development suite gives Clint (roundSeed ^ 0x6a09e667); the brain's
 * world count still depends on wall-clock time (WEB_BRAIN.ms), so it is load-dependent.
 * `game.tok` must be unique per round: runtime.mjs keeps one view per seat keyed by tok:round.
 */
export function createWebClint(randomSeed, settings = WEB_BRAIN) {
  const random = seededRandom(randomSeed);
  return (game, p) => {
    if (game.tok === undefined) throw Error('Clint web view needs a per-round game.tok');
    const previous = Math.random;
    Math.random = random;
    let result;
    try {
      result = decideClintRule(ruleObservation(game, p), settings);
    } finally {
      Math.random = previous;
    }
    if (!result) {
      if (!game.trick) throw Error('invalid-rule-pass');
      return null;
    }
    const cards = result.cards.map((id) => game.hands[p].find((card) => card.id === id));
    if (
      cards.some((c) => !c) ||
      new Set(cards).size !== cards.length ||
      !analyze(cards, game.L).some(
        (shape) =>
          shape.type === result.type && shape.value === result.value && shape.n === result.n,
      ) ||
      !beats(result, game.trick?.play)
    )
      throw Error('invalid-rule-action');
    return { ...result, cards };
  };
}

const brainSnapshot = () => ({ ...BRAIN_STAT });
const brainDelta = (before) =>
  Object.fromEntries(
    Object.keys(BRAIN_STAT).map((k) => [
      k,
      k === 'ms' ? Math.round(BRAIN_STAT[k] - before[k]) : BRAIN_STAT[k] - before[k],
    ]),
  );

/**
 * One complete match, playMatch's loop (mode 'rule', table policy) with the focal team's
 * decisions from `focal(game, p, {roundSeed, searchSeed})` (a play or null). `exchanges: false`
 * leaves game.trib / game.kang unset, exactly as playMatch (with clint 'rules-only': the
 * equivalence test). `clintSettings` overrides WEB_BRAIN for tests only (the CLI never sets it).
 */
export async function playReasonMatch({
  seed,
  focalTeam,
  focal,
  ruleVersion = RULE_OPPONENT_VERSION,
  clint = 'web',
  clintSettings = WEB_BRAIN,
  exchanges = true,
  checkpoint = null,
}) {
  if (![0, 1].includes(focalTeam)) throw Error('Invalid focal team');
  if (!CLINT_PATHS.includes(clint)) throw Error('Unknown Clint path');
  if (clint === 'web' && ruleVersion !== RULE_OPPONENT_VERSION)
    throw Error('The web Clint seat is rules-v2');
  const brainBefore = brainSnapshot();
  let match = { levels: [2, 2], lvlTeam: 0, aFails: [0, 0], round: 1, previousOrder: null };
  const history = [],
    publicHistory = [];
  const time = { focalMs: 0, opponentMs: 0, focalDecisions: 0, opponentDecisions: 0 };
  const started = performance.now();
  for (let r = 0; r < MAX_ROUNDS; r++) {
    if (checkpoint) await checkpoint();
    const roundSeed = (Math.imul(seed, 1009) + r) >>> 0;
    const game = createMatchRound(roundSeed, match),
      rule =
        clint === 'web'
          ? createWebClint(roundSeed ^ 0x6a09e667, clintSettings)
          : createRuleBaseline(roundSeed ^ 0x6a09e667, { version: ruleVersion });
    game.roundHistory = publicHistory;
    game.tok = `reason-eval:${seed}:${focalTeam}:${r}`;
    Object.assign(game, {
      aFails: match.aFails,
      lvlTeam: match.lvlTeam,
      round: match.round,
      prevOut: match.previousOrder,
    });
    const exchange = exchanges
      ? exchangeRecords(createRound(roundSeed).hands, game, match.previousOrder)
      : {};
    Object.assign(game, exchange);
    const info = { roundSeed, searchSeed: searchSeedOf(roundSeed) };
    let result = null;
    for (let turn = 0; turn < 1000; turn++) {
      const p = game.turn,
        t0 = performance.now();
      let play;
      if (p % 2 !== focalTeam) {
        play = rule(game, p);
        time.opponentMs += performance.now() - t0;
        time.opponentDecisions++;
      } else {
        play = await focal(game, p, info);
        time.focalMs += performance.now() - t0;
        time.focalDecisions++;
      }
      result = advanceRound(game, play);
      if (result) break;
    }
    if (!result) throw Error('Round failed to terminate');
    const next = advanceMatch(match, game, result, A_FAIL);
    publicHistory.push({ log: game.log });
    history.push({
      round: match.round,
      level: game.L,
      ...next.result,
      exchange: !match.previousOrder ? 'none' : exchange.kang ? 'resisted' : 'paid',
    });
    match = next;
    if (next.result.win || next.result.draw) {
      const winner = next.result.draw ? null : next.result.team;
      return {
        seed,
        focalTeam,
        neuralTeam: focalTeam,
        winner,
        focalResult: winner === null ? 'draw' : winner === focalTeam ? 'win' : 'loss',
        finalLevels: next.levels.slice(),
        focalFinalLevel: next.levels[focalTeam],
        opponentFinalLevel: next.levels[1 - focalTeam],
        aFails: next.aFails.slice(),
        focalAFails: next.aFails[focalTeam],
        opponentAFails: next.aFails[1 - focalTeam],
        rounds: history.length,
        history,
        clint,
        clintBrain: clint === 'web' ? brainDelta(brainBefore) : null,
        time: {
          wallMs: Math.round(performance.now() - started),
          focalMs: Math.round(time.focalMs),
          opponentMs: Math.round(time.opponentMs),
          focalDecisions: time.focalDecisions,
          opponentDecisions: time.opponentDecisions,
        },
      };
    }
  }
  throw Error('Match truncated');
}

/** Per-match counters of the focal bot. */
export function emptyTally() {
  const band = () => ({
    requests: 0,
    completed: 0,
    deviated: 0,
    minWorlds: 0,
    fallbacks: {},
    ms: [],
  });
  return { decisions: 0, automatic: 0, champion: 0, midgame: band(), endgame: band() };
}

const quantile = (values, q) => {
  const s = values.slice().sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const msSummary = (ms) => ({
  n: ms.length,
  totalMs: Math.round(ms.reduce((a, b) => a + b, 0)),
  p50: ms.length ? Math.round(quantile(ms, 0.5)) : null,
  p95: ms.length ? Math.round(quantile(ms, 0.95)) : null,
  max: ms.length ? Math.round(Math.max(...ms)) : null,
});

/** Tally with the ms lists replaced by summaries (what a match record stores). */
export function closeTally(tally) {
  const band = ({ ms, ...rest }) => ({
    ...rest,
    fallbackCount: Object.values(rest.fallbacks).reduce((a, b) => a + b, 0),
    searchMs: msSummary(ms),
  });
  return { ...tally, midgame: band(tally.midgame), endgame: band(tally.endgame) };
}

/**
 * The focal 9001 seat. `values` / `probabilities` / `tableDecide` may be injected (tests);
 * otherwise they come from the ONNX sessions as in search/inference.mjs and the AI worker.
 */
export function createReasonBot({
  ort,
  championSession,
  beliefSession,
  config = BASE.config,
  budget = SEARCH_BUDGETS.desktop,
  values = null,
  probabilities = null,
  tableDecide = null,
  now = () => performance.now(),
}) {
  const newSolver = () =>
    createSolver({
      maxNodes: SEARCH_BOT_V1.solverMaxNodes,
      maxMs: budget.solverMs,
      maxTable: budget.solverTable,
    });
  const engine = {
    values: values || championValues(ort, championSession),
    probabilities:
      probabilities || beliefProbabilities(ort, beliefSession, FOCAL.belief.featureVersion),
    solver: newSolver(),
  };
  const decideChampion =
    tableDecide || ((state) => decideTablePolicy(ort, async () => championSession, state, config));
  const hardLimit = hardTimeoutMs(budget);

  /** search-worker.mjs search(), then the client's hard timeout. */
  async function search(payload) {
    const started = now();
    let game;
    try {
      game = restoreGame(payload);
    } catch (error) {
      if (error instanceof KnownCardsError) return { fallback: true, reason: 'known-cards' };
      return { fallback: true, reason: 'error', message: String(error?.message || error) };
    }
    const band = searchBand(remainingCards(game));
    if (!band) return { fallback: true, reason: 'out-of-band' };
    const ctx = {
      values: engine.values,
      probabilities: engine.probabilities,
      solver: engine.solver,
      solverTimeIsBudget: budget.solverMs < NODE_SOLVER_MS,
      offset: payload.offset,
      now,
      deadline: started + (band === 'midgame' ? budget.midgameMs : budget.endgameMs),
      counter: { inferences: 0 },
    };
    let decision;
    try {
      decision = await searchBotDecision(game, payload.seed, ctx);
    } catch (error) {
      const ms = now() - started;
      if (ms > hardLimit) {
        engine.solver = newSolver();
        return { fallback: true, reason: 'timeout', ms };
      }
      if (error instanceof SearchBudgetError) return { fallback: true, reason: 'budget', ms };
      return { fallback: true, reason: 'error', message: String(error?.message || error), ms };
    }
    const ms = now() - started;
    if (ms > hardLimit) {
      engine.solver = newSolver();
      return { fallback: true, reason: 'timeout', ms };
    }
    const play = decision.plays[decision.index];
    return {
      ok: true,
      kind: decision.kind,
      index: decision.index,
      championIndex: decision.championIndex,
      ids: play ? play.cards.map((card) => card.id) : [],
      shape: play ? { type: play.type, value: play.value, n: play.n } : null,
      minWorldsFallback: !!decision.minWorldsFallback,
      ms,
    };
  }

  /** controller.js searchedPlay: the reply must name a legal play of this table exactly. */
  function searchedPlay(game, result, plays, p) {
    if (!result?.ok || !Number.isInteger(result.index) || result.index >= plays.length)
      return undefined;
    const play = plays[result.index];
    const ids = (list) =>
      list
        .slice()
        .sort((a, b) => a - b)
        .join(',');
    if (!play) return game.trick && !result.ids.length && !result.shape ? null : undefined;
    if (
      ids(play.cards.map((card) => card.id)) !== ids(result.ids) ||
      play.type !== result.shape?.type ||
      play.value !== result.shape.value ||
      play.n !== result.shape.n ||
      !play.cards.every((card) => game.hands[p].includes(card)) ||
      !beats(play, game.trick?.play)
    )
      return undefined;
    return play;
  }

  async function decide(game, p, { searchSeed }, tally) {
    tally.decisions++;
    const prepared = prepareTableDecision(game, p, 0, config);
    const { plays } = prepared;
    if (prepared.index != null) {
      tally.automatic++;
      return plays[prepared.index];
    }
    const band = searchBand(remainingCards(game));
    if (band) {
      const counts = tally[band];
      counts.requests++;
      let result;
      try {
        result = await search(searchPayload(game, p, 0, searchSeed));
      } catch (error) {
        result = { fallback: true, reason: 'payload', message: String(error?.message || error) };
      }
      if (Number.isFinite(result.ms)) counts.ms.push(result.ms);
      const play = searchedPlay(game, result, plays, p);
      if (play !== undefined) {
        counts.completed++;
        if (result.index !== result.championIndex) counts.deviated++;
        if (result.minWorldsFallback) counts.minWorlds++;
        return play;
      }
      const reason = result?.ok ? 'mismatch' : result?.reason || 'error';
      counts.fallbacks[reason] = (counts.fallbacks[reason] || 0) + 1;
      if (result?.message) (counts.errors ||= []).push(result.message.slice(0, 200));
    }
    tally.champion++;
    prepared.state.modelId = BASE.id;
    const chosen = await decideChampion(prepared.state);
    if (!Number.isInteger(chosen.index) || chosen.index < 0 || chosen.index >= plays.length)
      throw Error('invalid-action');
    return plays[chosen.index];
  }
  return { decide, engine };
}

/** One seed pair: focal team 0, then focal team 1. */
export async function playPair(seed, bot, options = {}) {
  const matches = [];
  for (const focalTeam of [0, 1]) {
    const tally = emptyTally();
    const match = await playReasonMatch({
      seed,
      focalTeam,
      focal: (game, p, info) => bot.decide(game, p, info, tally),
      ...options,
    });
    matches.push({ ...match, focal: closeTally(tally) });
  }
  return matches;
}

/* ----------------------------- summary ----------------------------- */

/** Percentile bootstrap over seed-pair clusters (GuanZero evaluate.mjs: 2000 draws, same seed). */
export function clusterBootstrap(clusters, stat, iterations = 2000) {
  if (clusters.length < 2) return null;
  const random = seededRandom(3700000000),
    draws = [];
  for (let i = 0; i < iterations; i++)
    draws.push(
      stat(
        Array.from(
          { length: clusters.length },
          () => clusters[Math.floor(random() * clusters.length)],
        ),
      ),
    );
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * iterations)], draws[Math.floor(0.975 * iterations)]];
}

const levelDiff = (clusters) => {
  const all = clusters.flat();
  return all.reduce((s, m) => s + m.focalFinalLevel - m.opponentFinalLevel, 0) / all.length;
};
const netScore = (clusters) => {
  const all = clusters.flat();
  return (
    all.reduce((s, m) => s + (m.winner === null ? 0 : m.winner === m.focalTeam ? 1 : -1), 0) /
    all.length
  );
};

function addCounts(target, source) {
  for (const [k, v] of Object.entries(source)) target[k] = (target[k] || 0) + v;
  return target;
}

/** Summary of completed pairs (`rows` = [{index, seed, matches: [m0, m1]}]). */
export async function summarize(rows) {
  const { metrics, intervals } = await import('../../guanzero/training/evaluate.mjs');
  const clusters = rows
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((row) => row.matches);
  if (!clusters.length) return { pairs: 0, matches: 0 };
  const all = clusters.flat();
  const side = (team) => {
    const list = all.filter((m) => m.focalTeam === team);
    return {
      ...metrics([list]),
      meanFinalLevelDifference: levelDiff([list]),
    };
  };
  const search = { midgame: {}, endgame: {} };
  for (const band of ['midgame', 'endgame']) {
    const b = search[band];
    const parts = all.map((m) => m.focal[band]);
    for (const key of ['requests', 'completed', 'deviated', 'minWorlds', 'fallbackCount'])
      b[key] = parts.reduce((s, x) => s + x[key], 0);
    b.fallbacks = parts.reduce((acc, x) => addCounts(acc, x.fallbacks), {});
    b.fallbackRate = b.requests ? b.fallbackCount / b.requests : null;
    b.totalSearchMs = parts.reduce((s, x) => s + x.searchMs.totalMs, 0);
    b.timedSearches = parts.reduce((s, x) => s + x.searchMs.n, 0);
    b.meanSearchMs = b.timedSearches ? b.totalSearchMs / b.timedSearches : null;
    b.maxSearchMs = Math.max(0, ...parts.map((x) => x.searchMs.max ?? 0));
    b.errors = [...new Set(parts.flatMap((x) => x.errors || []))].slice(0, 20);
  }
  const brains = all.map((m) => m.clintBrain).filter(Boolean);
  const clintBrain = brains.length
    ? {
        ...brains.reduce((acc, x) => addCounts(acc, x), {}),
        matches: brains.length,
        note: 'BRAIN_STAT deltas: calls (searches started), used, fallback (fewer than minWorlds deals solved in time: rules play kept), changed (rules play replaced), ms',
      }
    : null;
  const wall = all.map((m) => m.time.wallMs);
  const pairOutcomes = { '2-0': 0, '1.5-0.5': 0, '1-1': 0, '0.5-1.5': 0, '0-2': 0 };
  for (const pair of clusters) {
    const score = pair.reduce(
      (s, m) => s + (m.winner === null ? 0.5 : m.winner === m.focalTeam ? 1 : 0),
      0,
    );
    const away = 2 - score;
    const key = `${score}-${away}`;
    if (key in pairOutcomes) pairOutcomes[key]++;
    else pairOutcomes[key] = 1;
  }
  return {
    pairs: clusters.length,
    ...metrics(clusters),
    confidence95: {
      ...intervals(clusters),
      netMatchScore: clusterBootstrap(clusters, netScore),
      meanFinalLevelDifference: clusterBootstrap(clusters, levelDiff),
    },
    netMatchScore: netScore(clusters),
    meanFinalLevelDifference: levelDiff(clusters),
    intervalMethod:
      '95% seed-pair cluster percentile bootstrap, 2000 draws (GuanZero evaluate.mjs)',
    pairOutcomes,
    perSide: { focalTeam0: side(0), focalTeam1: side(1) },
    aFailures: {
      focal: all.reduce((s, m) => s + m.focalAFails, 0),
      opponent: all.reduce((s, m) => s + m.opponentAFails, 0),
      matchesEndedByADraw: all.filter((m) => m.winner === null).length,
    },
    rounds: {
      mean: all.reduce((s, m) => s + m.rounds, 0) / all.length,
      max: Math.max(...all.map((m) => m.rounds)),
    },
    focalDecisions: {
      total: all.reduce((s, m) => s + m.focal.decisions, 0),
      automatic: all.reduce((s, m) => s + m.focal.automatic, 0),
      champion017: all.reduce((s, m) => s + m.focal.champion, 0),
    },
    search,
    clintBrain,
    clintOpponentMs: {
      total: all.reduce((s, m) => s + (m.time.opponentMs || 0), 0),
      decisions: all.reduce((s, m) => s + (m.time.opponentDecisions || 0), 0),
    },
    matchWallMs: {
      mean: Math.round(wall.reduce((a, b) => a + b, 0) / wall.length),
      p50: quantile(wall, 0.5),
      p95: quantile(wall, 0.95),
      max: Math.max(...wall),
    },
  };
}

/* ----------------------------- protocol & files ----------------------------- */

/** Repo-relative SHA-256 of `entry` and every relative module it imports statically. */
export function sourceClosure(entries) {
  const seen = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    const text = readFileSync(file, 'utf8');
    seen.set(file, sha256Text(text));
    const patterns = [
      /(?:^|\n)\s*(?:import|export)\s[^;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
      /(?:^|\n)\s*import\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    ];
    for (const pattern of patterns)
      for (const match of text.matchAll(pattern)) visit(resolve(dirname(file), match[1]));
  };
  for (const entry of entries) visit(resolve(REPO, entry));
  return Object.fromEntries(
    [...seen]
      .map(([file, hash]) => [relative(REPO, file).replaceAll('\\', '/'), hash])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

function packageVersion(name) {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve(name));
    while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

/** Clint rules-v2: every rule-bot file plus the import closure of the opponent entry point. */
export function clintFingerprint(path = 'web') {
  const files = readdirSync(join(REPO, 'web/src/rule-bot'))
    .filter((name) => /\.(mjs|js)$/.test(name))
    .sort()
    .map((name) => 'web/src/rule-bot/' + name);
  const closure = sourceClosure(
    path === 'web' ? ['web/src/rule-bot/runtime.mjs'] : ['ai/shared/simulation/rule-baseline.mjs'],
  );
  const ruleBot = Object.fromEntries(files.map((f) => [f, sha256File(join(REPO, f))]));
  return {
    name: 'Clint规则机器人',
    version: RULE_OPPONENT_VERSION,
    path,
    entry:
      path === 'web'
        ? 'decideClintRule(ruleObservation(game, p), WEB_BRAIN) -> chooseClintAction (rules, then 残局大脑); Math.random = seededRandom(roundSeed ^ 0x6a09e667)'
        : 'createRuleBaseline(roundSeed ^ 0x6a09e667, {version: rules-v2}) -> chooseRuleAction (no 残局大脑)',
    endgameBrain: path === 'web' ? { ...BRAIN, ...WEB_BRAIN } : null,
    ruleBotSHA256: ruleBot,
    ruleBotCombinedSHA256: sha256Text(JSON.stringify(ruleBot)),
    closureSHA256: closure,
  };
}

function clintSyncState() {
  try {
    const s = JSON.parse(
      readFileSync(join(REPO, 'ai/research/evaluation/clint-sync-state.json'), 'utf8'),
    );
    return {
      lastSuccessfulUpstreamSHA: s.lastSuccessfulUpstreamSHA ?? null,
      lastCheckedUpstreamSHA: s.lastCheckedUpstreamSHA ?? null,
      evidence: s.evidence ?? null,
    };
  } catch {
    return null;
  }
}

function gitState() {
  try {
    const head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const status = execFileSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' });
    return { head, dirtyOrUntracked: status.split('\n').filter(Boolean) };
  } catch {
    return null;
  }
}

/** Seeds of a run: "a..b" (inclusive) or a JSON array file. */
export function parseSeeds({ seeds, seedsFile }) {
  let list;
  if (seedsFile) list = JSON.parse(readFileSync(resolve(seedsFile), 'utf8'));
  else {
    const m = /^(\d+)\.\.(\d+)$/.exec(String(seeds || ''));
    if (!m) throw Error('Give --seeds=<a>..<b> or --seeds-file=<json array>');
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (b < a || b - a > 100_000) throw Error('Invalid seed range');
    list = Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  if (
    !Array.isArray(list) ||
    !list.length ||
    list.some((s) => !Number.isInteger(s) || s < 0 || s >= 2 ** 32) ||
    new Set(list).size !== list.length
  )
    throw Error('Seeds must be distinct integers in [0, 2^32)');
  return list;
}

export function buildProtocol({
  seeds,
  championFile,
  beliefFile,
  ortKind,
  budgetName = 'desktop',
  clint = 'web',
}) {
  const championSHA = sha256File(championFile),
    beliefSHA = sha256File(beliefFile);
  if (championSHA !== BASE.sha256) throw Error(`Champion is not ${BASE.id} (${BASE.sha256})`);
  if (beliefSHA !== FOCAL.belief.sha256) throw Error(`Belief is not ${FOCAL.belief.sha256}`);
  if (!SEARCH_BUDGETS[budgetName]) throw Error('Unknown budget');
  if (!['wasm', 'node'].includes(ortKind)) throw Error('--ort must be wasm or node');
  if (!CLINT_PATHS.includes(clint)) throw Error('--clint must be web or rules-only');
  const seedsText = JSON.stringify(seeds);
  const sources = sourceClosure([relative(REPO, SELF)]);
  const mirrored = Object.fromEntries(MIRRORED.map((f) => [f, sha256File(join(REPO, f))]));
  return {
    protocol: PROTOCOL,
    purpose:
      'complete-match evaluation of the deployed web reasoning bot vs Clint rules-v2; development, not acceptance',
    focal: {
      name: FOCAL_NAME,
      menuId: BOT_ID,
      identitySHA256: FOCAL.sha256,
      version: FOCAL.version,
      base: { id: BASE.id, version: BASE.source.version, sha256: championSHA },
      belief: { sha256: beliefSHA, featureVersion: FOCAL.belief.featureVersion },
      search: { ...SEARCH_BOT_V1 },
      searchCore: SEARCH_CORE_VERSION,
      budget: {
        name: budgetName,
        ...SEARCH_BUDGETS[budgetName],
        hardTimeoutMs: hardTimeoutMs(SEARCH_BUDGETS[budgetName]),
      },
      solver: 'one persistent createSolver per worker process (as the page search worker)',
      warmUp:
        'champion and belief inference on createRound(1) before the first pair (search-worker.mjs load)',
      fallback: 'champion 017 via decideTablePolicy (balanced, public endgame proof), counted',
      searchSeed: 'searchSeedOf(roundSeed) = imul((roundSeed ^ 0x2c1b3c6d)>>>0, 0x297a2d39)>>>0',
      tribute: 'tributeOptions()[0] / aiReturnCard (web tribute specialist disabled)',
      onnxRuntime:
        ortKind === 'wasm' ? 'onnxruntime-web wasm, 1 thread' : 'onnxruntime-node, 1 thread',
      onnxRuntimeVersion: packageVersion(
        ortKind === 'wasm' ? 'onnxruntime-web' : 'onnxruntime-node',
      ),
    },
    opponent: clintFingerprint(clint),
    rules: {
      matches: '整场 from level 2 through A',
      tribute: true,
      aFail: A_FAIL,
      roundCap: MAX_ROUNDS,
      roundSeed: '(Math.imul(seed, 1009) + r) >>> 0 (playMatch)',
    },
    pairing: 'each seed twice: focal team 0 (seats 0/2), then focal team 1 (seats 1/3)',
    seeds: {
      file: 'seeds.json',
      sha256: sha256Text(seedsText),
      count: seeds.length,
      first: seeds[0],
      last: seeds.at(-1),
    },
    sourcesSHA256: sources,
    mirroredSourcesSHA256: mirrored,
  };
}

const protocolSHA = (protocol) => sha256Text(JSON.stringify(protocol));

/** Create or reopen an output directory; refuses another protocol or unknown contents. */
export function openOutput(out, protocol, seeds) {
  const digest = protocolSHA(protocol);
  mkdirSync(out, { recursive: true });
  const file = join(out, 'protocol.json');
  if (existsSync(file)) {
    const previous = JSON.parse(readFileSync(file, 'utf8'));
    if (previous.protocolSHA256 !== digest)
      throw Error('Output holds a different protocol; preserving evidence (use a new --out)');
  } else {
    if (readdirSync(out).length) throw Error('Output directory is not empty and has no protocol');
    writeFileSync(join(out, 'seeds.json'), JSON.stringify(seeds) + '\n');
    writeFileSync(file, JSON.stringify({ protocolSHA256: digest, ...protocol }, null, 2) + '\n');
  }
  const seedsFile = join(out, 'seeds.json');
  if (sha256Text(readFileSync(seedsFile, 'utf8').trim()) !== protocol.seeds.sha256)
    throw Error('seeds.json does not match the protocol');
  return digest;
}

/** Completed pairs of an output directory (drops a torn last line). */
export function readPairs(out, digest, seeds) {
  const file = join(out, 'pairs.jsonl');
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const rows = [];
  for (const [i, line] of lines.entries()) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      if (i === lines.length - 1 && !text.endsWith('\n')) {
        writeFileSync(
          file,
          lines
            .slice(0, -1)
            .map((l) => l + '\n')
            .join(''),
        );
        break;
      }
      throw error;
    }
    if (
      row.protocolSHA256 !== digest ||
      seeds[row.index] !== row.seed ||
      row.matches?.length !== 2 ||
      row.matches.some((m, t) => m.seed !== row.seed || m.focalTeam !== t) ||
      rows.some((r) => r.index === row.index)
    )
      throw Error(`Invalid pair record at line ${i + 1}; preserving evidence`);
    rows.push(row);
  }
  return rows;
}

/* ----------------------------- processes ----------------------------- */

function parseArgs(argv) {
  return Object.fromEntries(
    argv
      .filter((a) => a.startsWith('--'))
      .map((a) => {
        const eq = a.indexOf('=');
        return eq < 0 ? [a.slice(2), true] : [a.slice(2, eq), a.slice(eq + 1)];
      }),
  );
}

async function loadRuntime(kind) {
  if (kind === 'node') return import('onnxruntime-node');
  const dist = join(REPO, 'node_modules/onnxruntime-web/dist/');
  const ort = await import(pathToFileURL(join(dist, 'ort.wasm.min.mjs')).href);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = dist;
  return ort;
}

async function openSession(ort, kind, file) {
  return kind === 'node'
    ? ort.InferenceSession.create(file, {
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all',
      })
    : ort.InferenceSession.create(readFileSync(file), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
}

async function worker() {
  let bot = null,
    clint = 'web';
  process.on('message', async (msg) => {
    try {
      if (msg.type === 'init') {
        const ort = await loadRuntime(msg.ort);
        bot = createReasonBot({
          ort,
          championSession: await openSession(ort, msg.ort, msg.champion),
          beliefSession: await openSession(ort, msg.ort, msg.belief),
          budget: SEARCH_BUDGETS[msg.budget],
        });
        clint = msg.clint;
        // search-worker.mjs load(): warm both sessions on a fixed opening so the first real
        // search does not pay WASM compilation inside its budget.
        const opening = createRound(1);
        const plays = candidates(opening.hands[opening.turn], opening.L, null);
        await bot.engine.values(policyState(opening, opening.turn, 0, plays));
        await bot.engine.probabilities(publicView(opening, opening.turn));
        process.send({ type: 'ready' });
        return;
      }
      if (msg.type === 'pair') {
        const t0 = performance.now();
        const matches = await playPair(msg.seed, bot, { clint });
        process.send({
          type: 'pair',
          index: msg.index,
          seed: msg.seed,
          matches,
          pairMs: Math.round(performance.now() - t0),
          rssMB: Math.round(process.memoryUsage().rss / 2 ** 20),
        });
      }
    } catch (error) {
      process.send({ type: 'error', index: msg.index, message: String(error?.stack || error) });
    }
  });
}

async function main(args) {
  const out = resolve(args.out || '');
  if (!args.out) throw Error('--out is required');
  if (args.summarize) {
    const protocol = JSON.parse(readFileSync(join(out, 'protocol.json'), 'utf8'));
    const seeds = JSON.parse(readFileSync(join(out, 'seeds.json'), 'utf8'));
    const rows = readPairs(out, protocol.protocolSHA256, seeds);
    const summary = await summarize(rows);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const nice = Number(args.nice ?? 10);
  try {
    if (getPriority() < nice) setPriority(nice);
  } catch {
    /* niceness is best effort */
  }
  const seeds = parseSeeds({ seeds: args.seeds, seedsFile: args['seeds-file'] });
  const ortKind = args.ort || 'wasm',
    budgetName = args.budget || 'desktop',
    clint = args.clint || 'web';
  const championFile = resolve(
    args.champion ||
      (existsSync(join(REPO, 'web/dist/models/bot-017.onnx'))
        ? join(REPO, 'web/dist/models/bot-017.onnx')
        : DEFAULT_CHAMPION),
  );
  const beliefFile = resolve(args.belief || DEFAULT_BELIEF);
  const protocol = buildProtocol({ seeds, championFile, beliefFile, ortKind, budgetName, clint });
  const digest = openOutput(out, protocol, seeds);
  const rows = readPairs(out, digest, seeds);
  const done = new Set(rows.map((r) => r.index));
  const todo = seeds.map((_, i) => i).filter((i) => !done.has(i));
  const workers = Math.max(1, Math.min(Number(args.workers || 1), todo.length || 1));
  const deadline = args.deadline ? Date.parse(args.deadline) : Infinity;
  if (args.deadline && !Number.isFinite(deadline)) throw Error('Invalid --deadline');
  const run = {
    startedAt: new Date().toISOString(),
    workers,
    nice,
    deadline: args.deadline || null,
    machine: {
      cpus: cpus().length,
      totalMemGB: Math.round(totalmem() / 2 ** 30),
      node: process.version,
      platform: process.platform,
    },
    git: gitState(),
    clintSyncState: clintSyncState(),
    resumedPairs: rows.length,
  };
  writeFileSync(join(out, `run-${Date.now()}.json`), JSON.stringify(run, null, 2) + '\n');
  let status = 'running',
    failure = null;
  const stopNow = () => existsSync(join(out, 'STOP')) || Date.now() >= deadline;
  const progress = (extra = {}) =>
    writeFileSync(
      join(out, 'progress.json'),
      JSON.stringify(
        {
          protocolSHA256: digest,
          status,
          completedPairs: rows.length,
          totalPairs: seeds.length,
          updatedAt: new Date().toISOString(),
          ...extra,
        },
        null,
        2,
      ) + '\n',
    );
  progress();
  const children = [];
  const queue = todo.slice();
  const pairTimes = [];
  let peakRssMB = 0;
  await new Promise((finish) => {
    let live = 0;
    const stopAll = (why) => {
      if (status !== 'running') return;
      status = why;
      for (const child of children) {
        child.stopping = true;
        child.kill('SIGTERM');
      }
    };
    const timer = setInterval(() => {
      if (stopNow()) stopAll(existsSync(join(out, 'STOP')) ? 'stopped' : 'deadline');
    }, 2000);
    const next = (child) => {
      if (status !== 'running' || stopNow() || !queue.length) {
        child.stopping = true;
        child.kill('SIGTERM');
        return;
      }
      const index = queue.shift();
      child.current = index;
      child.send({ type: 'pair', index, seed: seeds[index] });
    };
    for (let w = 0; w < workers; w++) {
      const child = fork(SELF, ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      try {
        setPriority(child.pid, nice);
      } catch {
        /* inherited niceness */
      }
      children.push(child);
      live++;
      child.on('message', (msg) => {
        if (msg.type === 'ready') return next(child);
        if (msg.type === 'error') {
          failure = msg.message;
          stopAll('error');
          return;
        }
        if (msg.type !== 'pair' || status !== 'running') return;
        const row = {
          protocolSHA256: digest,
          index: msg.index,
          seed: msg.seed,
          pairMs: msg.pairMs,
          workerRssMB: msg.rssMB,
          completedAt: new Date().toISOString(),
          matches: msg.matches,
        };
        appendFileSync(join(out, 'pairs.jsonl'), JSON.stringify(row) + '\n');
        rows.push(row);
        pairTimes.push(msg.pairMs);
        peakRssMB = Math.max(peakRssMB, msg.rssMB);
        const wins = rows.flatMap((r) => r.matches).filter((m) => m.focalResult === 'win').length;
        const mean = pairTimes.reduce((a, b) => a + b, 0) / pairTimes.length;
        progress({
          focalWins: wins,
          matches: rows.length * 2,
          meanPairMs: Math.round(mean),
          etaMinutes: Math.round((queue.length * mean) / workers / 60000),
          peakWorkerRssMB: peakRssMB,
        });
        next(child);
      });
      child.on('exit', (code, signal) => {
        if (status === 'running' && (code || (signal && !child.stopping))) {
          failure = `worker ${child.pid} exited (${code ?? signal}) during pair ${child.current}`;
          stopAll('error');
        }
        if (--live === 0) {
          clearInterval(timer);
          finish();
        }
      });
      child.send({
        type: 'init',
        ort: ortKind,
        champion: championFile,
        belief: beliefFile,
        budget: budgetName,
        clint,
      });
    }
  });
  if (status === 'running') status = rows.length === seeds.length ? 'complete' : 'incomplete';
  const summary = await summarize(rows);
  const report = {
    protocolSHA256: digest,
    ...protocol,
    status,
    error: failure,
    run: { ...run, finishedAt: new Date().toISOString(), peakWorkerRssMB: peakRssMB },
    completedPairs: rows.length,
    summary,
  };
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  progress({ summaryFile: 'report.json' });
  const { sourcesSHA256: _s, mirroredSourcesSHA256: _m, opponent, ...printed } = report;
  console.log(
    JSON.stringify(
      {
        ...printed,
        opponent: {
          version: opponent.version,
          path: opponent.path,
          ruleBotCombinedSHA256: opponent.ruleBotCombinedSHA256,
        },
      },
      null,
      2,
    ),
  );
  if (failure) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const args = parseArgs(process.argv.slice(2));
  if (args.worker) await worker();
  else
    await main(args).catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
