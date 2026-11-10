/**
 * Development check (NOT acceptance, not a win rate, not a strength claim): does champion 017's
 * early bomb while following an opponent's trick stop looking good once the rest of the round is
 * played more accurately?
 *
 * Positions. Single rounds (createRound(seed): no tribute, the level convention of
 * midgame-search.mjs) with all four seats raw champion 017 greedy (finishing move first, single
 * candidate automatic, else Q arg-max). In each deal the FIRST decision with
 *   - more than 60 cards on the table (sum of the four hands),
 *   - the acting seat following a trick held by an OPPONENT,
 *   - no candidate that empties the hand,
 *   - the champion's arg-max candidate a bomb (isBomb: 4+ of a kind, straight flush, four jokers),
 *   - at least one legal non-bomb candidate (pass counts)
 * is a position; at most one per deal.
 *
 * Arms. A = the champion's bomb (its top move); B = the champion's highest-Q non-bomb candidate
 * (first index on ties). After the forced move every seat continues to the end of the round with
 *   P1: raw champion 017 greedy (reference);
 *   P2: the deployed reasoning bot (web id 9001) for every seat, createReasonBot of
 *       reason-match-eval.mjs with the desktop budget (017 via decideTablePolicy above 40 table
 *       cards, belief rollout search at 21-40, exact belief solver at <= 20). Its per-round search
 *       seed is seatSeed(deal seed, seat), so a world seed is worldSeed(seatSeed, ply): a function
 *       of (deal seed, decision index, seat) only, identical in arms A and B wherever the histories
 *       coincide (common random numbers).
 * Outcome = signed round points of the acting seat's team (+1/+2/+3 win, negative loss).
 *
 *   node ai/danMCai/belief/opening-counterfactual.mjs --out=<dir> [--target=800] [--workers=4]
 *        [--start=4300000000] [--deadline=<ISO>] [--nice=10]
 *   node ai/danMCai/belief/opening-counterfactual.mjs --summarize --out=<dir>
 * Resume-safe (rows.jsonl + scanned.jsonl of deals without a position); <out>/STOP or the deadline
 * stops dispatch and aborts unfinished deals; progress.json is rewritten at least every 20 s.
 */
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceRound, createRound, seededRandom } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { isBomb } from '../../../web/src/core/combinations.js';
import { cardText } from '../../../web/src/core/cards.js';
import { championValues } from '../../../web/src/ai/search/inference.mjs';
import { SEARCH_BUDGETS } from '../../../web/src/ai/search/constants.mjs';
import {
  DEFAULT_BELIEF,
  DEFAULT_CHAMPION,
  closeTally,
  createReasonBot,
  emptyTally,
} from './reason-match-eval.mjs';

const SELF = fileURLToPath(import.meta.url);
export const PROTOCOL = 'opening-bomb-counterfactual-v1';
export const START_SEED = 4_300_000_000;
export const MIN_TABLE = 61;
export const CHAMPION_SHA256 = '462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7';
export const BELIEF_SHA256_PREFIX = '16d76783';

export const tableCards = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);

/** Independent copy of a round state (advanceRound mutates hands, log, out, trick, passes). */
export function cloneGame(game) {
  return {
    ...game,
    hands: game.hands.map((hand) => hand.slice()),
    levels: game.levels.slice(),
    log: game.log.slice(),
    out: game.out.slice(),
    trick: game.trick ? { player: game.trick.player, play: game.trick.play } : null,
  };
}

/** First arg-max (ties to the lowest index), optionally restricted to `allowed` indices. */
export function argmaxOf(values, allowed = null) {
  let best = -1;
  for (let i = 0; i < values.length; i++) {
    if (allowed && !allowed(i)) continue;
    if (best < 0 || values[i] > values[best]) best = i;
  }
  return best;
}

const finishes = (plays, hand) => plays.some((play) => play && play.cards.length === hand.length);

/** Checks that need no network value; returns the exclusion reason or null. */
export function preFilter(game, plays) {
  const p = game.turn;
  if (tableCards(game) < MIN_TABLE) return 'table-cards';
  if (!game.trick) return 'lead';
  if (game.trick.player % 2 === p % 2) return 'partner-trick';
  if (finishes(plays, game.hands[p])) return 'can-finish';
  return null;
}

