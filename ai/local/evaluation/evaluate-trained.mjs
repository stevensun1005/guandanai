import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidates } from '../../../web/src/ai/candidates.js';
import { analyze, beats } from '../../../web/src/core/combinations.js';
import { policyState, decisionContext } from '../../../web/src/ai/observation.js';
import { selectProfileAction } from '../../../web/src/ai/profiles.js';
import { endgameRequest, solvePublicEndgame } from '../../../web/src/ai/endgame.js';
import { createRound, advanceRound } from '../../shared/simulation/simulation.mjs';
import { createPolicyInference } from '../../shared/simulation/policy-inference.mjs';
import {
  createRuleBaseline,
  RULE_OPPONENT_VERSION,
} from '../../shared/simulation/rule-baseline.mjs';

export async function playEvaluationRound(
  seed,
  testedSide,
  infer,
  opponent,
  endgameCards = 0,
  ruleVersion = 'original',
) {
  const game = createRound(seed);
  const rule =
    opponent === 'rule' ? createRuleBaseline(seed ^ 0x6a09e667, { version: ruleVersion }) : null;
  const stats = { modelDecisions: 0, ruleDecisions: 0, endgameProofs: 0, candidateCount: 0 };
  for (let turns = 0; turns < 1000; turns++) {
    const player = game.turn;
    let play;
    if (player % 2 !== testedSide && rule) {
      play = rule(game, player);
      stats.ruleDecisions++;
    } else {
      const plays = candidates(game.hands[player], game.L, game.trick?.play);
      if (!plays.length) throw Error('No legal actions');
      let chosen = plays.findIndex((item) => item?.cards.length === game.hands[player].length);
      if (chosen < 0 && plays.length === 1) chosen = 0;
      if (chosen < 0) {
        const state = policyState(game, player, 0, plays);
        state.context = decisionContext(game, player);
        state.trick = state.context.trick;
        state.actionShapes = plays.map(
          (item) =>
            item && {
              type: item.type,
              value: item.value,
              n: item.n,
              wu: item.wu,
            },
        );
        const engine = player % 2 === testedSide ? infer : opponent;
        const values = await engine(state);
        chosen = selectProfileAction(plays, values, 'balanced', decisionContext(game, player));
        stats.modelDecisions++;
        stats.candidateCount += plays.length;
        if (
          endgameCards &&
          game.hands.reduce((sum, hand) => sum + hand.length, 0) <= endgameCards
        ) {
          state.endgame = endgameRequest(game, player, plays);
          const solved = solvePublicEndgame(state, values);
          if (solved) {
            chosen = solved.index;
            stats.endgameProofs++;
          }
        }
      }
      play = plays[chosen];
    }
    if (
      play &&
      (!beats(play, game.trick?.play) ||
        !analyze(play.cards, game.L).some(
          (shape) => shape.type === play.type && shape.value === play.value && shape.n === play.n,
        ))
    )
      throw Error(`Invalid action: seed ${seed}, seat ${player}, turn ${turns}`);
    const result = advanceRound(game, play);
    if (result) return { ...result, turns: turns + 1, stats };
  }
  throw Error(`Round exceeded 1000 turns: ${seed}`);
}

export function clusterEstimate(values, bounds = null) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) return { mean, confidence95: null };
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const error = 1.96 * Math.sqrt(variance / values.length);
  return {
    mean,
    confidence95: bounds
      ? [Math.max(bounds[0], mean - error), Math.min(bounds[1], mean + error)]
      : [mean - error, mean + error],
  };
}

