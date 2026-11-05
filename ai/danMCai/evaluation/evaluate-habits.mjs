import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { simulateRound } from '../../shared/simulation/simulation.mjs';
import { createPolicyInference } from '../../shared/simulation/policy-inference.mjs';
import { publicEnding } from '../../shared/simulation/public-ending.mjs';
import { selectProfileAction } from '../../../web/src/ai/profiles.js';
import { responseCandidates } from '../../../web/src/ai/response.mjs';
import { encodeResponse } from '../../../web/src/ai/response-features.mjs';
import { HABIT_ROUNDS, HABIT_DECAY } from '../../../web/src/ai/habits.js';

const option = (name, fallback) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const pairs = Number(option('pairs', '200'));
const blockRounds = Number(option('block-rounds', '5'));
const seed = Number(option('seed', '20400104'));
const style = option('style', 'observant');
const output = option('output', 'ai/danMCai/data/generated/habits-development');
const fixtureLimit = Number(option('fixtures', '0'));
if (
  !Number.isInteger(pairs) ||
  pairs < 1 ||
  pairs > 100000 ||
  !Number.isInteger(blockRounds) ||
  blockRounds < 2 ||
  blockRounds > 20 ||
  !Number.isInteger(seed) ||
  !['observant', 'adaptive'].includes(style) ||
  !Number.isInteger(fixtureLimit) ||
  fixtureLimit < 0 ||
  fixtureLimit > 100
)
  throw Error('Invalid evaluation options');
await mkdir(output, { recursive: true });
const policy = createPolicyInference();
const response = createPolicyInference({
  script: fileURLToPath(new URL('../training/response_inference.py', import.meta.url)),
});
const results = [],
  fixtures = [];
const stats = {
  decisions: 0,
  memoryDecisions: 0,
  preferenceChanges: 0,
  responseCalls: 0,
  proved: 0,
};
const started = performance.now();
try {
  for (let pair = 0; pair < pairs; pair++) {
    const outcomes = [];
    for (const side of [0, 1]) {
      const history = [];
      for (let round = 0; round < blockRounds; round++) {
        let captured = false;
        const result = await simulateRound(
          seed + pair * blockRounds + round,
          Array(4).fill(style),
          policy.infer,
          {
            roundHistory: history,
            onFinish: (game) => history.push({ log: structuredClone(game.log) }),
            selectAction: async (plays, values, _style, context) => {
              const solved = publicEnding(context, plays, values);
              if (solved) {
                stats.proved++;
                return solved.index;
              }
              const memory = context.p % 2 === side;
              const legacy = { ...context, habits: undefined };
              const used = memory ? context : legacy;
              const original = selectProfileAction(plays, values, style, used);
              stats.decisions++;
              if (memory && context.habits) {
                stats.memoryDecisions++;
                if (original !== selectProfileAction(plays, values, style, legacy))
                  stats.preferenceChanges++;
              }
              const options = responseCandidates(plays, values, used, original);
              if (!options) return original;
              const { indices, recipient } = options;
              const probabilities = await response.infer({
                features: indices.map((index) =>
                  Array.from(encodeResponse(used, plays[index], recipient)),
                ),
              });
              stats.responseCalls++;
              const risks = plays.map(() => null);
              indices.forEach((index, offset) => (risks[index] = probabilities[offset]));
              const chosen = selectProfileAction(plays, values, style, {
                ...used,
                responseRisks: risks,
              });
              if (memory && context.habits && !captured && fixtures.length < fixtureLimit) {
                captured = true;
                fixtures.push({
                  state: {
                    p: context.p,
                    hand: context.hand.map((card) => card.id),
                    counts: context.counts,
                    log: context.log.map((entry) => ({
                      p: entry.p,
                      cards: entry.cards?.map((card) => card.id) || null,
                    })),
                    level: context.level,
                    selfLevel: context.level,
                    opponentLevel: context.level,
                    canPass: !!context.trick,
                    actions: plays.map((play) => play?.cards.map((card) => card.id) || []),
                    profile: style,
                    context,
                    actionShapes: plays.map(
                      (play) =>
                        play && { type: play.type, value: play.value, n: play.n, wu: play.wu },
                    ),
                    includeValues: true,
                    roundHistory: structuredClone(history.slice(-HABIT_ROUNDS)),
                  },
                  expectedIndex: chosen,
                  originalIndex: original,
                  values,
                  risks,
                });
              }
              return chosen;
            },
          },
        );
        outcomes.push({
          side,
          round: round + 1,
          winner: result.winner,
          points: (result.winner === side ? 1 : -1) * result.points,
          turns: result.turns,
        });
      }
    }
    results.push({
      seed: seed + pair * blockRounds,
      outcomes,
      points: outcomes.reduce((sum, round) => sum + round.points, 0) / blockRounds,
    });
    if ((pair + 1) % 10 === 0)
      console.log(
        `${style} ${pair + 1}/${pairs} paired blocks · ${Math.round((performance.now() - started) / 1000)}s`,
      );
  }
  const outcomes = results.flatMap((result) => result.outcomes);
  const mean = results.reduce((sum, result) => sum + result.points, 0) / pairs;
  const variance =
    results.reduce((sum, result) => sum + (result.points - mean) ** 2, 0) / Math.max(1, pairs - 1);
  const hashes = {};
  for (const file of [
    'ai/danMCai/models/baseline/policy.onnx',
    'ai/danMCai/models/baseline/response.onnx',
    'web/src/ai/habits.js',
  ])
    hashes[file] = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  const report = {
    style,
    baseline: 'same style with current-round size-only observations',
    seed,
    pairs,
    blockRounds,
    rounds: outcomes.length,
    habitRounds: HABIT_ROUNDS,
    habitDecay: HABIT_DECAY,
    winRate: outcomes.filter((round) => round.points > 0).length / outcomes.length,
    pairedPointsPerRoundMean: mean,
    pairedPointsPerRound95CI: [
      mean - 1.96 * Math.sqrt(variance / pairs),
      mean + 1.96 * Math.sqrt(variance / pairs),
    ],
    confidenceUnit: 'paired block; correlated rounds are kept together',
    stats,
    hashes,
    elapsedSeconds: (performance.now() - started) / 1000,
  };
  await writeFile(`${output}/results.json`, JSON.stringify({ ...report, results }, null, 2));
  await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2));
  if (fixtures.length) await writeFile(`${output}/fixtures.json`, JSON.stringify(fixtures));
  console.log(JSON.stringify(report));
} finally {
  policy.close();
  response.close();
}
