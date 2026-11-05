import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { simulateRound } from '../../shared/simulation/simulation.mjs';
import { createPolicyInference } from '../../shared/simulation/policy-inference.mjs';
import {
  selectProfileAction,
  BOT_PROFILES,
  usesResponseModel,
} from '../../../web/src/ai/profiles.js';
import { ENDGAME_MAX_CARDS } from '../../../web/src/ai/endgame.js';
import { publicEnding } from '../../shared/simulation/public-ending.mjs';
import { encodeResponse } from '../../../web/src/ai/response-features.mjs';
import { responseCandidates } from '../../../web/src/ai/response.mjs';

const option = (name, fallback) =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ||
  fallback;
const pairs = Number(option('pairs', '400')),
  seed = Number(option('seed', '20280104'));
const testedStyle = option('style', 'observant'),
  opponentStyle = option('opponent', 'legacy-observant');
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 100000) throw Error('Invalid pair count');
if (
  !BOT_PROFILES.some((profile) => profile.id === testedStyle) ||
  !['legacy-observant', 'balanced', 'observant', 'aggressive', 'conservative', 'adaptive'].includes(
    opponentStyle,
  )
)
  throw Error('Invalid style');
const output = option('output', 'ai/danMCai/data/generated/response-evaluation-development');
const endgameCards = Number(option('endgame-cards', String(ENDGAME_MAX_CARDS)));
if (!Number.isInteger(endgameCards) || endgameCards < 0 || endgameCards > ENDGAME_MAX_CARDS)
  throw Error('Invalid endgame card limit');
mkdirSync(output, { recursive: true });
const policy = createPolicyInference(),
  response = createPolicyInference({
    script: fileURLToPath(new URL('../training/response_inference.py', import.meta.url)),
  });
const results = [];
const stats = { responseCalls: 0, responseChangedChoices: 0, decisions: 0, proved: 0 };
const started = performance.now();

try {
  for (let pair = 0; pair < pairs; pair++) {
    const outcomes = [];
    for (const side of [0, 1]) {
      const result = await simulateRound(seed + pair, Array(4).fill('observant'), policy.infer, {
        selectAction: async (plays, values, _style, context) => {
          const solved = publicEnding(context, plays, values, endgameCards);
          if (solved) {
            stats.proved++;
            return solved.index;
          }
          const requested = context.p % 2 === side ? testedStyle : opponentStyle;
          const style = requested === 'legacy-observant' ? 'observant' : requested;
          const original = selectProfileAction(plays, values, style, context);
          if (requested === 'legacy-observant' || !usesResponseModel(style) || !plays[original])
            return original;
          stats.decisions++;
          const options = responseCandidates(plays, values, context, original);
          if (!options) return original;
          const { indices, recipient } = options;
          const features = indices.map((index) =>
            Array.from(encodeResponse(context, plays[index], recipient)),
          );
          const predictions = await response.infer({ features });
          stats.responseCalls++;
          const risks = plays.map(() => null);
          indices.forEach((index, offset) => (risks[index] = predictions[offset]));
          const chosen = selectProfileAction(plays, values, style, {
            ...context,
            responseRisks: risks,
          });
          if (chosen !== original) stats.responseChangedChoices++;
          return chosen;
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
      points: outcomes.reduce((total, round) => total + round.points, 0),
    });
    if ((pair + 1) % 20 === 0)
      console.log(
        `${pair + 1}/${pairs} pairs · ${Math.round((performance.now() - started) / 1000)}s`,
      );
  }
  const rounds = results.flatMap((result) => result.outcomes),
    wins = rounds.filter((round) => round.points > 0).length;
  const mean = results.reduce((total, result) => total + result.points, 0) / pairs;
  const variance =
    results.reduce((total, result) => total + (result.points - mean) ** 2, 0) /
    Math.max(1, pairs - 1);
  const report = {
    testedStyle,
    opponentStyle,
    endgameCards,
    pairs,
    seed,
    rounds: rounds.length,
    wins,
    losses: rounds.length - wins,
    winRate: wins / rounds.length,
    pairedPointsMean: mean,
    pairedPoints95CI: [
      mean - 1.96 * Math.sqrt(variance / pairs),
      mean + 1.96 * Math.sqrt(variance / pairs),
    ],
    stats,
    elapsedSeconds: (performance.now() - started) / 1000,
    results,
  };
  writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, results: undefined }));
} finally {
  policy.close();
  response.close();
}