/** Full position filter; returns {ok, reason, bombIndex, altIndex}. */
export function positionFilter(game, plays, base) {
  const reason = preFilter(game, plays);
  if (reason) return { ok: false, reason };
  const top = argmaxOf(base);
  if (!plays[top] || !isBomb(plays[top])) return { ok: false, reason: 'top-not-bomb' };
  const alt = argmaxOf(base, (i) => !plays[i] || !isBomb(plays[i]));
  if (alt < 0) return { ok: false, reason: 'no-non-bomb' };
  return { ok: true, reason: null, bombIndex: top, altIndex: alt };
}

/** Signed round points from `seat`'s team view. */
export const teamOutcome = (result, seat) =>
  result.winner === seat % 2 ? result.points : -result.points;

/** Literal last log entry and the partner's last action are both passes. */
export function blindFollow(game, seat) {
  const last = game.log.at(-1);
  const partner = game.log.findLast((e) => e.p === (seat + 2) % 4);
  return !!last && !last.cards && !!partner && !partner.cards;
}

/** Per-round search seed of a seat in P2 (never reads a card; arm-independent). */
export const seatSeed = (dealSeed, seat) =>
  Math.imul(((dealSeed >>> 0) ^ Math.imul(seat + 1, 0x9e3779b1)) >>> 0, 0x297a2d39) >>> 0;

const text = (cards) => cards.map((c) => cardText(c)).join(' ');
const describe = (play) =>
  play
    ? {
        type: play.type,
        value: play.value,
        n: play.n,
        cards: text(play.cards),
        ids: play.cards.map((c) => c.id),
      }
    : 'pass';
const logEntry = (e) => ({
  p: e.p,
  play: e.cards ? `${e.type}:${e.value} ${text(e.cards)}` : 'pass',
});

/** Raw champion greedy choice (finishing move first, single candidate automatic). */
export async function greedyIndex(game, plays, values) {
  const p = game.turn;
  const finish = plays.findIndex((play) => play && play.cards.length === game.hands[p].length);
  if (finish >= 0) return finish;
  if (plays.length === 1) return 0;
  return argmaxOf(await values(policyState(game, p, 0, plays)));
}

/** Plays a deal greedily and returns the first qualifying position, or null. */
export async function findPosition(seed, values) {
  const game = createRound(seed);
  for (let ply = 0; ply < 1000; ply++) {
    if (tableCards(game) < MIN_TABLE) return null;
    const p = game.turn;
    const plays = candidates(game.hands[p], game.L, game.trick?.play);
    let index;
    if (!preFilter(game, plays) && plays.length > 1) {
      const base = await values(policyState(game, p, 0, plays));
      const f = positionFilter(game, plays, base);
      if (f.ok) return { seed, ply, game, plays, base, ...f };
      index = argmaxOf(base);
    } else index = await greedyIndex(game, plays, values);
    if (advanceRound(game, plays[index])) return null;
  }
  throw Error('Round did not terminate');
}

/**
 * Plays one arm: forced move `index` at the position, then `decide(game, p)` for every seat to the
 * end. Returns {outcome, order, decisions, prefixLog}.
 */
export async function playArm(position, index, decide) {
  const game = cloneGame(position.game);
  const seat = game.turn;
  const prefixLog = game.log.length;
  let result = advanceRound(game, position.plays[index]);
  let decisions = 0;
  for (let ply = 0; !result && ply < 1000; ply++) {
    const p = game.turn;
    result = advanceRound(game, await decide(game, p));
    decisions++;
  }
  if (!result) throw Error('Arm did not terminate');
  return {
    outcome: teamOutcome(result, seat),
    order: result.order.slice(),
    decisions,
    prefixLog,
    game,
  };
}

