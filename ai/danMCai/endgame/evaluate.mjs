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
 *   node ai/danMCai/endgame/evaluate.mjs --student=<onnx> --champion=<onnx> --seeds=<seed-audit.json>
 *        --out=<dir> [--pairs=3000] [--threshold=32] [--workers=4] [--solver-cards=18]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { createRound, advanceRound } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { argmax, createModelPool, sha256 } from '../training/continuous/lib.mjs';
import { positionFromGame, solveEndgame, SolverBudget } from './solver.mjs';

const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const remaining = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);

export async function playPaired(
  seed,
  focalTeam,
  { values, champion, student, threshold, solverCards },
) {
  const game = createRound(seed);
  const stats = {
    endgameDecisions: 0,
    differs: 0,
    solverChecked: 0,
    regretStudent: 0,
    regretChampion: 0,
  };
  for (let ply = 0; ply < 1000; ply++) {
    const player = game.turn;
    const plays = candidates(game.hands[player], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
    if (index < 0 && plays.length === 1) index = 0;
    if (index < 0) {
      const state = policyState(game, player, 0, plays);
      const useStudent = player % 2 === focalTeam && remaining(game) <= threshold;
      const base = await values(champion, state);
      if (useStudent) {
        const own = await values(student, state);
        index = argmax(own);
        const championIndex = argmax(base);
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
  const config = {
    values,
    champion: option('champion'),
    student: option('student'),
    threshold: Number(option('threshold')),
    solverCards: Number(option('solver-cards')),
  };
  const rows = [];
  for (let i = part; i < seeds.length; i += parts) {
    const seed = seeds[i];
    const a = await playPaired(seed, 0, config);
    const b = await playPaired(seed, 1, config);
    rows.push({ seed, a, b, mean: (a.points + b.points) / 2 });
  }
  writeFileSync(join(option('out'), `part-${part}.json`), JSON.stringify(rows));
  await pool.close();
}

export function summarize(rows) {
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
  };
}

async function main() {
  const out = resolve(option('out'));
  mkdirSync(out, { recursive: true });
  const workers = Number(option('workers', 4));
  const args = {
    student: resolve(option('student')),
    champion: resolve(option('champion')),
    seeds: resolve(option('seeds')),
    pairs: option('pairs', 3000),
    threshold: option('threshold', 32),
    'solver-cards': option('solver-cards', 18),
    out,
  };
  const protocol = {
    ...args,
    studentSHA256: sha256(args.student),
    championSHA256: sha256(args.champion),
    seedsSHA256: sha256(args.seeds),
    workers,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(out, 'run.json'), JSON.stringify(protocol, null, 2));
  const self = fileURLToPath(import.meta.url);
  await Promise.all(
    Array.from(
      { length: workers },
      (_, part) =>
        new Promise((done, fail) => {
          const child = spawn(
            'nice',
            [
              '-n',
              '10',
              process.execPath,
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
  const summary = { ...protocol, finishedAt: new Date().toISOString(), ...summarize(rows) };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (process.argv.includes('--worker') ? worker() : main()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
