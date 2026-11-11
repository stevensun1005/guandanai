/**
 * Search actor (window 4, plan section 8 item 6, stage B4): self-play rounds in which ALL FOUR seats
 * play the deployed reasoning machinery of ai/danMCai/belief/midgame-search.mjs, written as trainer
 * shards in the fast actor's format for a later search-in-the-loop training (window 5). It is a data
 * generator and a throughput probe (A1, C1), not an evaluation and not a training run.
 *
 * One deal seed = one single round (createRound(seed): random level, no tribute), played once (all
 * four seats are symmetric, so no side swap). At every real decision of the seat to move (not a
 * finishing move, more than one candidate; midgame-search's rule) with `cards` = cards still in
 * hands:
 *   cards <= endgameHi (with --endgame=pimc)  endgameDecision of midgame-search (exact PIMC, 8 worlds)
 *   lo <= cards <= hi                         searchDecision of midgame-search (belief worlds, net-d)
 *   cards > hi                                the actor network (default champion 017) on the mover's
 *                                             masked view, choice by lib.mjs explore with softmax
 *                                             temperature --temperature (window-3 exploration 0.02;
 *                                             0 = greedy argmax)
 *   anything else (a gap between the bands)   the actor network greedy (champion by default, as
 *                                             midgame-search)
 * The decision functions are imported from midgame-search.mjs, not copied: each seat decides on its
 * own masked view (maskHidden) with worlds seeded by worldSeed(deal seed, ply). With --temperature=0
 * and the same settings a round is exactly midgame-search's playRound with --mode=search
 * --opponents=search (tested). --policy=raw switches the search off (every real decision is a raw
 * decision of the actor network, greedy at or below hi): the no-search baseline on the same deals
 * for A1's throughput comparison.
 *
 * Rows (--rows=above, default): one row per real decision with more than `hi` cards, from all four
 * seats, exactly as the trainer's fast actor (fast-actor.mjs, extrasMode 'public-belief') builds it:
 *   features  lib.mjs encodeSample(state, chosen action), int8 [567]
 *   extras    encodePolicyExtras(state, chosen index) (53) then the 162 belief marginals
 *             beliefMarginals(--belief, public view of the mover) (float32 [215])
 *   targets   lib.mjs labelMatch on the round: [signed round points of the row's team, sign of the
 *             same (the round is the whole "match"), 0, 1]: the whole-round label (the learner uses
 *             only roundPoints with targetMatchWeight 0)
 * where state = policyState + public trick + actionShapes (midgame-search rawPolicyState, identical
 * to the fast rollout's fields that encode/encodePolicyExtras read). --rows=all also writes the
 * searched (band and endgame) decisions with the search's chosen action. Differences from the fast
 * actor, stated: single rounds instead of matches; a finishing move is played without a row.
 *
 * History (--history=1, window 5 plan section 8 item 1; default 0 writes schema-1 shards byte for
 * byte as before): every row also gets two sidecars of the same shard, and the shard json says
 * schema 2, historyFeatures 1080, metaFeatures 3:
 *   bNNNNNN-000000000.h.i8  int8 [1080]: GuanZero's count-encoded history(state)
 *                           (ai/guanzero/training/history.mjs: the last 20 public plays x 54, 0-2
 *                           per card, -1 marker for a finished seat's turn), computed on the mover's
 *                           public state before the action (the same state as x and e). Only the
 *                           encoding is borrowed; no GuanZero model, data or game is used.
 *   bNNNNNN-000000000.m.u8  uint8 [3]: round index within the block (0..blockRounds-1), band code
 *                           (0 = cards > hi, actor network; 1 = lo..hi band search; 2 = cards <=
 *                           endgameHi exact PIMC), cards still in the four hands at the decision.
 * x, e and y are unchanged by --history (tested).
 *
 * Output: deal seeds start, start+1, ... in blocks of --block-rounds (default 100). Worker w of W
 * plays blocks w, w+W, ...; a block is written to blocks/.tmp-bNNNNNN/ and renamed to
 * blocks/bNNNNNN/ (one trainer shard: bNNNNNN-000000000.{x.i8,y.f32,e.f32,json}) only when all its
 * rounds are finished, then blocks/bNNNNNN.done.json records seeds, rows, file SHA-256, timings and
 * peak RSS. On STOP (any --stop-file, SIGINT/SIGTERM), --deadline/--minutes or --max-gb, a worker
 * stops before its next round and discards only the unfinished block. manifest.json (written at the
 * end, or by --summarize=1) aggregates the finished blocks and the throughput.
 *
 *   node ai/danMCai/training/continuous/search-actor.mjs --out=<dir> --start=<seed> --rounds=<n>
 *        --belief=<onnx> [--belief-train-report=<json>|none] [--champion=<onnx>] [--allow-champion=1]
 *        [--actor-model=<onnx>] [--policy=search|raw] [--rows=above|all] [--temperature=0.02]
 *        [--lo=21] [--hi=40] [--worlds=8] [--k=6] [--net=2] [--endgame=pimc|none] [--endgame-hi=20]
 *        [--endgame-worlds=belief|uniform] [--block-rounds=100] [--workers=1] [--max-gb=3]
 *        [--minutes=60] [--deadline=<ISO>] [--stop-file=<path>[,<path>]] [--resume=1]
 *        [--history=0|1]
 *   node ai/danMCai/training/continuous/search-actor.mjs --summarize=1 --out=<dir>
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceRound, createRound, seededRandom } from '../../../shared/simulation/simulation.mjs';
import { candidates } from '../../../../web/src/ai/candidates.js';
import { encodePolicyExtras } from '../../../../web/src/ai/policy-features.mjs';
import { publicView } from '../../belief/features.mjs';
import { beliefMarginals } from '../../belief/sampler.mjs';
import { history as publicHistory } from '../../../guanzero/training/history.mjs';
import {
  FOCAL_RAW_EXTRAS,
  buildProtocol,
  createConfig,
  createFocalRawScorer,
  endgameDecision,
  maskHidden,
  rawPolicyState,
  searchDecision,
  sourceClosure,
} from '../../belief/midgame-search.mjs';
import {
  FEATURES,
  ShardWriter,
  argmax,
  encodeSample,
  explore,
  extrasWidth,
  labelMatch,
  sha256,
} from './lib.mjs';

const SELF = fileURLToPath(import.meta.url);
export const EXTRAS_MODE = 'public-belief';
export const EXTRAS = extrasWidth(EXTRAS_MODE);
if (EXTRAS !== FOCAL_RAW_EXTRAS) throw Error('Extras widths of the trainer and the search differ');

/** Search-actor settings that differ from midgame-search's DEFAULTS (deployed 9001 machinery). */
export const ACTOR_DEFAULTS = Object.freeze({
  policy: 'search',
  rows: 'above',
  temperature: 0.02,
  worldsSource: 'belief',
  endgame: 'pimc',
  endgameWorlds: 'belief',
  blockRounds: 100,
  workers: 1,
  maxGB: 3,
  minutes: 60,
});
export const POLICIES = Object.freeze(['search', 'raw']);
export const ROWS = Object.freeze(['above', 'all']);
/** --history=1 sidecars (window 5): GuanZero history() width and the meta bytes per row. */
export const HISTORY_FEATURES = 1080;
export const META_FEATURES = 3;
export const BAND = Object.freeze({ above: 0, band: 1, endgame: 2 });
const remaining = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);

