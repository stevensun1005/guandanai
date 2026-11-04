/** Champion gate: challenger vs champion on paired fresh seeds, greedy play, stopped by SPRT. */
import { existsSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { playMatch } from '../lib/match-rollout.mjs';
import {
  GATE_SEED_BASE,
  GATE_SEED_SPAN,
  createModelPool,
  matchScore,
  option,
  readJSON,
  runPaths,
  sha256,
  sprt,
  writeJSON,
} from './lib.mjs';

const paths = runPaths(option('run', 'work/continuous/main'));
const challenger = option('challenger', '');
const champion = option('champion', '');
const index = Number(option('index', '0'));
const output = option('output', '');
const config = readJSON(paths.config);
const settings = { ...config.gate, ...JSON.parse(option('settings', '{}')) };
if (!challenger || !champion || !output || !Number.isInteger(index) || index < 0)
  throw Error('Usage: gate.mjs --run --challenger --champion --index --output');
const firstSeed = GATE_SEED_BASE + index * GATE_SEED_SPAN;
if (firstSeed + settings.maxPairs > 2 ** 32 || settings.maxPairs > GATE_SEED_SPAN)
  throw Error('Gate seed range exhausted');

const pool = await createModelPool(ort, { threads: 1 });
const infer = (file) => (state) => pool.values(file, state);
const report = {
  schema: 1,
  purpose: 'development gate (not a held-out acceptance)',
  protocol:
    'Greedy network play, no web styles/endgame; each seed played twice with sides swapped; draws 0.5',
  challenger: { file: challenger, sha256: sha256(challenger) },
  champion: { file: champion, sha256: sha256(champion) },
  settings,
  firstSeed,
  status: 'running',
  pairs: [],
  wins: 0,
  losses: 0,
  draws: 0,
  test: null,
  startedAt: new Date().toISOString(),
};

for (let pair = 0; pair < settings.maxPairs && !existsSync(paths.stop); pair++) {
  const seed = firstSeed + pair;
  const scores = [];
  for (const team of [0, 1]) {
    const result = await playMatch({
      seed,
      team,
      mode: 'snapshot',
      evaluate: true,
      infer: infer(challenger),
      snapshotInfer: infer(champion),
      decide: () => {
        throw Error('Gate never records training decisions');
      },
    });
    const score = matchScore(result.winner, team);
    scores.push(score);
    if (score === 1) report.wins++;
    else if (score === 0) report.losses++;
    else report.draws++;
  }
  report.pairs.push({ seed, scores });
  report.test = sprt(
    report.pairs.map((p) => (p.scores[0] + p.scores[1]) / 2),
    settings,
  );
  writeJSON(output, report);
  if (report.pairs.length >= settings.minPairs && report.test.decision) break;
}
report.status = existsSync(paths.stop) ? 'stopped' : 'complete';
report.decision =
  report.status !== 'complete'
    ? null
    : report.test?.decision === 'accept'
      ? 'accept'
      : report.test?.decision === 'reject'
        ? 'reject'
        : 'inconclusive';
report.finishedAt = new Date().toISOString();
writeJSON(output, report);
await pool.close();
