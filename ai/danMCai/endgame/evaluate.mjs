/**
 * Paired held-out evaluation of an endgame student plugged into the champion.
 *
 * Each reserved deal is played twice with sides swapped. The focal team plays the champion until
 * the table is at or below the endgame threshold, then the student; the other team always plays
 * the champion. All choices are greedy (finishing move first, single candidate auto), observing
 * only own hand and public information. Primary metric: focal team's mean signed round points per
 * deal pair, with a 95% deal-cluster normal interval. An exact perfect-information regret check on
 * small endgames is descriptive only (it is not an acceptance metric).
 *
 * --policy selects what the focal team plays at or below the threshold (default `student`, whose
 * results and output files are unchanged from the original evaluator):
 *   student         argmax of the --student network;
 *   pimc-search     runtime search, no network: the 8-world PIMC label of every candidate
 *                   (labelDecision from pimc-actor.mjs, same solver budget, minimum 4 solved worlds
 *                   and world seed (seed*1009 + ply*7919)>>>0 as the section-68 actor), playing the
 *                   label-maximal candidate; ties (|y - y*| <= 1e-9) go to the champion's highest
 *                   value; when no label is available (fewer than 4 worlds solved inside the budget)
 *                   the champion argmax is played and counted as a fallback. Labels are mean exact
 *                   signed round points over sampled worlds; the hidden hands are never read;
 *   champion-check  the champion itself (pairing sanity check: every pair must score exactly 0).
 * Search results can depend on the per-solver millisecond budget and on the worker's transposition
 * table (which worlds finish inside budget), so they are not bit-reproducible across machines.
 *
 *   node ai/danMCai/endgame/evaluate.mjs --student=<onnx> --champion=<onnx> --seeds=<seed-audit.json>
 *        --out=<dir> [--pairs=3000] [--threshold=32] [--workers=4] [--solver-cards=18]
 *        [--policy=student|pimc-search|champion-check]   (--student is not used by the other two)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { createRound, advanceRound } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { argmax, createModelPool, sha256 } from '../training/continuous/lib.mjs';
import { labelDecision } from './pimc-actor.mjs';
import { createSolver, positionFromGame, solveEndgame, SolverBudget } from './solver.mjs';
import { isMain, spawnNice } from './platform.mjs';

const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const remaining = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);

export const POLICIES = ['student', 'pimc-search', 'champion-check'];
export class EvaluationStopped extends Error {}
/** Fixed runtime-search settings of --policy=pimc-search (section-68 actor labels). */
export const SEARCH = Object.freeze({
  worlds: 8,
  minWorlds: 4,
  solver: Object.freeze({ maxNodes: 1_500_000, maxMs: 3000, maxTable: 1_000_000 }),
  worldSeed: '(seed*1009 + ply*7919)>>>0',
  tieTolerance: 1e-9,
  tieBreak: 'champion value',
});
export const createSearchSolver = () => createSolver(SEARCH.solver);
/** Source files (relative to this module) whose SHA-256 the non-default modes record in run.json. */
const SEARCH_SOURCES = [
  './pimc-actor.mjs',
  './solver.mjs',
  '../../shared/search/belief.mjs',
  '../../shared/search/pimc.mjs',
  '../../shared/simulation/simulation.mjs',
  '../../../web/src/ai/candidates.js',
  '../../../web/src/ai/observation.js',
  '../../../web/src/core/combinations.js',
  '../training/continuous/lib.mjs',
];

/**
 * Runtime PIMC choice for the current decision: label-maximal candidate, ties broken by the
 * champion values `base`; `index` is null when no label is available.
 */
export function searchChoice(game, plays, base, { solver, seed, ply }) {
  const label = labelDecision(game, plays, {
    solver,
    worlds: SEARCH.worlds,
    minWorlds: SEARCH.minWorlds,
    seed: (seed * 1009 + ply * 7919) >>> 0,
  });
  if (!label.q) return { index: null, used: label.used, tied: 0 };
  const top = Math.max(...label.q);
  const tied = [];
  label.q.forEach((y, i) => Math.abs(y - top) <= SEARCH.tieTolerance && tied.push(i));
  const index = tied.reduce((best, i) => (base[i] > base[best] ? i : best), tied[0]);
  return { index, used: label.used, tied: tied.length };
}

