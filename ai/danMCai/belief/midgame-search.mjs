/**
 * Development check (NOT preregistered, development seeds only, no training data written):
 * midgame one-step rollout search over champion 017 with a "net-d" guard, with the sampled worlds
 * drawn either uniformly or from the hand-inference (belief) network.
 *
 * This is the committed, cleaned-up version of the git-ignored diagnostic
 * ai/danMCai/workspace/rollout2.mjs (--net=d, uniform worlds, no exact solver, no truth/likelihood
 * options). With --worlds-source=uniform it makes exactly rollout2's choices.
 *
 * Paired rounds as in ai/danMCai/endgame/evaluate.mjs: each deal (createRound(seed)) is played
 * twice with sides swapped. The other team always plays champion greedy. The focal team plays
 * champion greedy (finishing move first, single candidate automatic) except at its real decisions
 * while the table holds between `lo` and `hi` cards inclusive, where it searches:
 *   1. candidate set = champion top-K by Q (distinct indices, ties by index) plus pass if legal;
 *   2. W worlds of the unseen cards, seeded by worldSeed(deal seed, ply) = (seed*1009 + ply*7919)>>>0
 *      (ply = number of public log entries so far), the SAME worlds for every candidate (common
 *      random numbers):
 *        uniform  sampleWorlds(searchObservation(game, mover))       (ai/shared/search/belief.mjs)
 *        belief   sampleBeliefWorlds(observation, probs)  with probs = belief network on
 *                 publicView(game, mover)                             (ai/danMCai/belief/)
 *   3. in every world and for every candidate a: play a, then all four seats play champion greedy,
 *      each seat seeing only its own WORLD hand and the public log, to the end of the round;
 *   4. value(a) = mean signed round points for the mover's team over the W worlds;
 *   5. net-d rule: keep the champion move c unless some candidate r has
 *      sum_w sign(o[w][r] - o[w][c]) >= d and mean(r) > mean(c); among the allowed candidates
 *      (always including c) take the highest mean, ties within 1e-9 broken by the champion's Q.
 *      d = 0 means plain rollout argmax.
 * Hidden information: the search runs on a masked copy of the game whose other three hands are
 * placeholders of the right length (any read of a hidden card throws). The belief features and the
 * world sampler see only the mover's public view; the true deal is never used for a decision.
 * mode=champion plays champion everywhere (pairing sanity check: every pair must score 0).
 *
 * Optional endgame arm (--endgame=pimc; default --endgame=none is exactly the behaviour above,
 * with identical per-pair rows): at the focal team's real decisions (not a finishing move, more
 * than one candidate) with at most `endgameHi` (< lo) cards on the table, choose as
 * ai/danMCai/endgame/evaluate.mjs --policy=pimc-search does: exact value (createSolver, budget
 * evaluate.mjs SEARCH.solver) of EVERY candidate in each of 8 worlds seeded by
 * worldSeed(deal seed, ply), mean over the solved worlds, at least 4 solved worlds else the
 * champion move (counted as a fallback), argmax with ties within 1e-9 broken by the champion's Q.
 *   --endgame-worlds=uniform  sampleWorlds as pimc-actor.mjs labelDecision (evaluate.mjs
 *                             searchChoice is called directly, on the masked game);
 *   --endgame-worlds=belief   sampleBeliefWorlds with the same --belief network as the midgame
 *                             (note: the v1 belief model was trained on 21-80 card positions, so
 *                             endgame positions are outside its training band).
 * The midgame band keeps its rollout net-d search with --worlds-source. The endgame search also
 * runs on the masked game; the true deal never decides anything.
 *
 * Optional focal raw network (--focal-raw-model=<onnx>, window 3, plan section 8 item 7): the
 * focal team's RAW decisions (not a finishing move, more than one candidate) with MORE than `hi`
 * cards on the table are taken by argmax of this model instead of the champion. The model has an
 * `extras` input of width 215 per candidate row: the 53 public extras of
 * web/src/ai/policy-features.mjs encodePolicyExtrasBatch followed by the 162 belief marginals
 * beliefMarginals(--belief, publicView(masked game, mover)) of ai/danMCai/belief/sampler.mjs, the
 * same function the trainer's fast actor uses (one belief inference per decision, shared by every
 * candidate). Everything else keeps --champion: the other team, the candidate set and Q of the
 * search band, the rollouts, the endgame solver and its worlds. --mode=raw: no search at all, the
 * focal team plays the focal raw network at every raw decision (damage-stop checks). The model's
 * SHA-256 is in run.json and in every per-pair row; round rows gain raw* fields only when the
 * option is on, so default rows are unchanged. web/src/ai/search/core.mjs is not involved.
 *
 * Metric: focal mean signed round points per deal pair, 95% deal-cluster normal interval; workers
 * take seeds start+part, start+part+parts, ...; the summary uses the contiguous completed prefix.
 * Per-pair rows (part-*.jsonl) allow a PAIRED comparison of two runs on the same seeds:
 *
 *   node ai/danMCai/belief/midgame-search.mjs --worlds-source=uniform|belief [--belief=<onnx>]
 *        --start=<seed> --pairs=<n> --out=<dir> [--workers=4] [--minutes=40]
 *        [--lo=21] [--hi=40] [--worlds=8] [--k=6] [--net=2] [--mode=search|champion|raw]
 *        [--champion=<onnx>] [--allow-champion=1] [--belief-train-report=<json>|none]
 *        [--endgame=none|pimc] [--endgame-hi=20] [--endgame-worlds=uniform|belief]
 *        [--focal-raw-model=<onnx> --belief=<onnx>] [--held-out=1]
 *   node ai/danMCai/belief/midgame-search.mjs --summarize=1 --out=<dir>
 *   node ai/danMCai/belief/midgame-search.mjs --compare=<dirA>,<dirB>     (reports B minus A)
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceRound, createRound } from '../../shared/simulation/simulation.mjs';
import { sampleWorlds } from '../../shared/search/belief.mjs';
import { searchObservation } from '../../shared/search/pimc.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { cardsArray, encode } from '../../../web/src/ai/encoding.mjs';
import { policyState } from '../../../web/src/ai/observation.js';
import {
  POLICY_EXTRA_FEATURES,
  encodePolicyExtrasBatch,
} from '../../../web/src/ai/policy-features.mjs';
import { makeDeck } from '../../../web/src/core/cards.js';
import { argmax, createModelPool, sha256 } from '../training/continuous/lib.mjs';
import { publicView } from './features.mjs';
import { beliefMarginals, createBeliefModel, sampleBeliefWorlds } from './sampler.mjs';
import { assertHeldOut, trainingSeedRanges } from './metrics.mjs';
import { SEARCH, createSearchSolver, searchChoice } from '../endgame/evaluate.mjs';
import { SolverBudget } from '../endgame/solver.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SELF), '../../..');
const deck = makeDeck();
export const DEFAULT_CHAMPION =
  '/Users/stevensun/guandan-runtime.noindex/endgame-oracle-20261108-r2/models/champion.onnx';
export const CHAMPION_SHA256 = '462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7';
export const DEFAULTS = Object.freeze({
  mode: 'search',
  worldsSource: 'uniform',
  lo: 21,
  hi: 40,
  worlds: 8,
  k: 6,
  net: 2,
  tieBreak: 'champion',
  endgame: 'none',
  endgameHi: 20,
  endgameWorlds: 'uniform',
});
const remaining = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);

/** World seed of a search decision: depends only on the deal seed and the public ply. */
export const worldSeed = (seed, ply) => (seed * 1009 + ply * 7919) >>> 0;