/** All four finished rounds of a position. `bot` null skips P2 (tests). */
export async function evaluatePosition(position, { values, bot }) {
  const t0 = performance.now();
  const p1 = async (game) => {
    const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
    return plays[await greedyIndex(game, plays, values)];
  };
  const arms = {};
  const fallbacks = {};
  const times = {};
  for (const [name, index] of [
    ['A', position.bombIndex],
    ['B', position.altIndex],
  ]) {
    let t = performance.now();
    arms[`${name}_P1`] = await playArm(position, index, p1);
    times[`${name}_P1`] = Math.round(performance.now() - t);
    if (!bot) continue;
    const tally = emptyTally();
    t = performance.now();
    arms[`${name}_P2`] = await playArm(position, index, (game, p) =>
      bot.decide(game, p, { searchSeed: seatSeed(position.seed, p) }, tally),
    );
    times[`${name}_P2`] = Math.round(performance.now() - t);
    const closed = closeTally(tally);
    fallbacks[`${name}_P2`] = {
      decisions: closed.decisions,
      champion017: closed.champion,
      midgame: {
        requests: closed.midgame.requests,
        completed: closed.midgame.completed,
        deviated: closed.midgame.deviated,
        minWorlds: closed.midgame.minWorlds,
        fallbacks: closed.midgame.fallbacks,
      },
      endgame: {
        requests: closed.endgame.requests,
        completed: closed.endgame.completed,
        deviated: closed.endgame.deviated,
        minWorlds: closed.endgame.minWorlds,
        fallbacks: closed.endgame.fallbacks,
      },
    };
  }
  return { arms, fallbacks, times, ms: Math.round(performance.now() - t0) };
}

/** The JSON row of a finished position. */
export function positionRow(position, evaluation) {
  const { game, plays, base, bombIndex, altIndex, seed } = position;
  const p = game.turn;
  const cards = tableCards(game);
  const trick = game.trick.play;
  const outcomes = {},
    orders = {};
  for (const [k, v] of Object.entries(evaluation.arms)) {
    outcomes[k] = v.outcome;
    orders[k] = v.order;
  }
  return {
    protocol: PROTOCOL,
    seed,
    level: game.L,
    seat: p,
    ply: game.log.length,
    tableCards: cards,
    band: cards > 80 ? '>80' : '61-80',
    ownCards: text(game.hands[p]),
    ownCount: game.hands[p].length,
    trick: {
      type: trick.type,
      value: trick.value,
      n: trick.n,
      cards: text(trick.cards),
      holder: game.trick.player,
    },
    trickClass: trick.type === 'single' ? 'single' : trick.type === 'pair' ? 'pair' : 'other',
    blindFollow: blindFollow(game, p),
    recentLog: game.log.slice(-6).map(logEntry),
    candidates: plays.length,
    bomb: { ...describe(plays[bombIndex]), size: plays[bombIndex].cards.length },
    moveB: describe(plays[altIndex]),
    moveBIsPass: plays[altIndex] === null,
    qA: base[bombIndex],
    qB: base[altIndex],
    outcomes,
    d: {
      P1: outcomes.B_P1 - outcomes.A_P1,
      ...(outcomes.B_P2 !== undefined ? { P2: outcomes.B_P2 - outcomes.A_P2 } : {}),
    },
    orders,
    fallbacks: evaluation.fallbacks,
    armMs: evaluation.times,
    wallMs: evaluation.ms,
  };
}

/* ----------------------------- summary ----------------------------- */

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Percentile bootstrap of the mean over positions (seeded, `iterations` resamples). */
export function bootstrapMean(xs, iterations = 10_000, seed = 4_300_099_999) {
  if (xs.length < 2) return null;
  const random = seededRandom(seed);
  const draws = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(random() * xs.length)];
    draws[i] = s / xs.length;
  }
  draws.sort();
  return [draws[Math.floor(0.025 * iterations)], draws[Math.floor(0.975 * iterations) - 1]];
}

export function describeD(xs, iterations) {
  const n = xs.length;
  return {
    n,
    mean: mean(xs),
    ci95: bootstrapMean(xs, iterations),
    sharePositive: n ? xs.filter((x) => x > 0).length / n : null,
    shareZero: n ? xs.filter((x) => x === 0).length / n : null,
    shareNegative: n ? xs.filter((x) => x < 0).length / n : null,
  };
}