export async function playPaired(
  seed,
  focalTeam,
  {
    values,
    champion,
    student,
    threshold,
    solverCards,
    policy = 'student',
    solver = null,
    checkpoint = () => {},
  },
) {
  if (!POLICIES.includes(policy)) throw Error(`Unknown policy ${policy}`);
  const game = createRound(seed);
  const stats = {
    endgameDecisions: 0,
    differs: 0,
    solverChecked: 0,
    regretStudent: 0,
    regretChampion: 0,
  };
  // Extra per-round fields only outside the default mode, so student-mode output is unchanged.
  if (policy === 'pimc-search') {
    if (!solver) throw Error('pimc-search needs a solver');
    Object.assign(stats, {
      searched: 0,
      searchFallbacks: 0,
      searchTies: 0,
      worldsUsed: 0,
      searchSeconds: 0,
      searchMaxSeconds: 0,
    });
  }
  for (let ply = 0; ply < 1000; ply++) {
    checkpoint();
    const player = game.turn;
    const plays = candidates(game.hands[player], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
    if (index < 0 && plays.length === 1) index = 0;
    if (index < 0) {
      const state = policyState(game, player, 0, plays);
      const useStudent = player % 2 === focalTeam && remaining(game) <= threshold;
      const base = await values(champion, state);
      if (useStudent) {
        const championIndex = argmax(base);
        if (policy === 'student') index = argmax(await values(student, state));
        else if (policy === 'champion-check') index = championIndex;
        else {
          const started = performance.now();
          const choice = searchChoice(game, plays, base, { solver, seed, ply });
          const seconds = (performance.now() - started) / 1000;
          stats.searched++;
          stats.worldsUsed += choice.used;
          stats.searchSeconds += seconds;
          stats.searchMaxSeconds = Math.max(stats.searchMaxSeconds, seconds);
          stats.searchTies += Number(choice.tied > 1);
          if (choice.index === null) stats.searchFallbacks++;
          index = choice.index ?? championIndex;
        }
        stats.endgameDecisions++;
        if (index !== championIndex) {
          stats.differs++;
          if (remaining(game) <= solverCards) {
            try {
              const solved = solveEndgame(positionFromGame(game), {
                rootPlays: [plays[index], plays[championIndex]],
                maxNodes: 1_500_000,
                maxMs: 3000,
              });
              const best = solveEndgame(positionFromGame(game), {
                maxNodes: 1_500_000,
                maxMs: 3000,
              });
              stats.solverChecked++;
              stats.regretStudent += best.value - solved.actions[0].value;
              stats.regretChampion += best.value - solved.actions[1].value;
            } catch (error) {
              if (!(error instanceof SolverBudget)) throw error;
            }
          }
        }
      } else index = argmax(base);
    }
    const result = advanceRound(game, plays[index]);
    if (result) {
      const points = result.winner === focalTeam ? result.points : -result.points;
      return { points, order: result.order, ...stats };
    }
  }
  throw Error('Round did not terminate');
}

async function worker() {
  const part = Number(option('part')),
    parts = Number(option('parts'));
  const seeds = JSON.parse(readFileSync(option('seeds'), 'utf8')).seeds.slice(
    0,
    Number(option('pairs')),
  );
  const pool = await createModelPool(ort, { threads: 1, limit: 2 });
  const values = (file, state) => pool.values(file, state);
  const policy = option('policy', 'student');
  const config = {
    values,
    champion: option('champion'),
    student: option('student'),
    threshold: Number(option('threshold')),
    solverCards: Number(option('solver-cards')),
    policy,
    solver: policy === 'pimc-search' ? createSearchSolver() : null,
    checkpoint: () => {
      if (
        (option('stop-file') && existsSync(option('stop-file'))) ||
        (option('deadline') && Date.now() >= Date.parse(option('deadline')))
      )
        throw new EvaluationStopped('Evaluation STOP or fixed deadline');
    },
  };
  const rows = [];
  for (let i = part; i < seeds.length; i += parts) {
    const seed = seeds[i];
    const started = performance.now();
    let a, b;
    try {
      a = await playPaired(seed, 0, config);
      b = await playPaired(seed, 1, config);
    } catch (error) {
      if (error instanceof EvaluationStopped) break;
      throw error;
    }
    const row = { seed, a, b, mean: (a.points + b.points) / 2 };
    if (policy !== 'student') row.seconds = (performance.now() - started) / 1000;
    rows.push(row);
    writeFileSync(
      join(option('out'), `progress-${part}.json`),
      JSON.stringify({
        pid: process.pid,
        completedPairs: rows.length,
        updatedAt: new Date().toISOString(),
      }),
    );
  }
  writeFileSync(join(option('out'), `part-${part}.json`), JSON.stringify(rows));
  await pool.close();
}

export function summarize(rows, { policy = 'student' } = {}) {
  const n = rows.length;
  const means = rows.map((r) => r.mean);
  const mean = means.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(means.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const half = (1.96 * sd) / Math.sqrt(n);
  const rounds = rows.flatMap((r) => [r.a, r.b]);
  const sum = (key) => rounds.reduce((s, r) => s + r[key], 0);
  return {
    pairs: n,
    rounds: rounds.length,
    focalWins: rounds.filter((r) => r.points > 0).length,
    focalLosses: rounds.filter((r) => r.points < 0).length,
    meanSignedPoints: mean,
    ci95: [mean - half, mean + half],
    interval: 'deal-pair cluster, normal approximation; evaluation deals only, not training reruns',
    studentEndgameDecisions: sum('endgameDecisions'),
    decisionsDifferentFromChampion: sum('differs'),
    descriptiveExactRegret: {
      checked: sum('solverChecked'),
      studentMean: sum('solverChecked') ? sum('regretStudent') / sum('solverChecked') : null,
      championMean: sum('solverChecked') ? sum('regretChampion') / sum('solverChecked') : null,
      note: 'Perfect-information minimax regret on disagreements with <= solver-cards cards; descriptive only.',
    },
    ...(policy === 'student' ? {} : policySummary(rows, rounds, sum, policy)),
  };
}

/** Fields added (never replacing existing ones) for --policy other than the default student. */
function policySummary(rows, rounds, sum, policy) {
  const extra = {
    policy,
    policyNote:
      policy === 'pimc-search'
        ? 'studentEndgameDecisions/decisionsDifferentFromChampion/regretStudent refer to the runtime PIMC search arm, not a network.'
        : 'Focal team plays the champion everywhere; meanSignedPoints must be exactly 0.',
    pairsZero: rows.filter((r) => r.mean === 0).length,
    pairsPositive: rows.filter((r) => r.mean > 0).length,
    pairsNegative: rows.filter((r) => r.mean < 0).length,
    pairSeconds: rows.reduce((s, r) => s + (r.seconds ?? 0), 0),
    meanPairSeconds: rows.reduce((s, r) => s + (r.seconds ?? 0), 0) / rows.length,
  };
  if (policy !== 'pimc-search') return extra;
  const searched = sum('searched');
  return {
    ...extra,
    search: {
      ...SEARCH,
      searchedDecisions: searched,
      fallbacksToChampion: sum('searchFallbacks'),
      tiedLabelMaximum: sum('searchTies'),
      worldsUsed: sum('worldsUsed'),
      searchSeconds: sum('searchSeconds'),
      secondsPerSearchedDecision: searched ? sum('searchSeconds') / searched : null,
      maxSecondsPerSearchedDecision: Math.max(0, ...rounds.map((r) => r.searchMaxSeconds)),
    },
  };
}

async function main() {
  const out = resolve(option('out'));
  mkdirSync(out, { recursive: true });
  const workers = Number(option('workers', 4));
  const policy = option('policy', 'student');
  if (!POLICIES.includes(policy)) throw Error(`Unknown --policy=${policy}`);
  const withStudent = policy === 'student';
  const args = {
    ...(withStudent ? { student: resolve(option('student')) } : {}),
    champion: resolve(option('champion')),
    seeds: resolve(option('seeds')),
    pairs: option('pairs', 3000),
    threshold: option('threshold', 32),
    'solver-cards': option('solver-cards', 18),
    out,
    ...(option('deadline') ? { deadline: option('deadline') } : {}),
    ...(option('stop-file') ? { 'stop-file': resolve(option('stop-file')) } : {}),
    ...(withStudent ? {} : { policy }),
  };
  const self = fileURLToPath(import.meta.url);
  const protocol = {
    ...args,
    ...(withStudent ? { studentSHA256: sha256(args.student) } : {}),
    championSHA256: sha256(args.champion),
    seedsSHA256: sha256(args.seeds),
    workers,
    startedAt: new Date().toISOString(),
    ...(withStudent
      ? {}
      : {
          student: null,
          studentSHA256: null,
          evaluatorSHA256: sha256(self),
          // The arm's behaviour also depends on these modules (labels, belief, rules, candidates).
          sourceSHA256: Object.fromEntries(
            SEARCH_SOURCES.map((path) => [
              path,
              sha256(fileURLToPath(new URL(path, import.meta.url))),
            ]),
          ),
          ...(policy === 'pimc-search' ? { search: SEARCH } : {}),
        }),
  };
  writeFileSync(join(out, 'run.json'), JSON.stringify(protocol, null, 2));
  await Promise.all(
    Array.from(
      { length: workers },
      (_, part) =>
        new Promise((done, fail) => {
          const child = spawnNice(
            10,
            process.execPath,
            [
              self,
              '--worker',
              `--part=${part}`,
              `--parts=${workers}`,
              ...Object.entries(args).map(([k, v]) => `--${k}=${v}`),
            ],
            { stdio: 'inherit' },
          );
          child.on('exit', (code) =>
            code === 0 ? done() : fail(Error(`worker ${part} exit ${code}`)),
          );
        }),
    ),
  );
  const rows = Array.from({ length: workers }, (_, part) =>
    JSON.parse(readFileSync(join(out, `part-${part}.json`), 'utf8')),
  ).flat();
  const summary = {
    ...protocol,
    finishedAt: new Date().toISOString(),
    ...summarize(rows, { policy }),
  };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (isMain(import.meta.url)) {
  (process.argv.includes('--worker') ? worker() : main()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
