import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { simulateRound } from '../../shared/simulation/simulation.mjs';
import { createPolicyInference } from '../../shared/simulation/policy-inference.mjs';
import { BOT_PROFILES } from '../../../web/src/ai/profiles.js';
import { ENDGAME_MAX_CARDS } from '../../../web/src/ai/endgame.js';

const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') || fallback;
const pairs = Number(option('pairs', '100'));
const seed = Number(option('seed', '20261104'));
const endgameCards = Number(option('endgame-cards', String(ENDGAME_MAX_CARDS)));
if (!Number.isInteger(endgameCards) || endgameCards < 0 || endgameCards > ENDGAME_MAX_CARDS)
  throw Error('Invalid endgame card limit');
const styles = option('styles', 'aggressive,conservative,observant').split(',');
const output = option('output', 'web/artifacts/validation/profiles');
const captureLimit = Number(option('capture-endgame', '0'));
const captured = [];
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 100000) throw Error('Invalid pair count');
if (
  styles.some(
    (style) => style !== 'endgame' && !BOT_PROFILES.some((profile) => profile.id === style),
  )
)
  throw Error('Invalid style');
await mkdir(output, { recursive: true });
const engine = createPolicyInference({ python: option('python', 'python') });
const infer = engine.infer;
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
      endgameCalls: 0,
      endgameProofs: 0,
      endgameMs: 0,
    };
    for (let pair = 0; pair < pairs; pair++) {
      const outcomes = [];
      for (const side of [0, 1]) {
        const profiles = Array.from({ length: 4 }, (_, seat) =>
          seat % 2 === side ? style : 'balanced',
        );
        const result = await simulateRound(seed + pair, profiles, infer, {
          maxEndgameCards: endgameCards,
          onDecision: (decision) => {
            if (
              captured.length < captureLimit &&
              decision.style === 'endgame' &&
              decision.selected !== decision.baseline
            )
              captured.push({
                state: decision.state,
                expectedIndex: decision.selected,
                baselineIndex: decision.baseline,
              });
          },
        });
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
      endgameCards,
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
      positivePairs: results.filter((result) => result.points > 0).length,
      negativePairs: results.filter((result) => result.points < 0).length,
      results,
    };
    reports.push(report);
    await writeFile(`${output}/${style}.json`, JSON.stringify(report, null, 2));
    if (captured.length)
      await writeFile(`${output}/endgame-positions.json`, JSON.stringify(captured));
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
  engine.close();
}