/** Pre-fixed reading rule. */
export function readingRule(p2, paired) {
  if (!p2.ci95 || !paired?.ci95)
    return { verdict: 'iii', text: 'inconclusive (too few positions)' };
  const half = (p2.ci95[1] - p2.ci95[0]) / 2;
  if (p2.mean > 0 && p2.ci95[0] > 0)
    return { verdict: 'i', text: 'accurate late play already makes not bombing better' };
  if (p2.mean < 0 && p2.ci95[1] < 0 && paired.ci95[0] <= 0 && paired.ci95[1] >= 0)
    return {
      verdict: 'ii',
      text: 'opponents in simulation do not punish the early bomb even with accurate late play',
    };
  return {
    verdict: 'iii',
    text: `inconclusive at this size; P2 interval half-width ${half.toFixed(3)}`,
  };
}

export function summarize(rows, iterations = 10_000) {
  const full = rows.filter((r) => r.d.P2 !== undefined);
  const split = (key, list, policy) => {
    const groups = {};
    for (const r of list) (groups[r[key]] ||= []).push(r.d[policy]);
    return Object.fromEntries(
      Object.entries(groups).map(([k, xs]) => [k, describeD(xs, iterations)]),
    );
  };
  const out = { positions: full.length, rowsTotal: rows.length };
  for (const policy of ['P1', 'P2']) {
    out[policy] = {
      d: describeD(
        full.map((r) => r.d[policy]),
        iterations,
      ),
      meanOutcomeA: mean(full.map((r) => r.outcomes[`A_${policy}`])),
      meanOutcomeB: mean(full.map((r) => r.outcomes[`B_${policy}`])),
      byBand: split('band', full, policy),
      byBlindFollow: split('blindFollow', full, policy),
      byTrickClass: split('trickClass', full, policy),
    };
  }
  out.pairedP2minusP1 = describeD(
    full.map((r) => r.d.P2 - r.d.P1),
    iterations,
  );
  out.moveBPassShare = full.length ? full.filter((r) => r.moveBIsPass).length / full.length : null;
  out.blindFollowShare = full.length
    ? full.filter((r) => r.blindFollow).length / full.length
    : null;
  const fb = {
    midgameRequests: 0,
    midgameFallbacks: 0,
    endgameRequests: 0,
    endgameFallbacks: 0,
    reasons: {},
  };
  for (const r of full)
    for (const arm of Object.values(r.fallbacks || {}))
      for (const band of ['midgame', 'endgame']) {
        fb[`${band}Requests`] += arm[band].requests;
        for (const [reason, n] of Object.entries(arm[band].fallbacks)) {
          fb[`${band}Fallbacks`] += n;
          fb.reasons[`${band}:${reason}`] = (fb.reasons[`${band}:${reason}`] || 0) + n;
        }
      }
  out.p2SearchFallbacks = fb;
  out.meanWallSecondsPerPosition = mean(full.map((r) => r.wallMs / 1000));
  out.reading = readingRule(out.P2.d, out.pairedP2minusP1);
  out.note =
    'development check on new seeds; not an acceptance result, a win rate or a strength claim';
  return out;
}

const f3 = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(3));
const ci = (c) => (c ? `[${f3(c[0])}, ${f3(c[1])}]` : 'n/a');
const pct = (x) => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const dLine = (label, s) =>
  `| ${label} | ${s.n} | ${f3(s.mean)} | ${ci(s.ci95)} | ${pct(s.sharePositive)} | ${pct(s.shareZero)} | ${pct(s.shareNegative)} |`;

