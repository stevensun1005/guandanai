import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPolicyInference } from '../../../shared/simulation/policy-inference.mjs';
import { collectPolicyEpisode } from '../../../shared/simulation/policy-rollout.mjs';
import { createRuleBaseline } from '../../../shared/simulation/rule-baseline.mjs';

const option = (name, fallback) =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ??
  fallback;
const integer = (name, fallback, minimum) => {
  const value = Number(option(name, fallback));
  if (!Number.isSafeInteger(value) || value < minimum) throw Error(`Invalid --${name}`);
  return value;
};
const games = integer('games', '5000', 1);
const seed = integer('seed', '21100104', 0);
const epsilon = Number(option('epsilon', '0.08'));
const temperature = Number(option('temperature', '0.08'));
const opponent = option('opponent', 'mixed');
if (!['self', 'rule', 'mixed'].includes(opponent)) throw Error('Invalid --opponent');
if (!Number.isFinite(epsilon) || epsilon < 0 || epsilon > 1) throw Error('Invalid --epsilon');
if (!Number.isFinite(temperature) || temperature < 0) throw Error('Invalid --temperature');
const output = resolve(option('output', 'ai/danMCai/data/generated/policy-dataset'));
const model = resolve(option('model', 'ai/danMCai/models/baseline/policy.onnx'));
const script = resolve(option('inference-script', 'ai/danMCai/training/policy_learning.py'));
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceFiles = [
  'ai/danMCai/data/tools/collect-policy.mjs',
  'ai/shared/simulation/policy-rollout.mjs',
  'ai/shared/simulation/simulation.mjs',
  'ai/shared/simulation/rule-baseline.mjs',
  'web/src/ai/rule-policy.js',
  'web/src/ai/hand-value.js',
  'web/src/hand/arrangement.js',
  'web/src/hand/hints.js',
  'web/src/ai/observation.js',
  'web/src/ai/candidates.js',
  'web/src/core/cards.js',
  'web/src/core/combinations.js',
  'web/src/core/moves.js',
];
const manifest = {
  schema: 1,
  status: 'running',
  games,
  completedGames: 0,
  seed,
  seedRange: [seed, seed + games - 1],
  opponent,
  model,
  modelSHA256: hash(model),
  inferenceScriptSHA256: hash(script),
  sourceSHA256: Object.fromEntries(sourceFiles.map((file) => [file, hash(file)])),
  exploration: { epsilon, temperature },
  pairing: 'Each episode has an independent shuffled deal and random level/first seat.',
  schedule:
    opponent === 'mixed'
      ? 'episode % 4: self, self, neural team 0 vs rules, neural team 1 vs rules'
      : opponent === 'rule'
        ? 'neural team = episode % 2'
        : 'all four seats use the collection policy',
  information: 'Own hand, public history and remaining counts; no hidden opponent cards.',
  endgameSearch: false,
  forcedChoicesRecorded: false,
  decisions: 0,
  ruleActions: 0,
  selfPlayGames: 0,
  ruleGames: 0,
  neuralWinsAgainstRules: 0,
  startedUTC: new Date().toISOString(),
};
const manifestFile = resolve(output, 'rollout.json');
mkdirSync(output, { recursive: true });
const results = openSync(resolve(output, 'episodes.jsonl'), 'wx');
const save = () => writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
const engine = createPolicyInference({ script });
const started = performance.now();
try {
  save();
  await engine.request({
    op: 'init',
    output,
    seed,
    model,
    exploration: { epsilon, temperature },
    options: { games, opponent },
  });
  for (let episode = 0; episode < games; episode++) {
    const neuralTeam =
      opponent === 'self' || (opponent === 'mixed' && episode % 4 < 2) ? null : episode % 2;
    const rule = neuralTeam === null ? null : createRuleBaseline(seed + episode + 100000000);
    const result = await collectPolicyEpisode({
      episode,
      seed: seed + episode,
      engine,
      ruleChoose: rule,
      neuralTeam,
      explore: { epsilon, temperature },
    });
    writeSync(results, JSON.stringify(result) + '\n');
    manifest.completedGames++;
    manifest.decisions += result.stats.decisions;
    manifest.ruleActions += result.stats.ruleActions;
    if (neuralTeam === null) manifest.selfPlayGames++;
    else {
      manifest.ruleGames++;
      if (result.winner === neuralTeam) manifest.neuralWinsAgainstRules++;
    }
    if ((episode + 1) % 100 === 0 || episode + 1 === games) {
      manifest.elapsedSeconds = (performance.now() - started) / 1000;
      save();
      console.log(
        `${episode + 1}/${games} rounds · ${manifest.decisions} decisions · ${Math.round(manifest.elapsedSeconds)}s`,
      );
    }
  }
  manifest.status = 'complete';
  manifest.finishedUTC = new Date().toISOString();
  manifest.elapsedSeconds = (performance.now() - started) / 1000;
  save();
  console.log(JSON.stringify(manifest));
} catch (error) {
  manifest.status = 'failed';
  manifest.error = error.message;
  manifest.elapsedSeconds = (performance.now() - started) / 1000;
  save();
  throw error;
} finally {
  closeSync(results);
  engine.close();
}
