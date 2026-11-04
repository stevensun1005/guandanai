import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { playMatch } from './lib/match-rollout.mjs';
import { createPolicyInference } from './lib/policy-inference.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const option = (name, fallback) =>
  process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const games = Number(option('matches', '64')),
  seed = Number(option('seed', '31000104'));
const output = resolve(option('output', 'work/learning/full-match/data'));
const evaluate = option('evaluate', '0') === '1';
const model = resolve(option('model', 'work/learning/ppo-k4-extended/cycle-12/model/ppo.npz'));
if (!Number.isInteger(games) || games < 1 || !Number.isInteger(seed))
  throw Error('Invalid match collection plan');
mkdirSync(output, { recursive: true });
const opponent = option('opponent', 'rule');
const snapshot = option('opponent-model', '');
if (!['rule', 'self', 'mixed'].includes(opponent)) throw Error('Invalid opponent mode');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const manifest = {
  status: 'collecting',
  games,
  completedGames: 0,
  seed,
  objective: 'Whole match from 2 through A; team victory, draw and defeat',
  evaluate,
  opponent,
  opponentModel: snapshot || null,
  opponentSHA256: snapshot ? hash(snapshot) : null,
  aFail: 'draw',
  tribute: true,
  rounds: 0,
  decisions: 0,
  afterFirstOutDecisions: 0,
  finishingChoices: 0,
  wins: 0,
  draws: 0,
  selfMatches: 0,
  snapshotMatches: 0,
  ruleMatches: 0,
  doubleWins: 0,
  doubleLosses: 0,
  isolatedFirsts: 0,
  sourceSHA256: Object.fromEntries(
    ['scripts/collect-matches.mjs', 'scripts/lib/match-rollout.mjs'].map((p) => [p, hash(p)]),
  ),
};
const save = () => writeFileSync(`${output}/rollout.json`, JSON.stringify(manifest, null, 2));
const engine = createPolicyInference({ script: resolve('scripts/match_learning.py') });
const past = snapshot
  ? createPolicyInference({
      script: resolve('scripts/match_learning.py'),
      env: { PPO_ACTOR: undefined, GUANDAN_POLICY_MODEL: resolve(snapshot) },
    })
  : null;
try {
  await engine.request({
    op: 'init',
    model,
    output,
    seed,
    options: {
      games,
      opponent,
      opponentSHA256: manifest.opponentSHA256,
      sourceSHA256: manifest.sourceSHA256,
    },
  });
  for (let episode = 0; episode < games; episode++) {
    const mode = evaluate
      ? 'rule'
      : opponent === 'mixed'
        ? ['self', snapshot ? 'snapshot' : 'self', 'rule'][episode % 3]
        : opponent;
    const matchSeed = seed + (evaluate ? Math.floor(episode / 2) : episode);
    const result = await playMatch({
      seed: matchSeed,
      team: episode % 2,
      mode,
      evaluate,
      decide: (state) => engine.request({ op: 'decide', episode, seat: state.p, state }),
      infer: engine.infer,
      snapshotInfer: past?.infer,
    });
    await engine.request({ op: 'finish', episode, winner: result.winner, points: 0 });
    appendFileSync(`${output}/matches.jsonl`, JSON.stringify({ episode, ...result }) + '\n');
    for (const key of [
      'rounds',
      'decisions',
      'afterFirstOutDecisions',
      'finishingChoices',
      'doubleWins',
      'doubleLosses',
      'isolatedFirsts',
    ])
      manifest[key] += result.stats[key];
    manifest[
      mode === 'self' ? 'selfMatches' : mode === 'snapshot' ? 'snapshotMatches' : 'ruleMatches'
    ]++;
    if (result.winner === null) manifest.draws++;
    else if (result.winner === episode % 2) manifest.wins++;
    manifest.completedGames++;
    save();
    console.log(
      JSON.stringify({
        matches: manifest.completedGames,
        mode,
        rounds: manifest.rounds,
        decisions: manifest.decisions,
        afterFirstOut: manifest.afterFirstOutDecisions,
      }),
    );
  }
  manifest.status = 'complete';
  save();
} catch (error) {
  manifest.status = 'failed';
  manifest.error = error.message;
  save();
  throw error;
} finally {
  engine.close();
  past?.close();
}