/**
 * Copy of `game` in which every hand except `seat`'s is a placeholder of the right length, so
 * that hand counts stay public while any read of a hidden card fails loudly.
 */
export function maskHidden(game, seat) {
  const hidden = {
    get id() {
      throw Error('Hidden card read during search');
    },
  };
  return {
    ...game,
    hands: game.hands.map((hand, s) => (s === seat ? hand : Array(hand.length).fill(hidden))),
  };
}

/** Greedy champion choice for the seat to move (finishing move first, single candidate auto). */
async function greedy(game, cfg, counter) {
  const player = game.turn;
  const plays = candidates(game.hands[player], game.L, game.trick?.play);
  let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
  if (index < 0 && plays.length === 1) index = 0;
  if (index < 0) {
    counter.inferences++;
    index = argmax(await cfg.values(cfg.champion, policyState(game, player, 0, plays)));
  }
  return plays[index];
}

/** Mover-team signed points after `play` in this world, all four seats champion greedy after. */
async function rollout(world, play, moverTeam, cfg, counter) {
  let result = advanceRound(world, play);
  for (let ply = 0; !result && ply < 1000; ply++)
    result = advanceRound(world, await greedy(world, cfg, counter));
  if (!result) throw Error('Rollout did not terminate');
  return result.winner === moverTeam ? result.points : -result.points;
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

/**
 * Net-d choice. outcome[w][r] = signed points of root r in world w; c = champion's root.
 * Returns the chosen ACTION index (roots holds action indices), the allowed tied set and the
 * in-search gain estimate mean(chosen) - mean(champion).
 */
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

/**
 * Worlds for a search decision from the mover's PUBLIC information only. `game` should already be
 * masked (maskHidden); returns { worlds, probs } (probs null for uniform).
 */
export async function sampleSearchWorlds(game, seed, cfg) {
  const player = game.turn;
  const observation = searchObservation(game, player);
  const wseed = worldSeed(seed, game.log.length);
  if (cfg.worldsSource === 'uniform')
    return { worlds: sampleWorlds(observation, { count: cfg.worlds, seed: wseed }), probs: null };
  if (cfg.worldsSource !== 'belief') throw Error(`Unknown worlds source ${cfg.worldsSource}`);
  if (!cfg.belief) throw Error('Belief worlds need a belief model');
  const probs = await cfg.belief.probabilities(publicView(game, player));
  return {
    worlds: sampleBeliefWorlds(observation, probs, { count: cfg.worlds, seed: wseed }),
    probs,
  };
}

const forMover = (team0Value, seat) => (seat % 2 === 0 ? team0Value : -team0Value);

/**
 * PIMC label of every candidate from GIVEN worlds (physical ids): the same computation as
 * labelDecision in ai/danMCai/endgame/pimc-actor.mjs, whose worlds are always uniform. Returns
 * { q, used }; q is null when fewer than `minWorlds` worlds were solved inside the budget.
 */
export function pimcLabelFromWorlds(game, plays, worlds, solver, minWorlds = SEARCH.minWorlds) {
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
    let values;
    try {
      values = plays.map((play) => forMover(solver.actionValue(position, play), position.turn));
    } catch (error) {
      if (!(error instanceof SolverBudget)) throw error;
      continue;
    }
    values.forEach((v, i) => (sums[i] += v));
    used++;
  }
  if (used < minWorlds) return { q: null, used };
  return { q: Array.from(sums, (s) => s / used), used };
}

/** evaluate.mjs searchChoice's rule on a label: argmax, ties within 1e-9 to the champion's Q. */
export function pimcPick({ q, used }, base) {
  if (!q) return { index: null, used, tied: 0 };
  const top = Math.max(...q);
  const tied = [];
  q.forEach((y, i) => Math.abs(y - top) <= SEARCH.tieTolerance && tied.push(i));
  const index = tied.reduce((best, i) => (base[i] > base[best] ? i : best), tied[0]);
  return { index, used, tied: tied.length };
}

