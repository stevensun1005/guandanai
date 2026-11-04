/** Fixed-opening reviews with fresh continuations; private current hands go only to the training critic. */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { playMatch } from './lib/match-rollout.mjs';
import { createPolicyInference } from './lib/policy-inference.mjs';

const option = (name, fallback) =>
  process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const plan = JSON.parse(readFileSync(option('plan', ''), 'utf8'));
const output = resolve(option('output', 'work/learning/team/data'));
const model = resolve(option('model', ''));
if (
  !plan.length ||
  plan.some(
    (x) =>
      !Number.isInteger(x.problemSeed) ||
      !Number.isInteger(x.continuationSeed) ||
      ![0, 1].includes(x.team) ||
      !['rule', 'self', 'snapshot'].includes(x.mode),
  )
)
  throw Error('Invalid team collection plan');
mkdirSync(output, { recursive: true });
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const opponent = option('opponent-model', '');
const engine = createPolicyInference({
  script: resolve('scripts/team_learning.py'),
  env: { PPO_ACTOR: undefined },
});
const past = opponent
  ? createPolicyInference({
      script: resolve('scripts/match_learning.py'),
      env: { PPO_ACTOR: undefined, GUANDAN_POLICY_MODEL: resolve(opponent) },
    })
  : null;
const report = {
  status: 'collecting',
  games: plan.length,
  completedGames: 0,
  seed: Number(option('seed', '61000104')),
  wins: 0,
  draws: 0,
  rounds: 0,
  decisions: 0,
  afterFirstOutDecisions: 0,
  reviewMatches: 0,
  planSHA256: hash(option('plan', '')),
  opponentSHA256: opponent ? hash(opponent) : null,
  sourceSHA256: {
    'scripts/collect-team.mjs': hash('scripts/collect-team.mjs'),
    'scripts/lib/match-rollout.mjs': hash('scripts/lib/match-rollout.mjs'),
  },
};
const save = () => writeFileSync(`${output}/rollout.json`, JSON.stringify(report, null, 2));
try {
  await engine.request({
    op: 'init',
    model,
    output,
    seed: report.seed,
    options: { games: plan.length, planSHA256: report.planSHA256 },
  });
  for (let episode = 0; episode < plan.length; episode++) {
    const job = plan[episode];
    const result = await playMatch({
      seed: job.continuationSeed,
      initialDealSeed: job.problemSeed,
      team: job.team,
      mode: job.mode,
      trainingCritic: true,
      decide: (state, criticOnly) =>
        engine.request({ op: 'decide', state, criticOnly, episode, seat: state.p }),
      snapshotInfer: past?.infer,
    });
    await engine.request({ op: 'finish', episode, winner: result.winner });
    appendFileSync(
      `${output}/matches.jsonl`,
      JSON.stringify({ ...result, episode, problemSeed: job.problemSeed, review: !!job.review }) +
        '\n',
    );
    report.completedGames++;
    report.wins += Number(result.winner === job.team);
    report.draws += Number(result.winner === null);
    report.reviewMatches += Number(!!job.review);
    for (const k of ['rounds', 'decisions', 'afterFirstOutDecisions']) report[k] += result.stats[k];
    save();
    console.log(
      JSON.stringify({
        matches: report.completedGames,
        rounds: report.rounds,
        reviews: report.reviewMatches,
      }),
    );
  }
  report.status = 'complete';
  save();
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  save();
  throw error;
} finally {
  engine.close();
  past?.close();
}
