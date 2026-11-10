/**
 * Development diagnostic (window 3, stage S1; reported, never a gate): HAND-OVER HEADROOM.
 *
 * How many signed round points per deal pair does the deployed 9001 machinery lose above the
 * 40-card hand-over, against raw 017 seats, compared with play that knows the TRUE deal; and how
 * much is still lost at or below 40 cards. The true-deal player is an oracle (it reads hidden
 * cards): it is a bound, never a legitimate player, and nothing here is training data.
 *
 * Each deal (createRound(seed), single round, no tribute) is played twice with sides swapped, as in
 * midgame-search.mjs playPair. The other team always plays champion 017 greedily. The focal team
 * plays, at its real decisions (not a finishing move, more than one candidate):
 *
 *   arm  cards > hi (41-108)    lo..hi (21-40)                    <= endgameHi (<= 20)
 *   A    champion greedy        midgame-search searchDecision     midgame-search endgameDecision
 *   B    ORACLE                 searchDecision                    endgameDecision
 *   C    ORACLE                 ORACLE                            ORACLE
 *
 * A is the deployed 9001 configuration (belief worlds, 8 worlds, top-6 + pass, net 2, 8-world
 * belief PIMC endgame at <= 20) and plays exactly midgame-search.mjs playRound (asserted in the
 * test). ORACLE is the MODEL_STUDY section 69 / rollout2.mjs --truth=1 rule: candidates = champion
 * top-k by Q plus pass, ONE rollout per candidate on the TRUE deal with all four seats champion
 * greedy to the end of the round, argmax of the signed round points for the mover's team, ties
 * within 1e-9 broken by the champion's Q (net 0).
 *
 * Every pair row also records, per round, the champion's max Q at the focal team's first real
 * decision with <= hi cards (handoverQ, handoverCards), for the hand-over correlation.
 *
 * Output: <out>/run.json (protocol), <out>/<arm>/run.json + part-<n>.jsonl rows in the
 * midgame-search format ({seed, a, b, mean, ms}), and at the end <out>/<arm>/summary.json and
 * <out>/compare-<X>-<Y>.json (Y minus X on the common contiguous prefix). Workers take seeds
 * start+part, start+part+parts, ...; for every seed the arms run in the order given (default A,B,C).
 * Stops before the next arm when the deadline passes or any --stop-file exists.
 *
 *   node ai/danMCai/belief/handover-oracle.mjs --start=<seed> --pairs=<n> --out=<dir>
 *        --belief=<onnx> [--workers=3] [--deadline=<ISO>|--minutes=<m>] [--arms=A,B,C]
 *        [--stop-file=<path>[,<path>]] [--champion=<onnx>]
 *   node ai/danMCai/belief/handover-oracle.mjs --summarize=1 --out=<dir>
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceRound, createRound } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { makeDeck } from '../../../web/src/core/cards.js';
import { argmax } from '../training/continuous/lib.mjs';
import {
  buildProtocol,
  collect,
  compareRows,
  createConfig,
  endgameDecision,
  netChoice,
  searchDecision,
  searchRootsOf,
  sourceClosure,
  summarize,
} from './midgame-search.mjs';

const SELF = fileURLToPath(import.meta.url);
const deck = makeDeck();
export const ARMS = Object.freeze({
  A: { above: 'champion', mid: 'search', end: 'search' },
  B: { above: 'oracle', mid: 'search', end: 'search' },
  C: { above: 'oracle', mid: 'oracle', end: 'oracle' },
});
const remaining = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);

/** Greedy champion move (finishing move first, single candidate automatic). */
async function greedy(game, cfg) {
  const player = game.turn;
  const plays = candidates(game.hands[player], game.L, game.trick?.play);
  let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
  if (index < 0 && plays.length === 1) index = 0;
  if (index < 0)
    index = argmax(await cfg.values(cfg.champion, policyState(game, player, 0, plays)));
  return plays[index];
}