/**
 * One endgame PIMC decision for the seat to move, on the masked game. uniform worlds: evaluate.mjs
 * searchChoice itself; belief worlds: sampleBeliefWorlds (8 worlds, same world seed) and the same
 * label and choice rule. `index` falls back to the champion move when no label is available.
 */
export async function endgameDecision(trueGame, seed, cfg) {
  const t0 = performance.now();
  const player = trueGame.turn;
  const game = maskHidden(trueGame, player);
  const ply = game.log.length;
  const plays = candidates(game.hands[player], game.L, game.trick?.play);
  const base = await cfg.values(cfg.champion, policyState(game, player, 0, plays));
  const championIndex = argmax(base);
  let choice,
    worlds = null,
    probs = null,
    beliefMs = 0;
  if (cfg.endgameWorlds === 'uniform')
    choice = searchChoice(game, plays, base, { solver: cfg.solver, seed, ply });
  else if (cfg.endgameWorlds === 'belief') {
    const tb = performance.now();
    ({ worlds, probs } = await sampleSearchWorlds(game, seed, {
      worldsSource: 'belief',
      belief: cfg.belief,
      worlds: SEARCH.worlds,
    }));
    beliefMs = performance.now() - tb;
    choice = pimcPick(pimcLabelFromWorlds(game, plays, worlds, cfg.solver), base);
  } else throw Error(`Unknown endgame worlds ${cfg.endgameWorlds}`);
  return {
    index: choice.index ?? championIndex,
    fallback: choice.index === null,
    used: choice.used,
    tied: choice.tied,
    championIndex,
    plays,
    base,
    worlds,
    probs,
    beliefMs,
    ms: performance.now() - t0,
  };
}

/**
 * One search decision for the seat to move. The game is masked here, so only the mover's own hand,
 * hand counts and the public log can influence the result.
 */
export async function searchDecision(trueGame, seed, cfg) {
  const t0 = performance.now();
  const player = trueGame.turn;
  const game = maskHidden(trueGame, player);
  const plays = candidates(game.hands[player], game.L, game.trick?.play);
  const base = await cfg.values(cfg.champion, policyState(game, player, 0, plays));
  const championIndex = argmax(base);
  const roots = searchRootsOf(base, plays, cfg.k);
  const counter = { inferences: 0 };
  const tb = performance.now();
  const { worlds, probs } = await sampleSearchWorlds(game, seed, cfg);
  const beliefMs = cfg.worldsSource === 'belief' ? performance.now() - tb : 0;
  const sums = new Float64Array(roots.length);
  const outcome = worlds.map(() => new Float64Array(roots.length));
  for (let w = 0; w < worlds.length; w++)
    for (let r = 0; r < roots.length; r++) {
      outcome[w][r] = await rollout(
        worldGame(game, worlds[w]),
        plays[roots[r]],
        player % 2,
        cfg,
        counter,
      );
      sums[r] += outcome[w][r];
    }
  const means = Array.from(sums, (s) => s / worlds.length);
  const choice = netChoice({ roots, championIndex, means, outcome, base, net: cfg.net });
  return {
    ...choice,
    plays,
    base,
    championIndex,
    roots,
    means,
    outcome,
    worlds,
    probs,
    inferences: counter.inferences,
    beliefMs,
    ms: performance.now() - t0,
  };
}

/** Belief marginals per decision (3 hidden seats x 54 cards) and the focal raw extras width. */
export const BELIEF_MARGINALS = 162;
export const FOCAL_RAW_EXTRAS = POLICY_EXTRA_FEATURES + BELIEF_MARGINALS;

/**
 * policyState plus the public trick and one shape per action, built exactly as the trainer's fast
 * rollout (ai/danMCai/training/continuous/fast-rollout.mjs) builds the state its actor scores.
 */
export function rawPolicyState(game, player, plays) {
  const state = policyState(game, player, 0, plays);
  const play = game.trick?.play;
  state.trick = game.trick
    ? { player: game.trick.player, play: { type: play.type, value: play.value, n: play.n } }
    : null;
  state.actionShapes = plays.map((x) => x && { type: x.type, value: x.value, n: x.n });
  return state;
}

/** Row-major [actions, 215]: the 53 public extras of each row, then the decision's 162 marginals. */
export function focalRawExtras(state, marginals) {
  if (marginals?.length !== BELIEF_MARGINALS || !Array.from(marginals).every(Number.isFinite))
    throw Error(`Belief marginals must be ${BELIEF_MARGINALS} finite numbers`);
  const pub = encodePolicyExtrasBatch(state);
  const n = state.actions.length;
  const extras = new Float32Array(n * FOCAL_RAW_EXTRAS);
  for (let i = 0; i < n; i++) {
    extras.set(
      pub.subarray(i * POLICY_EXTRA_FEATURES, (i + 1) * POLICY_EXTRA_FEATURES),
      i * FOCAL_RAW_EXTRAS,
    );
    extras.set(marginals, i * FOCAL_RAW_EXTRAS + POLICY_EXTRA_FEATURES);
  }
  return extras;
}

/**
 * Scorer for a 215-extras action-value ONNX (inputs state [1, 513], actions [n, 54], extras
 * [n, 215]; output values [n]). The tensors are built as web/src/ai/policy-inference.mjs
 * inferPolicy builds them (encode, cardsArray, chunks of 128 candidates); inferPolicy itself only
 * accepts the 53/61-wide layouts, so the 215-wide extras are assembled here.
 */