async function main() {
  const option = (name, fallback) =>
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
  const pairs = Number(option('pairs', '100'));
  const seed = Number(option('seed', '20700104'));
  const endgameCards = Number(option('endgame-cards', '0'));
  const opponentType = option('opponent', 'rule');
  const ruleVersion = option('rule-version', RULE_OPPONENT_VERSION);
  if (!['original', RULE_OPPONENT_VERSION].includes(ruleVersion))
    throw Error('Unknown rule opponent');
  const output = option('output', 'web/artifacts/validation/trained');
  if (!Number.isInteger(pairs) || pairs < 2 || pairs > 100000) throw Error('Invalid pair count');
  if (!Number.isInteger(seed) || seed < 0) throw Error('Invalid seed');
  if (![0, 16, 24].includes(endgameCards)) throw Error('Use endgame limit 0, 16 or 24');
  if (!['rule', 'policy'].includes(opponentType)) throw Error('Unknown opponent');
  const script = option('inference-script', resolve('ai/local/training/eval_inference.py'));
  const opponentScript = option('opponent-script', resolve('ai/local/training/eval_inference.py'));
  const model = option('model', 'ai/local/models/baseline/policy.onnx');
  const opponentModel = option('opponent-model', 'ai/local/models/baseline/policy.onnx');
  const sha = async (path) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  const sourceFiles = [
    'web/src/ai/rule-policy.js',
    'web/src/ai/hand-value.js',
    'web/src/hand/arrangement.js',
    'web/src/hand/hints.js',
    'web/src/core/moves.js',
    'web/src/core/cards.js',
    'web/src/core/combinations.js',
    'web/src/ai/candidates.js',
    'web/src/ai/observation.js',
    'web/src/ai/profiles.js',
    'web/src/rule-bot/settings.js',
    'web/src/rule-bot/arrangement.js',
    'web/src/rule-bot/strategy.js',
    'ai/shared/simulation/simulation.mjs',
    'ai/shared/simulation/rule-baseline.mjs',
    'ai/local/evaluation/evaluate-trained.mjs',
  ];
  const provenance = {
    testedModel: { path: model, sha256: await sha(model) },
    inferenceScript: { path: script, sha256: await sha(script) },
    opponentModel:
      opponentType === 'policy' ? { path: opponentModel, sha256: await sha(opponentModel) } : null,
    sourceSHA256: Object.fromEntries(
      await Promise.all(sourceFiles.map(async (path) => [path, await sha(path)])),
    ),
  };
  await mkdir(output, { recursive: true });
  const tested = createPolicyInference({
    script,
    python: option('python', 'python'),
    env: { GUANDAN_POLICY_MODEL: resolve(model) },
  });
  const other =
    opponentType === 'policy'
      ? createPolicyInference({
          script: opponentScript,
          python: option('python', 'python'),
          env: { GUANDAN_POLICY_MODEL: resolve(opponentModel) },
        })
      : null;
  const results = [];
  const started = performance.now();
  try {
    for (let pair = 0; pair < pairs; pair++) {
      const outcomes = [];
      for (const side of [0, 1]) {
        const result = await playEvaluationRound(
          seed + pair,
          side,
          tested.infer,
          other?.infer || 'rule',
          endgameCards,
          ruleVersion,
        );
        outcomes.push({
          testedSide: side,
          ...result,
          won: result.winner === side,
          signedPoints: (result.winner === side ? 1 : -1) * result.points,
        });
      }
      results.push({ seed: seed + pair, outcomes });
      if ((pair + 1) % 10 === 0)
        console.log(
          `${pair + 1}/${pairs} pairs; elapsed ${Math.round((performance.now() - started) / 1000)}s`,
        );
    }
    const outcomes = results.flatMap((result) => result.outcomes);
    const wins = outcomes.filter((result) => result.won).length;
    const win = clusterEstimate(
      results.map((result) => result.outcomes.filter((round) => round.won).length / 2),
      [0, 1],
    );
    const points = clusterEstimate(
      results.map(
        (result) => result.outcomes.reduce((sum, round) => sum + round.signedPoints, 0) / 2,
      ),
    );
    const summary = {
      protocol:
        'Two tested-policy teammates versus two frozen opponent teammates; same uniform deal, level and first player repeated after swapping tested team; independent rounds without tribute.',
      winDefinition: 'Team containing the first player to empty their hand.',
      confidenceMethod:
        'Normal interval on per-deal paired means; each independent deal is one cluster.',
      opponent: opponentType,
      ruleVersion: opponentType === 'rule' ? ruleVersion : null,
      seed,
      pairs,
      rounds: pairs * 2,
      wins,
      losses: pairs * 2 - wins,
      winRate: win.mean,
      winRate95CI: win.confidence95,
      signedPointsPerRound: points.mean,
      signedPoints95CI: points.confidence95,
      target: 0.8,
      targetMetByEstimate: win.mean >= 0.8,
      targetMetByLower95Bound: win.confidence95[0] >= 0.8,
      endgameCards,
      elapsedSeconds: (performance.now() - started) / 1000,
      ...provenance,
    };
    await writeFile(`${output}/results.json`, JSON.stringify(results));
    await writeFile(`${output}/summary.json`, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  } finally {
    tested.close();
    other?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