/** Copy of the TRUE game (fresh card objects by id), with the public fields copied. */
export function trueCopy(game) {
  return {
    hands: game.hands.map((hand) => hand.map((card) => deck[card.id])),
    L: game.L,
    levels: game.levels.slice(),
    log: game.log.slice(),
    trick: game.trick ? { player: game.trick.player, play: game.trick.play } : null,
    passes: game.passes,
    out: game.out.slice(),
    turn: game.turn,
  };
}

/** Mover-team signed round points after `play` on the true deal, all four seats champion greedy. */
export async function trueRollout(game, play, moverTeam, cfg) {
  const world = trueCopy(game);
  let result = advanceRound(world, play);
  for (let ply = 0; !result && ply < 1000; ply++)
    result = advanceRound(world, await greedy(world, cfg));
  if (!result) throw Error('Rollout did not terminate');
  return result.winner === moverTeam ? result.points : -result.points;
}

/** ORACLE decision on the true deal (reads hidden cards; diagnostic only). */
export async function oracleDecision(game, cfg) {
  const t0 = performance.now();
  const player = game.turn;
  const plays = candidates(game.hands[player], game.L, game.trick?.play);
  const base = await cfg.values(cfg.champion, policyState(game, player, 0, plays));
  const championIndex = argmax(base);
  const roots = searchRootsOf(base, plays, cfg.k);
  const outcome = [new Float64Array(roots.length)];
  for (let r = 0; r < roots.length; r++)
    outcome[0][r] = await trueRollout(game, plays[roots[r]], player % 2, cfg);
  const means = Array.from(outcome[0]);
  const choice = netChoice({ roots, championIndex, means, outcome, base, net: 0 });
  return { ...choice, plays, base, championIndex, roots, means, ms: performance.now() - t0 };
}