export async function createFocalRawScorer(ort, file, { threads = 1 } = {}) {
  const session = await ort.InferenceSession.create(file, {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  });
  const metadata = session.inputMetadata;
  const list = Array.isArray(metadata) ? metadata : Object.values(metadata ?? {});
  const width = list.find((m) => m?.name === 'extras')?.shape?.[1];
  if (
    !session.inputNames.includes('extras') ||
    (typeof width === 'number' && width !== FOCAL_RAW_EXTRAS)
  ) {
    await session.release();
    throw Error(`${file} has no ${FOCAL_RAW_EXTRAS}-wide extras input (width ${width})`);
  }
  return {
    async values(state, marginals) {
      if (!state.actions?.length) throw Error('No actions');
      const extras = focalRawExtras(state, marginals);
      const values = [];
      const stateTensor = new ort.Tensor('float32', encode(state), [1, 513]);
      try {
        for (let first = 0; first < state.actions.length; first += 128) {
          const chunk = state.actions.slice(first, first + 128);
          const batch = new Float32Array(chunk.length * 54);
          chunk.forEach((cards, i) => batch.set(cardsArray(cards), i * 54));
          const output = await session.run({
            state: stateTensor,
            actions: new ort.Tensor('float32', batch, [chunk.length, 54]),
            extras: new ort.Tensor(
              'float32',
              extras.slice(first * FOCAL_RAW_EXTRAS, (first + chunk.length) * FOCAL_RAW_EXTRAS),
              [chunk.length, FOCAL_RAW_EXTRAS],
            ),
          });
          const data = output.values?.data;
          const ok = data?.length === chunk.length && data.every(Number.isFinite);
          if (ok) values.push(...data);
          for (const tensor of Object.values(output)) tensor.dispose?.();
          if (!ok) throw Error('Invalid focal raw model output');
        }
      } finally {
        stateTensor.dispose?.();
      }
      return values;
    },
    async close() {
      await session.release();
    },
  };
}

/**
 * One raw decision of the focal raw network for the seat to move, on the masked game: belief
 * marginals from the mover's public view, 215 extras per candidate, argmax (first maximum, as
 * lib.mjs argmax). `championIndex` is the champion's greedy choice at the same state (recorded only).
 */
export async function focalRawDecision(trueGame, cfg) {
  const t0 = performance.now();
  const player = trueGame.turn;
  const game = maskHidden(trueGame, player);
  const plays = candidates(game.hands[player], game.L, game.trick?.play);
  const championIndex = argmax(await cfg.values(cfg.champion, policyState(game, player, 0, plays)));
  const tb = performance.now();
  const marginals = await beliefMarginals(cfg.belief, publicView(game, player));
  const beliefMs = performance.now() - tb;
  const values = await cfg.focalRaw.values(rawPolicyState(game, player, plays), marginals);
  if (values.length !== plays.length) throw Error('Focal raw values do not match the candidates');
  return {
    index: argmax(values),
    championIndex,
    plays,
    values,
    marginals,
    beliefMs,
    ms: performance.now() - t0,
  };
}