export function reportMarkdown(summary, meta) {
  const head =
    '| Group | n | mean d | 95% bootstrap | d > 0 | d = 0 | d < 0 |\n|---|---|---|---|---|---|---|';
  const lines = [
    '# Opening bomb counterfactual (development check)',
    '',
    `Not an acceptance result, a win rate or a strength claim. Protocol ${PROTOCOL}; champion 017 (SHA-256 ${CHAMPION_SHA256}); belief ${meta.beliefSHA256}. Deal seeds from ${meta.start}; ${summary.positions} positions completed (target ${meta.target}; status ${meta.status}).`,
    '',
    'd = acting team round points with move B (highest-Q non-bomb) minus with move A (champion bomb). P1 = all seats raw 017 greedy after the forced move; P2 = all seats the deployed reasoning bot (9001). 95% percentile bootstrap over positions, 10,000 resamples.',
    '',
    `**Reading (rule fixed before results): (${summary.reading.verdict}) ${summary.reading.text}.**`,
    '',
    head,
    dLine('P1 all', summary.P1.d),
    dLine('P2 all', summary.P2.d),
    dLine('d_P2 - d_P1', summary.pairedP2minusP1),
  ];
  for (const policy of ['P1', 'P2']) {
    const s = summary[policy];
    lines.push(
      '',
      `## ${policy}`,
      '',
      `Mean outcome arm A (bomb) ${f3(s.meanOutcomeA)}, arm B (no bomb) ${f3(s.meanOutcomeB)}.`,
      '',
      head,
    );
    for (const [k, v] of Object.entries(s.byBand)) lines.push(dLine(`table cards ${k}`, v));
    for (const [k, v] of Object.entries(s.byBlindFollow))
      lines.push(dLine(k === 'true' ? 'blind follow' : 'visible trick', v));
    for (const [k, v] of Object.entries(s.byTrickClass)) lines.push(dLine(`trick ${k}`, v));
  }
  const fb = summary.p2SearchFallbacks;
  lines.push(
    '',
    '## Other',
    '',
    `- Move B is a pass in ${pct(summary.moveBPassShare)} of positions; blind follows ${pct(summary.blindFollowShare)}.`,
    `- P2 search fallbacks to 017: midgame ${fb.midgameFallbacks} of ${fb.midgameRequests} requests, endgame ${fb.endgameFallbacks} of ${fb.endgameRequests} (${JSON.stringify(fb.reasons)}).`,
    `- Mean wall time per position (4 rounds): ${f3(summary.meanWallSecondsPerPosition)} s.`,
    '',
  );
  return lines.join('\n');
}

/* ----------------------------- processes ----------------------------- */

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

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

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const rows = [];
  for (const [i, line] of lines.entries()) {
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      if (i !== lines.length - 1) throw error;
    }
  }
  return rows;
}

async function worker() {
  let values = null,
    bot = null;
  process.on('message', async (msg) => {
    try {
      if (msg.type === 'init') {
        const ort = await import('onnxruntime-node');
        const open = (file) =>
          ort.InferenceSession.create(file, {
            intraOpNumThreads: 1,
            interOpNumThreads: 1,
            graphOptimizationLevel: 'all',
          });
        const championSession = await open(msg.champion);
        values = championValues(ort, championSession);
        bot = createReasonBot({
          ort,
          championSession,
          beliefSession: await open(msg.belief),
          budget: SEARCH_BUDGETS.desktop,
        });
        process.send({ type: 'ready' });
        return;
      }
      if (msg.type === 'deal') {
        const position = await findPosition(msg.seed, values);
        if (!position) return process.send({ type: 'deal', seed: msg.seed, row: null });
        const evaluation = await evaluatePosition(position, { values, bot });
        process.send({ type: 'deal', seed: msg.seed, row: positionRow(position, evaluation) });
      }
    } catch (error) {
      process.send({ type: 'error', seed: msg.seed, message: String(error?.stack || error) });
    }
  });
}