/** One round of `seed` with `focalTeam` playing arm `arm`; result from the focal team's view. */
export async function playArmRound(seed, focalTeam, cfg, arm) {
  const spec = ARMS[arm];
  if (!spec) throw Error(`Unknown arm ${arm}`);
  if (!(cfg.endgameHi < cfg.lo) || cfg.endgame !== 'pimc' || !cfg.solver)
    throw Error('handover-oracle needs the deployed endgame arm (--endgame=pimc below --lo)');
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
    gainEstimate: 0,
    differPlies: [],
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
    aboveDecisions: 0,
    oracleDecisions: 0,
    oracleDiffers: 0,
    oracleMs: 0,
    oracleDifferPlies: [],
    handoverQ: null,
    handoverCards: null,
  };
  for (let ply = 0; ply < 1000; ply++) {
    if (ply !== game.log.length) throw Error('Ply must equal the public log length');
    const player = game.turn;
    const plays = candidates(game.hands[player], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
    if (index < 0 && plays.length === 1) index = 0;
    if (index < 0) {
      const cards = remaining(game);
      const focal = player % 2 === focalTeam;
      const zone = !focal
        ? null
        : cards > cfg.hi
          ? 'above'
          : cards >= cfg.lo
            ? 'mid'
            : cards <= cfg.endgameHi
              ? 'end'
              : null;
      const how = zone ? spec[zone] : 'champion';
      if (focal && cards <= cfg.hi && stats.handoverQ === null) {
        const q = await cfg.values(cfg.champion, policyState(game, player, 0, plays));
        stats.handoverQ = Math.max(...q);
        stats.handoverCards = cards;
      }
      let championIndex;
      if (how === 'oracle') {
        const d = await oracleDecision(game, cfg);
        index = d.index;
        championIndex = d.championIndex;
        stats.oracleDecisions++;
        stats.oracleMs += d.ms;
        if (index !== championIndex) {
          stats.oracleDiffers++;
          stats.oracleDifferPlies.push(ply);
        }
      } else if (how === 'search' && zone === 'end') {
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
      } else if (how === 'search' && zone === 'mid') {
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
      } else {
        championIndex = argmax(await cfg.values(cfg.champion, policyState(game, player, 0, plays)));
        index = championIndex;
      }
      if (zone === 'above') stats.aboveDecisions++;
      if (zone === 'mid') {
        stats.bandDecisions++;
        if (how === 'search' && index !== championIndex) {
          stats.differs++;
          stats.differPlies.push(ply);
        }
      }
      if (zone === 'end') {
        stats.endgameDecisions++;
        if (how === 'search' && index !== championIndex) {
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

export async function playArmPair(seed, cfg, arm) {
  const t0 = performance.now();
  const a = await playArmRound(seed, 0, cfg, arm);
  const b = await playArmRound(seed, 1, cfg, arm);
  return { seed, arm, a, b, mean: (a.points + b.points) / 2, ms: performance.now() - t0 };
}

/** Oracle totals of a set of pair rows (the midgame-search summary does not know them). */
export function oracleSummary(rows) {
  const rounds = rows.flatMap((r) => [r.a, r.b]);
  const sum = (key) => rounds.reduce((s, r) => s + (r[key] || 0), 0);
  const n = sum('oracleDecisions');
  const hq = rounds.filter((r) => Number.isFinite(r.handoverQ));
  let corr = null;
  if (hq.length > 2) {
    const xs = hq.map((r) => r.handoverQ),
      ys = hq.map((r) => r.points);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length,
      my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0,
      sxx = 0,
      syy = 0;
    for (let i = 0; i < xs.length; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    corr = sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }
  return {
    focalAboveDecisions: sum('aboveDecisions'),
    oracleDecisions: n,
    oracleDecisionsDifferentFromChampion: sum('oracleDiffers'),
    oracleFractionDiffering: n ? sum('oracleDiffers') / n : null,
    oracleSecondsPerDecision: n ? sum('oracleMs') / 1000 / n : null,
    handoverRounds: hq.length,
    handoverCorrQResult: corr,
    handoverNote:
      'champion max Q at the focal first real decision with <= hi cards vs that round result (descriptive)',
  };
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

/** Protocol: the deployed 9001 settings through midgame-search buildProtocol, plus the arms. */
export function buildHandoverProtocol(args) {
  const base = buildProtocol({
    'worlds-source': 'belief',
    endgame: 'pimc',
    'endgame-hi': '20',
    'endgame-worlds': 'belief',
    ...args,
    mode: 'search',
  });
  const arms = String(args.arms ?? 'A,B,C')
    .split(',')
    .filter(Boolean);
  for (const arm of arms) if (!ARMS[arm]) throw Error(`--arms: unknown arm ${arm}`);
  if (new Set(arms).size !== arms.length) throw Error('--arms: duplicate arm');
  return {
    ...base,
    purpose:
      'window-3 S1 development diagnostic: hand-over headroom; arms A (deployed 9001), B (true-deal ' +
      'oracle above hi, 9001 at <= hi), C (true-deal oracle everywhere); the oracle reads hidden ' +
      'cards and is a bound, not a player; not preregistered as acceptance; not training data',
    arms,
    armSpec: Object.fromEntries(arms.map((a) => [a, ARMS[a]])),
    oracle:
      'rollout2.mjs --truth=1 rule: champion top-k by Q plus pass, one true-deal rollout per candidate ' +
      'with all four seats champion greedy to the round end, argmax, ties within 1e-9 by champion Q (net 0)',
    stopFiles: String(args['stop-file'] ?? '')
      .split(',')
      .filter(Boolean)
      .map((f) => resolve(f)),
  };
}

const stopped = (run) => Date.now() >= run.deadline || run.stopFiles.some((f) => existsSync(f));

async function worker(args) {
  const ort = await import('onnxruntime-node');
  const out = resolve(args.out);
  const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  const part = Number(args.part),
    parts = run.workers;
  const cfg = await createConfig(run, ort);
  const started = Date.now();
  let done = 0;
  try {
    outer: for (let k = part; k < run.pairs; k += parts) {
      for (const arm of run.arms) {
        if (stopped(run)) break outer;
        const row = await playArmPair(run.start + k, cfg, arm);
        appendFileSync(join(out, arm, `part-${part}.jsonl`), JSON.stringify(row) + '\n');
      }
      done++;
      if (done % 2 === 0)
        process.stderr.write(
          `[w${part}] ${done} seeds, last ${run.start + k}, ${((Date.now() - started) / 1000).toFixed(0)} s, ` +
            `rss ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB\n`,
        );
    }
  } finally {
    await cfg.close();
  }
  writeFileSync(
    join(out, `part-${part}.done.json`),
    JSON.stringify({ part, seeds: done, seconds: (Date.now() - started) / 1000 }),
  );
}

/** Per-arm summaries and paired comparisons from whatever rows exist. */
export function summarizeRun(out) {
  const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  const prefixes = {};
  const result = { arms: {}, compare: {} };
  for (const arm of run.arms) {
    const dir = join(out, arm);
    const { all, rows, last } = collect(dir, run.workers, run.start);
    prefixes[arm] = rows;
    const summary = {
      arm,
      armSpec: run.armSpec[arm],
      start: run.start,
      plannedPairs: run.pairs,
      completedPairsTotal: all.length,
      seedRange: [run.start, last],
      droppedBeyondPrefix: all.length - rows.length,
      ...(rows.length ? summarize(rows) : { pairs: 0 }),
      oracle: oracleSummary(rows),
      interval:
        'deal-pair cluster, normal approximation; development seeds; development diagnostic',
      summarizedAt: new Date().toISOString(),
    };
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    result.arms[arm] = summary;
  }
  for (const [x, y] of [
    ['A', 'B'],
    ['B', 'C'],
    ['A', 'C'],
  ]) {
    if (!prefixes[x] || !prefixes[y]) continue;
    const c = {
      difference: `${y} minus ${x}, focal mean signed round points per deal pair`,
      ...compareRows(prefixes[x], prefixes[y]),
      note: 'development diagnostic; the oracle reads hidden cards (upper bound, not a player)',
    };
    writeFileSync(join(out, `compare-${x}-${y}.json`), JSON.stringify(c, null, 2));
    result.compare[`${y}-${x}`] = c;
  }
  return result;
}

async function main(args) {
  const out = resolve(args.out ?? '');
  if (!args.out) throw Error('--out=<dir>');
  if (args.summarize) {
    console.log(JSON.stringify(summarizeRun(out), null, 2));
    return;
  }
  if (existsSync(join(out, 'run.json'))) throw Error(`${out} already holds a run; use a new --out`);
  const workers = Number(args.workers ?? 3);
  if (!Number.isInteger(workers) || workers < 1) throw Error('--workers');
  let deadline;
  if (args.deadline) deadline = Date.parse(args.deadline);
  else if (args.minutes) deadline = Date.now() + Number(args.minutes) * 60_000;
  if (!Number.isFinite(deadline) || deadline <= Date.now())
    throw Error('--deadline=<ISO> or --minutes=<m> in the future');
  const protocol = buildHandoverProtocol(args);
  const sources = sourceClosure(SELF);
  const run = {
    ...protocol,
    workers,
    deadline,
    deadlineISO: new Date(deadline).toISOString(),
    out,
    sources,
    node: process.version,
    startedAt: new Date().toISOString(),
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'run.json'), JSON.stringify(run, null, 2));
  // Per-arm run.json in the midgame-search shape, so dashboards read each arm as a midgame run.
  for (const arm of run.arms) {
    mkdirSync(join(out, arm), { recursive: true });
    writeFileSync(
      join(out, arm, 'run.json'),
      JSON.stringify({ ...run, arm, armSpec: run.armSpec[arm], sources: undefined }, null, 2),
    );
  }
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
  const result = summarizeRun(out);
  writeFileSync(
    join(out, 'summary.json'),
    JSON.stringify(
      { finishedAt: new Date().toISOString(), workerFailures: failures, ...result },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(result.compare).map(([k, c]) => [
          k,
          [c.commonPairs, c.meanDifference, c.ci95],
        ]),
      ),
    ),
  );
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const args = parseArgs(process.argv.slice(2));
  (args.worker ? worker(args) : main(args)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
