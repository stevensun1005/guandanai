import { mkdirSync, writeFileSync } from 'node:fs';
import { createPolicyInference } from '../../shared/simulation/policy-inference.mjs';
import { simulateRound } from '../../shared/simulation/simulation.mjs';
import { selectProfileAction } from '../../../web/src/ai/profiles.js';
import { ENDGAME_MAX_CARDS, solvePublicEndgame } from '../../../web/src/ai/endgame.js';
const option = (name, fallback) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const pairs = +option('pairs', '400'),
  seed = +option('seed', '20350104'),
  output = option('output', 'web/artifacts/validation/endgame');
mkdirSync(output, { recursive: true });
const cards = +option('cards', String(ENDGAME_MAX_CARDS)),
  baselineCards = +option('baseline', '16');
if (
  !Number.isInteger(pairs) ||
  pairs < 1 ||
  pairs > 100000 ||
  !Number.isInteger(cards) ||
  !Number.isInteger(baselineCards) ||
  cards > ENDGAME_MAX_CARDS ||
  baselineCards < 0 ||
  baselineCards >= cards
)
  throw Error('Invalid comparison limits');
const engine = createPolicyInference();
const results = [],
  captured = [];
const timings = [];
const stats = {
  calls: 0,
  proofs: 0,
  expandedCalls: 0,
  expandedProofs: 0,
  expandedChoices: 0,
  maxNodes: 0,
};
const started = performance.now();
try {
  for (let pair = 0; pair < pairs; pair++) {
    const outcomes = [];
    for (const side of [0, 1]) {
      const result = await simulateRound(seed + pair, Array(4).fill('balanced'), engine.infer, {
        selectAction: (plays, values, style, context) => {
          const original = selectProfileAction(plays, values, 'balanced', context);
          if (context.counts.filter(Boolean).length !== 2) return original;
          const total = context.counts.reduce((a, b) => a + b, 0);
          if (total > cards) return original;
          let passes = 0;
          if (context.trick)
            for (let i = context.log.length - 1; i >= 0 && !context.log[i].cards; i--) passes++;
          const state = {
            p: context.p,
            hand: context.hand.map((c) => c.id),
            counts: context.counts,
            level: context.level,
            selfLevel: context.level,
            opponentLevel: context.level,
            canPass: !!context.trick,
            log: context.log.map((e) => ({ p: e.p, cards: e.cards?.map((c) => c.id) || null })),
            actions: plays.map((play) => play?.cards.map((c) => c.id) || []),
            endgame: {
              trick: context.trick,
              passes,
              shapes: plays.map(
                (play) => play && { type: play.type, n: play.n, value: play.value },
              ),
            },
          };
          const expanded = context.p % 2 === side;
          const first = performance.now();
          const solved =
            total <= (expanded ? cards : baselineCards) ? solvePublicEndgame(state, values) : null;
          const elapsed = performance.now() - first;
          if (expanded) {
            stats.calls++;
            timings.push(elapsed);
            if (total > baselineCards) stats.expandedCalls++;
            if (solved) {
              stats.proofs++;
              stats.maxNodes = Math.max(stats.maxNodes, solved.nodes);
              if (total > baselineCards) {
                stats.expandedProofs++;
                if (solved.index !== original) {
                  stats.expandedChoices++;
                  if (captured.length < 12)
                    captured.push({ state, expectedIndex: solved.index, baselineIndex: original });
                }
              }
            }
          }
          return solved?.index ?? original;
        },
      });
      outcomes.push({
        winner: result.winner,
        points: (result.winner === side ? 1 : -1) * result.points,
        turns: result.turns,
      });
    }
    results.push({
      seed: seed + pair,
      outcomes,
      points: outcomes.reduce((sum, o) => sum + o.points, 0),
    });
    if ((pair + 1) % 20 === 0)
      console.log(
        `${pair + 1}/${pairs} pairs · ${Math.round((performance.now() - started) / 1000)}s`,
      );
  }
  const mean = results.reduce((sum, r) => sum + r.points, 0) / pairs;
  const variance =
    results.reduce((sum, r) => sum + (r.points - mean) ** 2, 0) / Math.max(1, pairs - 1);
  timings.sort((a, b) => a - b);
  const report = {
    pairs,
    seed,
    rounds: 2 * pairs,
    cards,
    baselineCards,
    comparison: `${cards}-card public endgame versus ${baselineCards}-card public endgame; both balanced`,
    pairedPointsMean: mean,
    pairedPoints95CI: [
      mean - 1.96 * Math.sqrt(variance / pairs),
      mean + 1.96 * Math.sqrt(variance / pairs),
    ],
    positivePairs: results.filter((r) => r.points > 0).length,
    negativePairs: results.filter((r) => r.points < 0).length,
    stats,
    timingMs: {
      median: timings[Math.floor(timings.length * 0.5)],
      p95: timings[Math.floor(timings.length * 0.95)],
      max: timings.at(-1),
    },
    elapsedSeconds: (performance.now() - started) / 1000,
    results,
  };
  writeFileSync(output + '/results.json', JSON.stringify(report, null, 2));
  writeFileSync(output + '/positions.json', JSON.stringify(captured));
  console.log(JSON.stringify({ ...report, results: undefined }));
} finally {
  engine.close();
}