async function main(args) {
  const out = resolve(args.out || '');
  if (!args.out) throw Error('--out is required');
  const rowsFile = join(out, 'rows.jsonl'),
    scannedFile = join(out, 'scanned.jsonl');
  const meta = {
    protocol: PROTOCOL,
    start: Number(args.start ?? START_SEED),
    target: Number(args.target ?? 800),
    champion: resolve(args.champion || DEFAULT_CHAMPION),
    belief: resolve(args.belief || DEFAULT_BELIEF),
  };
  if (args.summarize) {
    const saved = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'));
    return writeReport(out, readJsonl(rowsFile), { ...saved, status: args.status || 'summarized' });
  }
  meta.championSHA256 = sha256File(meta.champion);
  meta.beliefSHA256 = sha256File(meta.belief);
  if (meta.championSHA256 !== CHAMPION_SHA256) throw Error('Champion is not 017');
  if (!meta.beliefSHA256.startsWith(BELIEF_SHA256_PREFIX)) throw Error('Belief is not v1 16d76783');
  mkdirSync(out, { recursive: true });
  const metaFile = join(out, 'meta.json');
  if (existsSync(metaFile)) {
    const saved = JSON.parse(readFileSync(metaFile, 'utf8'));
    for (const k of ['protocol', 'start', 'championSHA256', 'beliefSHA256'])
      if (saved[k] !== meta[k]) throw Error(`Output holds a different ${k}`);
  } else
    writeFileSync(
      metaFile,
      JSON.stringify({ ...meta, createdAt: new Date().toISOString() }, null, 2) + '\n',
    );
  const nice = Number(args.nice ?? 10);
  try {
    setPriority(nice);
  } catch {
    /* best effort */
  }
  const rows = readJsonl(rowsFile);
  const done = new Set([...rows.map((r) => r.seed), ...readJsonl(scannedFile).map((r) => r.seed)]);
  const workers = Number(args.workers ?? 4);
  const deadline = args.deadline ? Date.parse(args.deadline) : Infinity;
  let status = 'running',
    failure = null,
    nextSeed = meta.start,
    scanned = done.size;
  const stopNow = () => existsSync(join(out, 'STOP')) || Date.now() >= deadline;
  const progress = () =>
    writeFileSync(
      join(out, 'progress.json'),
      JSON.stringify(
        {
          status,
          positions: rows.length,
          target: meta.target,
          dealsScanned: scanned,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    );
  progress();
  const children = [];
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
      progress();
    }, 2000);
    const next = (child) => {
      if (status !== 'running' || stopNow() || rows.length >= meta.target) {
        child.stopping = true;
        child.kill('SIGTERM');
        return;
      }
      while (done.has(nextSeed)) nextSeed++;
      if (nextSeed >= meta.start + 100_000) throw Error('Seed block exhausted');
      child.current = nextSeed;
      child.send({ type: 'deal', seed: nextSeed++ });
    };
    for (let w = 0; w < workers; w++) {
      const child = fork(SELF, ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      try {
        setPriority(child.pid, nice);
      } catch {
        /* inherited */
      }
      children.push(child);
      live++;
      child.on('message', (msg) => {
        if (msg.type === 'ready') return next(child);
        if (msg.type === 'error') {
          failure = msg.message;
          return stopAll('error');
        }
        if (msg.type !== 'deal' || status !== 'running') return;
        scanned++;
        if (msg.row) {
          appendFileSync(rowsFile, JSON.stringify(msg.row) + '\n');
          rows.push(msg.row);
          progress();
        } else appendFileSync(scannedFile, JSON.stringify({ seed: msg.seed }) + '\n');
        next(child);
      });
      child.on('exit', (code, signal) => {
        if (status === 'running' && (code || (signal && !child.stopping))) {
          failure = `worker exited (${code ?? signal}) during deal ${child.current}`;
          stopAll('error');
        }
        if (--live === 0) {
          clearInterval(timer);
          finish();
        }
      });
      child.send({ type: 'init', champion: meta.champion, belief: meta.belief });
    }
  });
  if (status === 'running') status = rows.length >= meta.target ? 'complete' : 'incomplete';
  progress();
  writeReport(out, rows, { ...meta, status, error: failure });
  if (failure) {
    console.error(failure);
    process.exitCode = 1;
  }
}

function writeReport(out, rows, meta) {
  const summary = summarize(rows);
  writeFileSync(
    join(out, 'report.json'),
    JSON.stringify({ ...meta, finishedAt: new Date().toISOString(), summary }, null, 2) + '\n',
  );
  writeFileSync(join(out, 'REPORT.md'), reportMarkdown(summary, meta));
  console.log(
    JSON.stringify({ status: meta.status, positions: summary.positions, reading: summary.reading }),
  );
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