/** Seed of the exploration stream of one round (independent of the world seeds). */
export const explorationSeed = (seed) => (Math.imul(seed >>> 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;

export const blockName = (block) => `b${String(block).padStart(6, '0')}`;

/** Validated actor protocol; the search settings are validated by midgame-search buildProtocol. */
export function buildActorProtocol(args) {
  const policy = args.policy ?? ACTOR_DEFAULTS.policy;
  const rows = args.rows ?? ACTOR_DEFAULTS.rows;
  const temperature = Number(args.temperature ?? ACTOR_DEFAULTS.temperature);
  const blockRounds = Number(args['block-rounds'] ?? ACTOR_DEFAULTS.blockRounds);
  const maxGB = Number(args['max-gb'] ?? ACTOR_DEFAULTS.maxGB);
  if (!POLICIES.includes(policy)) throw Error('--policy=search|raw');
  if (!ROWS.includes(rows)) throw Error('--rows=above|all');
  if (policy === 'raw' && rows === 'all') throw Error('--rows=all needs --policy=search');
  if (!(temperature >= 0) || !Number.isFinite(temperature)) throw Error('--temperature');
  if (!Number.isInteger(blockRounds) || blockRounds < 1) throw Error('--block-rounds');
  if (!(maxGB > 0)) throw Error('--max-gb');
  const history = Number(args.history ?? 0);
  if (![0, 1].includes(history)) throw Error('--history=0|1');
  if (history && blockRounds > 256) throw Error('--history=1 needs --block-rounds <= 256 (uint8)');
  if (!args.belief)
    throw Error('--belief=<onnx> is required (belief worlds and the 162 marginals)');
  for (const key of ['mode', 'opponents', 'focal-raw-model', 'pairs', 'held-out'])
    if (args[key] !== undefined) throw Error(`--${key} is not a search-actor option`);
  const rounds = Number(args.rounds);
  if (!Number.isInteger(rounds) || rounds < 1) throw Error('--rounds');
  const worldsSource = args['worlds-source'] ?? ACTOR_DEFAULTS.worldsSource;
  if (worldsSource !== 'belief') throw Error('The search actor uses belief worlds');
  const endgame = args.endgame ?? ACTOR_DEFAULTS.endgame;
  const search = buildProtocol({
    ...args,
    mode: 'search',
    opponents: 'search',
    pairs: String(rounds),
    'worlds-source': worldsSource,
    endgame,
    ...(endgame === 'pimc'
      ? { 'endgame-worlds': args['endgame-worlds'] ?? ACTOR_DEFAULTS.endgameWorlds }
      : {}),
  });
  if (search.start + rounds > 2 ** 32) throw Error('Seeds must stay below 2^32');
  const actorModel = args['actor-model'] ? resolve(args['actor-model']) : search.champion;
  return {
    ...search,
    purpose:
      'search actor (window 4 B4): all four seats reason (belief-world search lo..hi, exact PIMC ' +
      '<= endgameHi) and play the actor network with exploration above hi; trainer shards with ' +
      'the 215 public-belief extras and the whole-round label; data generation, not an evaluation',
    actor: 'search-actor',
    policy,
    rows,
    rounds,
    blockRounds,
    maxGB,
    exploration:
      temperature > 0 ? { type: 'softmax', temperature } : { type: 'greedy', temperature: 0 },
    explorationSeedRule: '(imul(dealSeed, 0x9e3779b1) ^ 0x85ebca6b) >>> 0, one stream per round',
    actorModel,
    actorModelSHA256: actorModel === search.champion ? search.championSHA256 : sha256(actorModel),
    extrasMode: EXTRAS_MODE,
    extraFeatures: EXTRAS,
    label:
      'lib.mjs labelMatch on the single round: [signed round points of the row team, sign of the ' +
      'same, 0, 1]',
    rowRule:
      rows === 'above'
        ? 'one row per real decision with more than hi cards in hands, all four seats, chosen action'
        : 'one row per real decision (raw above hi, searched in the band and the endgame), chosen action',
    ...(history
      ? {
          history: 1,
          historyFeatures: HISTORY_FEATURES,
          metaFeatures: META_FEATURES,
          historyEncoding:
            'ai/guanzero/training/history.mjs history(state) on the mover public state before the ' +
            'action: last 20 public plays x 54, count-encoded (0-2 per card, -1 marker), int8; ' +
            'encoding only, no GuanZero model, data or game',
          metaLayout:
            'uint8 [round index within the block, band (0 above hi, 1 band search, 2 endgame), ' +
            'cards in the four hands]',
        }
      : {}),
  };
}

/**
 * Actor config for a worker or a test: midgame-search's createConfig (champion pool, belief model,
 * solver) plus the actor network (champion pool, or a 215-extras scorer for an extras model).
 */
export async function createActorConfig(protocol, ort, options = {}) {
  const cfg = await createConfig(protocol, ort, options);
  let actor;
  if (protocol.actorModel === protocol.champion)
    actor = { extras: false, values: (state) => cfg.values(protocol.champion, state) };
  else {
    const probe = await ort.InferenceSession.create(protocol.actorModel);
    const extras = probe.inputNames.includes('extras');
    await probe.release();
    if (extras) {
      const scorer = await createFocalRawScorer(ort, protocol.actorModel, options);
      actor = {
        extras: true,
        values: (state, marginals) => scorer.values(state, marginals),
        scorer,
      };
    } else actor = { extras: false, values: (state) => cfg.values(protocol.actorModel, state) };
  }
  return {
    ...cfg,
    actorNet: actor,
    async close() {
      await cfg.close();
      if (actor.scorer) await actor.scorer.close();
    },
  };
}

/**
 * One trainer row of a decision, as the fast actor builds it for extrasMode 'public-belief'.
 * `game` is the mover's masked game; `marginals` the 162 belief marginals of the mover's view.
 * With `withHistory` the row also carries GuanZero's history(state) of the same state (int8 [1080]).
 */
export function decisionRow(game, player, plays, index, marginals, withHistory = false) {
  const state = rawPolicyState(game, player, plays);
  const extras = new Float32Array(EXTRAS);
  extras.set(encodePolicyExtras(state, index));
  extras.set(marginals, 53);
  const row = {
    features: encodeSample(state, state.actions[index]),
    extras,
    team: player % 2,
    round: 1,
  };
  if (withHistory) row.history = publicHistory(state);
  return row;
}

/** Whole-round label through lib.mjs labelMatch (the single round is the whole "match"). */
export function labelRound(rows, result) {
  return labelMatch(rows, {
    history: [{ round: 1, team: result.winner, up: result.points }],
    winner: result.winner,
  });
}

const roundStats = () => ({
  decisions: 0,
  rawDecisions: 0,
  aboveDecisions: 0,
  explored: 0,
  rows: 0,
  bandDecisions: 0,
  searched: 0,
  differs: 0,
  endgameDecisions: 0,
  endgameSearched: 0,
  endgameFallbacks: 0,
  endgameDiffers: 0,
  rawMs: 0,
  rowBeliefMs: 0,
  searchMs: 0,
  endgameMs: 0,
  differPlies: [],
  endgameDifferPlies: [],
});

/**
 * One self-play round of deal `seed` with all four seats on the actor policy. Returns the unlabelled
 * rows, the labelled rows, the round result and counters; the played log is attached non-enumerably
 * as `log` (tests).
 */
export async function playActorRound(seed, cfg) {
  const game = createRound(seed);
  const random = seededRandom(explorationSeed(seed));
  const searchOn = cfg.policy === 'search';
  const endgameOn = searchOn && cfg.endgame === 'pimc';
  const withHistory = cfg.history === 1;
  const stats = roundStats();
  const rows = [];
  for (let ply = 0; ply < 1000; ply++) {
    if (ply !== game.log.length) throw Error('Ply must equal the public log length');
    const player = game.turn;
    const plays = candidates(game.hands[player], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
    if (index < 0 && plays.length === 1) index = 0;
    if (index < 0) {
      stats.decisions++;
      const cards = remaining(game);
      const masked = maskHidden(game, player);
      let searched = false,
        band = BAND.above;
      if (endgameOn && cards <= cfg.endgameHi) {
        const d = await endgameDecision(game, seed, cfg);
        index = d.index;
        searched = true;
        band = BAND.endgame;
        stats.endgameDecisions++;
        stats.endgameSearched++;
        stats.endgameFallbacks += Number(d.fallback);
        stats.endgameMs += d.ms;
        if (index !== d.championIndex) {
          stats.endgameDiffers++;
          stats.endgameDifferPlies.push(ply);
        }
      } else if (searchOn && cards >= cfg.lo && cards <= cfg.hi) {
        const d = await searchDecision(game, seed, cfg);
        index = d.index;
        searched = true;
        band = BAND.band;
        stats.bandDecisions++;
        stats.searched++;
        stats.searchMs += d.ms;
        if (index !== d.championIndex) {
          stats.differs++;
          stats.differPlies.push(ply);
        }
      } else {
        const t0 = performance.now();
        const state = rawPolicyState(masked, player, plays);
        const above = cards > cfg.hi;
        let marginals = null;
        if (cfg.actorNet.extras || above) {
          const tb = performance.now();
          marginals = await beliefMarginals(cfg.belief, publicView(masked, player));
          stats.rowBeliefMs += performance.now() - tb;
        }
        const values = await cfg.actorNet.values(state, marginals);
        if (values.length !== plays.length || !Array.from(values).every(Number.isFinite))
          throw Error('Invalid actor values');
        stats.rawDecisions++;
        if (above) {
          stats.aboveDecisions++;
          const choice = explore(values, cfg.exploration, random);
          index = choice.index;
          stats.explored += Number(choice.explored);
          const row = decisionRow(masked, player, plays, index, marginals, withHistory);
          if (withHistory) Object.assign(row, { ply, band, cards });
          rows.push(row);
        } else index = argmax(values);
        stats.rawMs += performance.now() - t0;
      }
      if (searched && cfg.rows === 'all') {
        const tb = performance.now();
        const marginals = await beliefMarginals(cfg.belief, publicView(masked, player));
        stats.rowBeliefMs += performance.now() - tb;
        const row = decisionRow(masked, player, plays, index, marginals, withHistory);
        if (withHistory) Object.assign(row, { ply, band, cards });
        rows.push(row);
      }
    }
    const result = advanceRound(game, plays[index]);
    if (result) {
      stats.rows = rows.length;
      const out = {
        seed,
        result: { winner: result.winner, points: result.points, order: result.order },
        plies: ply + 1,
        stats,
        rows,
        labelled: labelRound(rows, result),
      };
      Object.defineProperty(out, 'log', { value: game.log, enumerable: false });
      return out;
    }
  }
  throw Error('Round did not terminate');
}

const SUM_KEYS = [
  'decisions',
  'rawDecisions',
  'aboveDecisions',
  'explored',
  'rows',
  'bandDecisions',
  'searched',
  'differs',
  'endgameDecisions',
  'endgameSearched',
  'endgameFallbacks',
  'endgameDiffers',
  'rawMs',
  'rowBeliefMs',
  'searchMs',
  'endgameMs',
];

/** All finished blocks (their .done.json records) of a run directory, sorted by block. */
export function finishedBlocks(out) {
  const dir = join(out, 'blocks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^b\d{6}\.done\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
    .sort((a, b) => a.block - b.block);
}

/** manifest.json content: finished blocks, totals and throughput (rounds and rows per hour). */
export function manifestOf(out, run) {
  const blocks = finishedBlocks(out);
  const totals = Object.fromEntries(
    SUM_KEYS.map((key) => [key, blocks.reduce((s, b) => s + (b.totals[key] || 0), 0)]),
  );
  const rounds = blocks.reduce((s, b) => s + b.rounds, 0);
  const seconds = blocks.reduce((s, b) => s + b.seconds, 0);
  const hours = seconds / 3600;
  return {
    schema: run.history ? 2 : 1,
    actor: 'search-actor',
    out,
    policy: run.policy,
    rows: run.rows,
    extrasMode: EXTRAS_MODE,
    extraFeatures: EXTRAS,
    features: FEATURES,
    ...(run.history
      ? {
          historyFeatures: HISTORY_FEATURES,
          metaFeatures: META_FEATURES,
          rowsByBand: [0, 1, 2].map((band) =>
            blocks.reduce((s, b) => s + (b.rowsByBand?.[band] || 0), 0),
          ),
        }
      : {}),
    championSHA256: run.championSHA256,
    actorModelSHA256: run.actorModelSHA256,
    beliefSHA256: run.beliefSHA256,
    seedStart: run.start,
    blockRounds: run.blockRounds,
    finishedBlocks: blocks.length,
    finishedRounds: rounds,
    rowsTotal: blocks.reduce((s, b) => s + b.rowsWritten, 0),
    bytesTotal: blocks.reduce((s, b) => s + b.bytes, 0),
    totals,
    perRound: rounds
      ? {
          decisions: totals.decisions / rounds,
          aboveDecisions: totals.aboveDecisions / rounds,
          rows: totals.rows / rounds,
          searchedDecisions: totals.searched / rounds,
          endgameSearchedDecisions: totals.endgameSearched / rounds,
          seconds: seconds / rounds,
        }
      : null,
    throughputPerWorker: hours
      ? {
          roundsPerHour: rounds / hours,
          rowsPerHour: totals.rows / hours,
          aboveDecisionsPerHour: totals.aboveDecisions / hours,
          note: 'per worker process: block wall-clock seconds summed over workers',
        }
      : null,
    secondsPerSearchedDecision: totals.searched ? totals.searchMs / 1000 / totals.searched : null,
    secondsPerEndgameDecision: totals.endgameSearched
      ? totals.endgameMs / 1000 / totals.endgameSearched
      : null,
    peakRSSMB: Math.max(0, ...blocks.map((b) => b.peakRSSMB || 0)),
    blocks: blocks.map((b) => ({
      block: b.block,
      name: b.name,
      seeds: b.seeds,
      rounds: b.rounds,
      rows: b.rowsWritten,
      files: b.files,
    })),
    writtenAt: new Date().toISOString(),
  };
}

function directoryBytes(out) {
  return finishedBlocks(out).reduce((s, b) => s + b.bytes, 0);
}

/**
 * Plays and writes one block; returns null (and leaves nothing) if stopped before it finished.
 * `onRound` (tests) receives each played round, in block order.
 */
export async function runBlock(out, run, cfg, block, shouldStop, onRound = null) {
  const name = blockName(block);
  const dir = join(out, 'blocks');
  const tmp = join(dir, `.tmp-${name}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const writer = new ShardWriter(tmp, name, 0, EXTRAS);
  const first = run.start + block * run.blockRounds;
  const last = Math.min(first + run.blockRounds, run.start + run.rounds) - 1;
  const totals = Object.fromEntries(SUM_KEYS.map((key) => [key, 0]));
  const results = [];
  const withHistory = run.history === 1;
  const history = [],
    meta = [];
  const t0 = Date.now();
  for (let seed = first; seed <= last; seed++) {
    if (shouldStop()) {
      rmSync(tmp, { recursive: true, force: true });
      return null;
    }
    const round = await playActorRound(seed, cfg);
    onRound?.(round);
    writer.add(round.labelled, run.actorModelSHA256.slice(0, 16));
    if (withHistory)
      for (const row of round.rows) {
        if (row.history?.length !== HISTORY_FEATURES) throw Error('Missing history row');
        history.push(row.history);
        meta.push([seed - first, row.band, row.cards]);
      }
    for (const key of SUM_KEYS) totals[key] += round.stats[key];
    results.push({
      seed,
      winner: round.result.winner,
      points: round.result.points,
      plies: round.plies,
      rows: round.stats.rows,
    });
  }
  const shard = writer.flush({
    actor: 'search-actor',
    actorImplementation: 'search',
    policy: run.policy,
    rowRule: run.rows,
    extrasMode: EXTRAS_MODE,
    beliefSHA256: run.beliefSHA256,
    championSHA256: run.championSHA256,
    actorModelSHA256: run.actorModelSHA256,
    seeds: [first, last],
    ...(withHistory
      ? {
          schema: 2,
          historyFeatures: HISTORY_FEATURES,
          metaFeatures: META_FEATURES,
          historyEncoding: run.historyEncoding,
          metaLayout: run.metaLayout,
        }
      : {}),
  });
  if (withHistory && shard) {
    if (history.length !== totals.rows) throw Error('History rows differ from shard rows');
    const h = new Int8Array(history.length * HISTORY_FEATURES);
    history.forEach((row, i) => h.set(row, i * HISTORY_FEATURES));
    const m = new Uint8Array(meta.length * META_FEATURES);
    meta.forEach((row, i) => {
      if (!row.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) throw Error('Meta range');
      m.set(row, i * META_FEATURES);
    });
    writeFileSync(join(tmp, `${shard}.h.i8`), h);
    writeFileSync(join(tmp, `${shard}.m.u8`), m);
  }
  const final = join(dir, name);
  rmSync(final, { recursive: true, force: true });
  renameSync(tmp, final);
  const files = {};
  let bytes = 0;
  for (const file of readdirSync(final).sort()) {
    files[file] = sha256(join(final, file));
    bytes += statSync(join(final, file)).size;
  }
  const record = {
    block,
    name,
    shard,
    seeds: [first, last],
    rounds: results.length,
    rowsWritten: totals.rows,
    ...(withHistory
      ? {
          schema: 2,
          rowsByBand: [0, 1, 2].map((band) => meta.filter((row) => row[1] === band).length),
        }
      : {}),
    bytes,
    files,
    totals,
    seconds: (Date.now() - t0) / 1000,
    // process.resourceUsage().maxRSS is in kilobytes.
    peakRSSMB: Math.round(process.resourceUsage().maxRSS / 1024),
    results,
    pid: process.pid,
    finishedAt: new Date().toISOString(),
  };
  const done = join(dir, `${name}.done.json`);
  writeFileSync(`${done}.tmp`, JSON.stringify(record, null, 2));
  renameSync(`${done}.tmp`, done);
  return record;
}

async function worker(args) {
  const ort = await import('onnxruntime-node');
  const out = resolve(args.out);
  const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  const part = Number(args.part),
    parts = Number(args.parts ?? run.workers);
  let stopping = false;
  process.on('SIGINT', () => (stopping = true));
  process.on('SIGTERM', () => (stopping = true));
  const shouldStop = () =>
    stopping || Date.now() >= run.deadline || (run.stopFiles ?? []).some((f) => existsSync(f));
  const cfg = await createActorConfig(run, ort);
  const blocks = Math.ceil(run.rounds / run.blockRounds);
  const progress = join(out, `worker-${part}.json`);
  const started = Date.now();
  let done = 0,
    reason = 'all blocks finished';
  for (let block = part; block < blocks; block += parts) {
    if (existsSync(join(out, 'blocks', `${blockName(block)}.done.json`))) continue;
    if (shouldStop()) {
      reason = stopping ? 'signal' : Date.now() >= run.deadline ? 'deadline' : 'stop file';
      break;
    }
    if (directoryBytes(out) >= run.maxGB * 2 ** 30) {
      reason = 'disk cap (--max-gb)';
      break;
    }
    writeFileSync(
      progress,
      JSON.stringify({ part, block, blocksDone: done, startedAt: new Date(started).toISOString() }),
    );
    const record = await runBlock(out, run, cfg, block, shouldStop);
    if (!record) {
      reason = 'stopped inside a block (unfinished block discarded)';
      break;
    }
    done++;
    process.stderr.write(
      `[search-actor w${part}] ${record.name} seeds ${record.seeds.join('-')} ` +
        `${record.rowsWritten} rows ${record.seconds.toFixed(0)} s rss ${record.peakRSSMB} MB\n`,
    );
  }
  writeFileSync(
    join(out, `worker-${part}.done.json`),
    JSON.stringify({ part, blocks: done, reason, seconds: (Date.now() - started) / 1000 }),
  );
  await cfg.close();
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

async function main(args) {
  if (!args.out) throw Error('--out=<dir>');
  const out = resolve(args.out);
  if (args.summarize) {
    const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
    const manifest = manifestOf(out, run);
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const { blocks: _, ...printed } = manifest;
    console.log(JSON.stringify(printed, null, 2));
    return;
  }
  const minutes = Number(args.minutes ?? ACTOR_DEFAULTS.minutes);
  if (!(minutes > 0)) throw Error('--minutes');
  let deadline = Date.now() + minutes * 60_000;
  if (args.deadline !== undefined) {
    const hard = Date.parse(args.deadline);
    if (!Number.isFinite(hard)) throw Error('--deadline=<ISO time>');
    deadline = Math.min(deadline, hard);
  }
  const stopFiles = args['stop-file'] ? args['stop-file'].split(',').map((f) => resolve(f)) : [];
  const workers = Number(args.workers ?? ACTOR_DEFAULTS.workers);
  if (!Number.isInteger(workers) || workers < 1) throw Error('--workers');
  let run;
  if (existsSync(join(out, 'run.json'))) {
    if (args.resume !== '1')
      throw Error(`${out} already holds a run; use --resume=1 or a new --out`);
    // Resume: settings from run.json (unchanged); only the deadline, stop files and workers are new.
    run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
    for (const [key, sha] of [
      ['champion', run.championSHA256],
      ['belief', run.beliefSHA256],
      ['actorModel', run.actorModelSHA256],
    ])
      if (sha256(run[key]) !== sha) throw Error(`${key} changed since the run was started`);
    run.resumes = [
      ...(run.resumes ?? []),
      { at: new Date().toISOString(), previousDeadline: run.deadline, workers },
    ];
  } else {
    if (args.resume === '1') throw Error(`--resume=1 but ${out} holds no run`);
    run = { ...buildActorProtocol(args), sources: sourceClosure(SELF), node: process.version };
    run.startedAt = new Date().toISOString();
  }
  Object.assign(run, {
    out,
    workers,
    minutes,
    deadline,
    deadlineISO: new Date(deadline).toISOString(),
    stopFiles,
  });
  mkdirSync(join(out, 'blocks'), { recursive: true });
  writeFileSync(join(out, 'run.json'), JSON.stringify(run, null, 2));
  const t0 = Date.now();
  const failures = [];
  const children = [];
  const forward = (signal) => children.forEach((child) => child.kill(signal));
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
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
              ...process.execArgv.filter((a) => a.startsWith('--max-old-space-size')),
              SELF,
              '--worker',
              `--part=${part}`,
              `--parts=${workers}`,
              `--out=${out}`,
            ],
            { stdio: 'inherit' },
          );
          children.push(child);
          child.on('exit', (code, signal) => {
            if (code !== 0) failures.push({ part, code, signal });
            done();
          });
        }),
    ),
  );
  const manifest = {
    ...manifestOf(out, run),
    wallClockMinutes: (Date.now() - t0) / 60_000,
    workerFailures: failures,
    workerReasons: Array.from({ length: workers }, (_, part) => {
      const file = join(out, `worker-${part}.done.json`);
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    }),
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const { blocks: _, ...printed } = manifest;
  console.log(JSON.stringify(printed, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const args = parseArgs(process.argv.slice(2));
  (args.worker ? worker(args) : main(args)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