/** One round of a deal with `focalTeam` searching; result from the focal team's view. */
export async function playRound(seed, focalTeam, cfg) {
  const game = createRound(seed);
  const stats = {
    bandDecisions: 0,
    searched: 0,
    differs: 0,
    ties: 0,
    searchMs: 0,
    beliefMs: 0,
    inferences: 0,
    candidatesSearched: 0,
    gainEstimate: 0, // mean(chosen) - mean(champion move), in-search estimate only
    differPlies: [],
  };
  // Endgame fields only with --endgame=pimc, so default rows are unchanged.
  const endgameOn = (cfg.endgame ?? 'none') === 'pimc';
  if (endgameOn) {
    if (!(cfg.endgameHi < cfg.lo)) throw Error('Endgame and midgame bands overlap');
    if (!cfg.solver) throw Error('--endgame=pimc needs a solver');
    Object.assign(stats, {
      endgameDecisions: 0,
      endgameSearched: 0,
      endgameFallbacks: 0,
      endgameDiffers: 0,
      endgameTies: 0,
      endgameWorldsUsed: 0,
      endgameMs: 0,
      endgameMaxMs: 0,
      endgameBeliefMs: 0,
      endgameDifferPlies: [],
    });
  }
  // Focal raw network fields only with --focal-raw-model, so default rows are unchanged.
  const rawOn = !!cfg.focalRaw;
  if (rawOn) {
    if (!['search', 'raw'].includes(cfg.mode))
      throw Error('--focal-raw-model needs mode search|raw');
    if (!cfg.belief) throw Error('--focal-raw-model needs the belief network for its marginals');
    Object.assign(stats, {
      rawDecisions: 0,
      rawDiffers: 0, // focal raw choice != champion greedy choice at the same state
      rawMs: 0,
      rawBeliefMs: 0,
      rawDifferPlies: [],
    });
  } else if (cfg.mode === 'raw') throw Error('--mode=raw needs --focal-raw-model');
  for (let ply = 0; ply < 1000; ply++) {
    if (ply !== game.log.length) throw Error('Ply must equal the public log length');
    const player = game.turn;
    const plays = candidates(game.hands[player], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
    if (index < 0 && plays.length === 1) index = 0;
    if (index < 0) {
      const cards = remaining(game);
      const inBand = player % 2 === focalTeam && cards >= cfg.lo && cards <= cfg.hi;
      const inEndgame = endgameOn && player % 2 === focalTeam && cards <= cfg.endgameHi;
      let championIndex;
      if (inEndgame && cfg.mode === 'search') {
        const d = await endgameDecision(game, seed, cfg);
        index = d.index;
        championIndex = d.championIndex;
        stats.endgameSearched++;
        stats.endgameFallbacks += Number(d.fallback);
        stats.endgameTies += Number(d.tied > 1);
        stats.endgameWorldsUsed += d.used;
        stats.endgameMs += d.ms;
        stats.endgameMaxMs = Math.max(stats.endgameMaxMs, d.ms);
        stats.endgameBeliefMs += d.beliefMs;
      } else if (inBand && cfg.mode === 'search') {
        const d = await searchDecision(game, seed, cfg);
        index = d.index;
        championIndex = d.championIndex;
        if (d.tied.length > 1) stats.ties++;
        stats.searched++;
        stats.searchMs += d.ms;
        stats.beliefMs += d.beliefMs;
        stats.inferences += d.inferences;
        stats.candidatesSearched += d.roots.length;
        stats.gainEstimate += d.gain;
      } else if (
        rawOn &&
        player % 2 === focalTeam &&
        (cfg.mode === 'raw' || (cfg.mode === 'search' && cards > cfg.hi))
      ) {
        const d = await focalRawDecision(game, cfg);
        index = d.index;
        championIndex = d.championIndex;
        stats.rawDecisions++;
        stats.rawMs += d.ms;
        stats.rawBeliefMs += d.beliefMs;
        if (index !== championIndex) {
          stats.rawDiffers++;
          stats.rawDifferPlies.push(ply);
        }
      } else {
        championIndex = argmax(await cfg.values(cfg.champion, policyState(game, player, 0, plays)));
        index = championIndex;
      }
      if (inBand) {
        stats.bandDecisions++;
        if (index !== championIndex) {
          stats.differs++;
          stats.differPlies.push(ply);
        }
      }
      if (inEndgame) {
        stats.endgameDecisions++;
        if (index !== championIndex) {
          stats.endgameDiffers++;
          stats.endgameDifferPlies.push(ply);
        }
      }
    }
    const result = advanceRound(game, plays[index]);
    if (result) {
      const points = result.winner === focalTeam ? result.points : -result.points;
      return { points, order: result.order, plies: ply + 1, ...stats };
    }
  }
  throw Error('Round did not terminate');
}

/** Both sides of a deal; `mean` is the focal mean signed points of the pair. */
export async function playPair(seed, cfg) {
  const t0 = performance.now();
  const a = await playRound(seed, 0, cfg);
  const b = await playRound(seed, 1, cfg);
  const row = { seed, a, b, mean: (a.points + b.points) / 2, ms: performance.now() - t0 };
  return cfg.focalRaw ? { ...row, focalRawModelSHA256: cfg.focalRawModelSHA256 } : row;
}

const HELD_OUT_NOTE = 'held-out seeds; the decision rule is in the preregistered window protocol';
const intervalNote = (heldOut, paired) =>
  (paired
    ? 'paired deal-cluster normal approximation; '
    : 'deal-pair cluster, normal approximation; ') +
  (heldOut ? HELD_OUT_NOTE : 'development seeds, not held-out');

/** Mean with a 95% normal interval over clusters (one value per deal pair). */
export function clusterInterval(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, sd: null, ci95: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const half = (1.96 * sd) / Math.sqrt(n);
  return { n, mean, sd, ci95: [mean - half, mean + half] };
}

export function summarize(rows, { heldOut = false } = {}) {
  const means = rows.map((r) => r.mean);
  const { n, mean, sd, ci95 } = clusterInterval(means);
  const rounds = rows.flatMap((r) => [r.a, r.b]);
  const sum = (key) => rounds.reduce((s, r) => s + (r[key] || 0), 0);
  const searched = sum('searched');
  return {
    pairs: n,
    rounds: rounds.length,
    focalWins: rounds.filter((r) => r.points > 0).length,
    focalLosses: rounds.filter((r) => r.points < 0).length,
    pairsZero: means.filter((m) => m === 0).length,
    pairsPositive: means.filter((m) => m > 0).length,
    pairsNegative: means.filter((m) => m < 0).length,
    meanSignedPoints: mean,
    sd,
    ci95,
    interval: intervalNote(heldOut, false),
    focalBandDecisions: sum('bandDecisions'),
    searchedDecisions: searched,
    decisionsDifferentFromChampion: sum('differs'),
    fractionDiffering: searched ? sum('differs') / searched : null,
    tiedRolloutArgmax: sum('ties'),
    meanCandidatesSearched: searched ? sum('candidatesSearched') / searched : null,
    secondsPerSearchedDecision: searched ? sum('searchMs') / 1000 / searched : null,
    beliefSecondsPerSearchedDecision: searched ? sum('beliefMs') / 1000 / searched : null,
    inferencesPerSearchedDecision: searched ? sum('inferences') / searched : null,
    meanInSearchGainEstimate: searched ? sum('gainEstimate') / searched : null,
    meanPairSeconds: n ? rows.reduce((s, r) => s + r.ms, 0) / 1000 / n : null,
    ...(rounds.some((r) => 'endgameSearched' in r) ? { endgame: endgameSummary(sum, rounds) } : {}),
    ...(rounds.some((r) => 'rawDecisions' in r) ? { focalRaw: focalRawSummary(sum, rows) } : {}),
  };
}

/** Focal raw network totals (only for runs with --focal-raw-model). */
function focalRawSummary(sum, rows) {
  const decisions = sum('rawDecisions');
  const per = (key, scale = 1) => (decisions ? sum(key) / scale / decisions : null);
  return {
    modelSHA256: [...new Set(rows.map((r) => r.focalRawModelSHA256 ?? null))],
    rawDecisions: decisions,
    decisionsDifferentFromChampion: sum('rawDiffers'),
    fractionDiffering: per('rawDiffers'),
    secondsPerRawDecision: per('rawMs', 1000),
    beliefSecondsPerRawDecision: per('rawBeliefMs', 1000),
    note: 'differing = the focal raw network argmax differs from the champion greedy choice at the same state; seconds include one champion and one belief inference per decision',
  };
}

/** Endgame-arm totals (only for runs with --endgame=pimc); the fields above are midgame-only. */
function endgameSummary(sum, rounds) {
  const searched = sum('endgameSearched');
  const per = (key, scale = 1) => (searched ? sum(key) / scale / searched : null);
  return {
    focalEndgameDecisions: sum('endgameDecisions'),
    searchedDecisions: searched,
    fallbacksToChampion: sum('endgameFallbacks'),
    decisionsDifferentFromChampion: sum('endgameDiffers'),
    fractionDiffering: per('endgameDiffers'),
    tiedLabelMaximum: sum('endgameTies'),
    meanWorldsUsed: per('endgameWorldsUsed'),
    secondsPerSearchedDecision: per('endgameMs', 1000),
    maxSecondsPerSearchedDecision: Math.max(0, ...rounds.map((r) => r.endgameMaxMs || 0)) / 1000,
    beliefSecondsPerSearchedDecision: per('endgameBeliefMs', 1000),
    note: 'seconds include the champion forward pass of the decision; solver results depend on the 3 s per-world budget and the worker transposition table, so they are not bit-reproducible',
  };
}

/** All per-pair rows of a run directory and the contiguous completed prefix from `start`. */
export function collect(out, workers, start) {
  const all = [];
  for (let part = 0; part < workers; part++) {
    const file = join(out, `part-${part}.jsonl`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n'))
      if (line.trim()) all.push(JSON.parse(line));
  }
  const completed = new Set(all.map((r) => r.seed));
  let last = start - 1;
  while (completed.has(last + 1)) last++;
  const rows = all.filter((r) => r.seed <= last).sort((a, b) => a.seed - b.seed);
  return { all, rows, last };
}

const COMPARED_SETTINGS = [
  'mode',
  'worldsSource',
  'lo',
  'hi',
  'worlds',
  'k',
  'net',
  'tieBreak',
  'endgame',
  'endgameHi',
  'endgameWorlds',
  'focalRawModelSHA256',
  'heldOut',
];
/** Values of settings that runs from before the endgame / focal raw options did not record. */
const LEGACY_SETTINGS = { endgame: 'none', heldOut: false };

/**
 * Paired comparison of two runs on their common contiguous-prefix seeds: per deal the difference
 * d = mean_B - mean_A (each already a pair mean), with a deal-cluster 95% normal interval.
 */
export function compareRows(rowsA, rowsB, { heldOut = false } = {}) {
  const byA = new Map(rowsA.map((r) => [r.seed, r]));
  const common = rowsB.filter((r) => byA.has(r.seed)).sort((x, y) => x.seed - y.seed);
  const diffs = common.map((r) => r.mean - byA.get(r.seed).mean);
  const a = clusterInterval(common.map((r) => byA.get(r.seed).mean));
  const b = clusterInterval(common.map((r) => r.mean));
  const d = clusterInterval(diffs);
  return {
    commonPairs: common.length,
    seeds: common.length ? [common[0].seed, common.at(-1).seed] : null,
    meanA: a.mean,
    meanB: b.mean,
    difference: 'B minus A, focal mean signed round points per deal pair',
    meanDifference: d.mean,
    sdDifference: d.sd,
    ci95: d.ci95,
    interval: intervalNote(heldOut, true),
    pairsIdentical: diffs.filter((x) => x === 0).length,
    pairsBBetter: diffs.filter((x) => x > 0).length,
    pairsABetter: diffs.filter((x) => x < 0).length,
  };
}

export function compareRuns(dirA, dirB) {
  const load = (dir) => {
    const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    return { run, ...collect(dir, run.workers, run.start) };
  };
  const A = load(resolve(dirA)),
    B = load(resolve(dirB));
  if (A.run.championSHA256 !== B.run.championSHA256)
    throw Error('Runs use different champions; a paired comparison is not meaningful');
  const settingDifferences = Object.fromEntries(
    [...COMPARED_SETTINGS, 'beliefSHA256']
      .map((key) => [key, [A, B].map(({ run }) => run[key] ?? LEGACY_SETTINGS[key] ?? null)])
      .filter(([, [a, b]]) => a !== b),
  );
  return {
    A: resolve(dirA),
    B: resolve(dirB),
    championSHA256: A.run.championSHA256,
    settingDifferences,
    prefixPairs: [A.rows.length, B.rows.length],
    ...compareRows(A.rows, B.rows, { heldOut: !!(A.run.heldOut && B.run.heldOut) }),
  };
}

/** Repo-relative paths and SHA-256 of `entry` and every module it statically imports (relative). */
export function sourceClosure(entry = SELF) {
  const seen = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    const text = readFileSync(file, 'utf8');
    seen.set(file, sha256(file));
    const pattern = /(?:^|\n)\s*(?:import|export)\b[^'"]*?['"](\.{1,2}\/[^'"]+)['"]/g;
    for (const match of text.matchAll(pattern)) visit(resolve(dirname(file), match[1]));
  };
  visit(entry);
  return Object.fromEntries(
    [...seen]
      .map(([file, hash]) => [relative(REPO, file).replaceAll('\\', '/'), hash])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

function gitState(files) {
  try {
    const head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const status = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', ...files], {
      encoding: 'utf8',
    });
    return { head, sourcesDirtyOrUntracked: status.split('\n').filter(Boolean) };
  } catch {
    return null;
  }
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

const parseArgs = (argv) =>
  Object.fromEntries(
    argv
      .filter((a) => a.startsWith('--'))
      .map((a) => {
        const eq = a.indexOf('=');
        return eq < 0 ? [a.slice(2), '1'] : [a.slice(2, eq), a.slice(eq + 1)];
      }),
  );

/** Validated protocol for a new run (throws on a wrong champion or a belief/seed overlap). */
export function buildProtocol(args) {
  const num = (key, arg = key) => Number(args[arg] ?? DEFAULTS[key]);
  const protocol = {
    purpose:
      'development check of midgame one-step rollout search (net-d) with uniform or belief worlds; ' +
      'not preregistered; dev seeds; not an acceptance result',
    mode: args.mode ?? DEFAULTS.mode,
    worldsSource: args['worlds-source'] ?? DEFAULTS.worldsSource,
    start: Number(args.start),
    pairs: Number(args.pairs),
    lo: num('lo'),
    hi: num('hi'),
    worlds: num('worlds'),
    k: num('k'),
    net: num('net'),
    tieBreak: DEFAULTS.tieBreak,
    worldSeedRule:
      '(dealSeed*1009 + ply*7919)>>>0, ply = public log length; same worlds per candidate',
    champion: resolve(args.champion ?? DEFAULT_CHAMPION),
    belief: null,
    beliefSHA256: null,
    beliefTrainingSeeds: null,
    endgame: args.endgame ?? DEFAULTS.endgame,
    endgameHi: null,
    endgameWorlds: null,
    focalRawModel: null,
    focalRawModelSHA256: null,
    heldOut: args['held-out'] === '1',
  };
  if (!['search', 'champion', 'raw'].includes(protocol.mode))
    throw Error('--mode=search|champion|raw');
  if (protocol.heldOut)
    protocol.purpose =
      'held-out run of the configuration below; seeds and the decision rule are fixed in the ' +
      'preregistered window protocol';
  if (!['uniform', 'belief'].includes(protocol.worldsSource))
    throw Error('--worlds-source=uniform|belief');
  for (const key of ['start', 'pairs', 'lo', 'hi', 'worlds', 'k', 'net'])
    if (!Number.isInteger(protocol[key]) || protocol[key] < 0) throw Error(`--${key}`);
  if (protocol.pairs < 1 || protocol.worlds < 1 || protocol.k < 1)
    throw Error('--pairs/--worlds/--k');
  if (protocol.start + protocol.pairs > 2 ** 32) throw Error('Seeds must stay below 2^32');
  protocol.championSHA256 = sha256(protocol.champion);
  if (protocol.championSHA256 !== CHAMPION_SHA256 && args['allow-champion'] !== '1')
    throw Error(`Champion SHA-256 ${protocol.championSHA256} is not the frozen 017 copy`);
  if (protocol.endgame === 'pimc') {
    protocol.endgameHi = num('endgameHi', 'endgame-hi');
    protocol.endgameWorlds = args['endgame-worlds'] ?? DEFAULTS.endgameWorlds;
    if (!Number.isInteger(protocol.endgameHi) || protocol.endgameHi < 0)
      throw Error('--endgame-hi');
    if (protocol.endgameHi >= protocol.lo)
      throw Error(`Bands overlap: --endgame-hi=${protocol.endgameHi} must be below --lo`);
    if (!['uniform', 'belief'].includes(protocol.endgameWorlds))
      throw Error('--endgame-worlds=uniform|belief');
    protocol.endgameSearch = {
      ...SEARCH,
      rule:
        'evaluate.mjs --policy=pimc-search: exact value of every candidate per world, mean over ' +
        'solved worlds, champion move if fewer than minWorlds solved, argmax with champion-Q tie-break',
      worldSampler:
        protocol.endgameWorlds === 'uniform'
          ? 'sampleWorlds as pimc-actor labelDecision (evaluate.mjs searchChoice)'
          : 'sampleBeliefWorlds with the --belief network on publicView',
    };
    protocol.purpose +=
      '; combined with 8-world exact PIMC endgame search at <= endgameHi cards (focal team)';
  } else if (protocol.endgame !== 'none') throw Error('--endgame=none|pimc');
  else if (args['endgame-hi'] !== undefined || args['endgame-worlds'] !== undefined)
    throw Error('--endgame-hi/--endgame-worlds are only used with --endgame=pimc');
  if (args['focal-raw-model'] !== undefined) {
    if (!['search', 'raw'].includes(protocol.mode))
      throw Error('--focal-raw-model is only used with --mode=search|raw');
    protocol.focalRawModel = resolve(args['focal-raw-model']);
    protocol.focalRawModelSHA256 = sha256(protocol.focalRawModel);
    if (protocol.focalRawModelSHA256 === protocol.championSHA256)
      throw Error('--focal-raw-model is the champion file itself (it needs a 215-extras input)');
    protocol.focalRawExtras = {
      width: FOCAL_RAW_EXTRAS,
      layout:
        `${POLICY_EXTRA_FEATURES} public extras (web/src/ai/policy-features.mjs ` +
        `encodePolicyExtrasBatch) then ${BELIEF_MARGINALS} belief marginals ` +
        '(ai/danMCai/belief/sampler.mjs beliefMarginals(--belief, publicView(masked game, mover))), ' +
        'one belief inference per decision shared by every candidate row',
      appliesTo:
        protocol.mode === 'raw'
          ? 'every focal raw decision (no search, no endgame search)'
          : 'focal raw decisions with more than hi cards on the table; band search, endgame ' +
            'search, rollouts, candidates and the other team keep the champion',
    };
    protocol.purpose +=
      protocol.mode === 'raw'
        ? '; focal team plays the focal raw network greedily at every raw decision, no search'
        : '; focal raw decisions above hi cards by the focal raw network';
  } else if (protocol.mode === 'raw') throw Error('--mode=raw needs --focal-raw-model=<onnx>');
  if (protocol.mode === 'raw') {
    if (protocol.endgame !== 'none') throw Error('--mode=raw plays no endgame search');
    if (protocol.worldsSource !== 'uniform') throw Error('--mode=raw samples no search worlds');
  }
  const needsBelief =
    protocol.worldsSource === 'belief' ||
    protocol.endgameWorlds === 'belief' ||
    !!protocol.focalRawModel;
  if (needsBelief) {
    if (!args.belief)
      throw Error(
        '--worlds-source=belief, --endgame-worlds=belief or --focal-raw-model needs --belief=<onnx>',
      );
    protocol.belief = resolve(args.belief);
    protocol.beliefSHA256 = sha256(protocol.belief);
    const reportFile =
      args['belief-train-report'] ?? join(dirname(protocol.belief), 'train-report.json');
    if (reportFile !== 'none') {
      if (!existsSync(reportFile))
        throw Error(`No belief train report at ${reportFile}; pass --belief-train-report=none`);
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      const ranges = trainingSeedRanges(report);
      assertHeldOut([protocol.start, protocol.start + protocol.pairs - 1], ranges);
      protocol.beliefTrainingSeeds = ranges;
      protocol.beliefTrainingBands = (report.dataProtocols || [report.dataProtocol])
        .filter(Boolean)
        .map((p) => p.band ?? null);
      protocol.beliefTrainReport = resolve(reportFile);
      protocol.beliefTrainReportSHA256 = sha256(reportFile);
    } else protocol.beliefTrainReport = 'none (seed overlap not checked)';
    if (protocol.endgameWorlds === 'belief')
      protocol.endgameBeliefNote =
        `endgame worlds (<= ${protocol.endgameHi} cards) come from the belief network; the v1 ` +
        'belief model was trained on 21-80 card positions (training bands: ' +
        `${JSON.stringify(protocol.beliefTrainingBands ?? 'not checked')}), so these positions are ` +
        'outside its training band';
  } else if (args.belief)
    throw Error(
      '--belief is only used with --worlds-source=belief, --endgame-worlds=belief or --focal-raw-model',
    );
  return protocol;
}

/** Search config for a worker process (or a test) from a protocol. */
export async function createConfig(protocol, ort, { threads = 1 } = {}) {
  const pool = await createModelPool(ort, { threads, limit: 2 });
  const belief =
    protocol.worldsSource === 'belief' ||
    protocol.endgameWorlds === 'belief' ||
    protocol.focalRawModel
      ? await createBeliefModel(ort, protocol.belief, { threads })
      : null;
  const focalRaw = protocol.focalRawModel
    ? await createFocalRawScorer(ort, protocol.focalRawModel, { threads })
    : null;
  return {
    ...protocol,
    values: (file, state) => pool.values(file, state),
    belief,
    focalRaw,
    solver: protocol.endgame === 'pimc' ? createSearchSolver() : null,
    async close() {
      await pool.close();
      if (belief) await belief.close();
      if (focalRaw) await focalRaw.close();
    },
  };
}

async function worker(args) {
  const ort = await import('onnxruntime-node');
  const out = resolve(args.out);
  const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  const part = Number(args.part),
    parts = run.workers;
  const cfg = await createConfig(run, ort);
  const file = join(out, `part-${part}.jsonl`);
  const started = Date.now();
  let done = 0;
  for (let k = part; k < run.pairs; k += parts) {
    if (Date.now() >= run.deadline) break;
    appendFileSync(file, JSON.stringify(await playPair(run.start + k, cfg)) + '\n');
    done++;
    if (done % 5 === 0)
      process.stderr.write(
        `[w${part}] ${done} pairs, last seed ${run.start + k}, ` +
          `${((Date.now() - started) / 1000).toFixed(0)} s, ` +
          `rss ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB\n`,
      );
  }
  writeFileSync(
    join(out, `part-${part}.done.json`),
    JSON.stringify({ part, pairs: done, seconds: (Date.now() - started) / 1000 }),
  );
  await cfg.close();
}

async function main(args) {
  if (args.compare) {
    const [a, b] = args.compare.split(',');
    if (!a || !b) throw Error('--compare=<dirA>,<dirB>');
    console.log(JSON.stringify(compareRuns(a, b), null, 2));
    return;
  }
  const out = resolve(args.out ?? '');
  if (!args.out) throw Error('--out=<dir>');
  if (args.summarize) {
    const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
    const { all, rows, last } = collect(out, run.workers, run.start);
    console.log(
      JSON.stringify(
        { completedPairsTotal: all.length, seedRange: [run.start, last], ...summarize(rows, run) },
        null,
        2,
      ),
    );
    return;
  }
  if (existsSync(join(out, 'run.json'))) throw Error(`${out} already holds a run; use a new --out`);
  const workers = Number(args.workers ?? 4);
  const minutes = Number(args.minutes ?? 40);
  if (!Number.isInteger(workers) || workers < 1 || !(minutes > 0))
    throw Error('--workers/--minutes');
  const protocol = buildProtocol(args);
  const sources = sourceClosure();
  const run = {
    ...protocol,
    workers,
    minutes,
    deadline: Date.now() + minutes * 60_000,
    out,
    sources,
    git: gitState(Object.keys(sources)),
    node: process.version,
    onnxruntimeNode: packageVersion('onnxruntime-node'),
    startedAt: new Date().toISOString(),
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'run.json'), JSON.stringify(run, null, 2));
  const t0 = Date.now();
  const failures = [];
  await Promise.all(
    Array.from(
      { length: workers },
      (_, part) =>
        new Promise((done) => {
          const child = spawn(
            'nice',
            [
              '-n',
              '10',
              process.execPath,
              '--no-warnings',
              SELF,
              '--worker',
              `--part=${part}`,
              `--out=${out}`,
            ],
            { stdio: 'inherit' },
          );
          child.on('exit', (code) => {
            if (code !== 0) failures.push({ part, code });
            done();
          });
        }),
    ),
  );
  const { all, rows, last } = collect(out, workers, run.start);
  const summary = {
    ...run,
    finishedAt: new Date().toISOString(),
    wallClockMinutes: (Date.now() - t0) / 60_000,
    workerFailures: failures,
    completedPairsTotal: all.length,
    seedRange: [run.start, last],
    droppedBeyondPrefix: all.length - rows.length,
    ...(rows.length ? summarize(rows, run) : { pairs: 0 }),
  };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  const { sources: _, ...printed } = summary;
  console.log(JSON.stringify(printed, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const args = parseArgs(process.argv.slice(2));
  (args.worker ? worker(args) : main(args)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
