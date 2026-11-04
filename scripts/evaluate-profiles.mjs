import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { simulateRound } from './lib/simulation.mjs';
import { BOT_PROFILES } from '../src/ai/profiles.js';

const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') || fallback;
const pairs = Number(option('pairs', '100'));
const seed = Number(option('seed', '20261104'));
const styles = option('styles', 'aggressive,conservative,observant').split(',');
const output = option('output', 'work/validation/profiles');
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 100000) throw Error('Invalid pair count');
if (styles.some((style) => !BOT_PROFILES.some((profile) => profile.id === style)))
  throw Error('Invalid style');
await mkdir(output, { recursive: true });
const python = spawn(option('python', 'python'), ['-u', 'scripts/eval_inference.py'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
});
const pending = [];
createInterface({ input: python.stdout }).on('line', (line) => {
  const waiter = pending.shift();
  if (!waiter) return;
  try {
    const result = JSON.parse(line);
    if (result.error) waiter.reject(Error(result.error));
    else waiter.resolve(result.values);
  } catch (error) {
    waiter.reject(error);
  }
});
python.on('exit', (code) => {
  for (const waiter of pending.splice(0)) waiter.reject(Error(`Inference exited ${code}`));
});
const infer = (state) =>
  new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
    python.stdin.write(JSON.stringify(state) + '\n');
  });
const reports = [];
const started = performance.now();
try {
  for (const style of styles) {
    const results = [];
    const totals = {
      decisions: 0,
      changed: 0,
      passes: 0,
      bombs: 0,
      cards: 0,
      actions: 0,
      passDelta: 0,
      bombDelta: 0,
      cardDelta: 0,
      valueLoss: 0,
    };
    for (let pair = 0; pair < pairs; pair++) {
      const outcomes = [];
      for (const side of [0, 1]) {
        const profiles = Array.from({ length: 4 }, (_, seat) =>
          seat % 2 === side ? style : 'balanced',
        );
        const result = await simulateRound(seed + pair, profiles, infer);
        const signed = (result.winner === side ? 1 : -1) * result.points;
        outcomes.push({ winner: result.winner, points: signed, turns: result.turns });
        for (const key of Object.keys(totals)) totals[key] += result.stats[key];
      }
      results.push({
        seed: seed + pair,
        outcomes,
        points: outcomes.reduce((sum, round) => sum + round.points, 0),
      });
      if ((pair + 1) % 10 === 0)
        console.log(
          `${style} ${pair + 1}/${pairs} pairs · elapsed ${Math.round((performance.now() - started) / 1000)}s`,
        );
    }
    const rounds = results.flatMap((result) => result.outcomes);
    const wins = rounds.filter((round) => round.points > 0).length;
    const mean = results.reduce((sum, result) => sum + result.points, 0) / pairs;
    const variance =
      results.reduce((sum, result) => sum + (result.points - mean) ** 2, 0) /
      Math.max(1, pairs - 1);
    const report = {
      style,
      pairs,
      rounds: rounds.length,
      wins,
      losses: rounds.length - wins,
      winRate: wins / rounds.length,
      pairedPointsMean: mean,
      pairedPoints95CI: [
        mean - 1.96 * Math.sqrt(variance / pairs),
        mean + 1.96 * Math.sqrt(variance / pairs),
      ],
      totals,
      changeRate: totals.changed / Math.max(1, totals.decisions),
      results,
    };
    reports.push(report);
    await writeFile(`${output}/${style}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, results: undefined }));
  }
  await writeFile(
    `${output}/summary.json`,
    JSON.stringify(
      {
        seed,
        pairs,
        elapsedSeconds: (performance.now() - started) / 1000,
        reports: reports.map(({ results, ...report }) => report),
      },
      null,
      2,
    ),
  );
} finally {
  python.stdin.end();
  python.kill();
}
