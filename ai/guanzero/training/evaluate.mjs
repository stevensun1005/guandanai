import { copyFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { freezeChampion } from './champion.mjs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { DEFAULT_OPPONENTS, LEGACY_TWO_OPPONENTS, opponentDefinition } from './opponents.mjs';
import { playMatch } from '../../shared/simulation/match-rollout.mjs';
import { seededRandom } from '../../shared/simulation/simulation.mjs';
import { createModelPool } from '../../danMCai/training/continuous/lib.mjs';
import {
  paths,
  readJSON,
  writeJSON,
  option,
  evalSeed,
  sha256,
  createInference,
  ROOT,
} from './lib.mjs';
export function metrics(clusters) {
  const all = clusters.flat(),
    rounds = all.flatMap((m) =>
      m.history.map((h) => ({
        win: h.team === m.neuralTeam,
        points: (h.team === m.neuralTeam ? 1 : -1) * h.up,
      })),
    );
  const wins = all.filter((m) => m.winner === m.neuralTeam).length,
    draws = all.filter((m) => m.winner === null).length;
  return {
    matches: all.length,
    wins,
    losses: all.length - wins - draws,
    draws,
    matchWinRate: wins / all.length,
    matchScore: (wins + draws / 2) / all.length,
    rounds: rounds.length,
    roundWins: rounds.filter((r) => r.win).length,
    roundWinRate: rounds.filter((r) => r.win).length / rounds.length,
    averageUpgradePoints: rounds.reduce((s, r) => s + r.points, 0) / rounds.length,
  };
}
export function intervals(clusters, iterations = 2000) {
  if (clusters.length < 2) return null;
  const random = seededRandom(3700000000),
    keys = ['matchWinRate', 'matchScore', 'roundWinRate', 'averageUpgradePoints'];
  const draws = Object.fromEntries(keys.map((k) => [k, []]));
  for (let i = 0; i < iterations; i++) {
    const sampled = Array.from(
      { length: clusters.length },
      () => clusters[Math.floor(random() * clusters.length)],
    );
    const m = metrics(sampled);
    for (const k of keys) draws[k].push(m[k]);
  }
  return Object.fromEntries(
    keys.map((k) => {
      const d = draws[k].sort((a, b) => a - b);
      return [k, [d[Math.floor(0.025 * iterations)], d[Math.floor(0.975 * iterations)]]];
    }),
  );
}
export function resumeClusters(previous, report, opponent) {
  if (!previous) return [];
  if (
    previous.protocolSHA256 !== report.protocolSHA256 ||
    previous.opponent !== opponent ||
    previous.pairs !== report.pairs ||
    previous.modelSHA256 !== report.modelSHA256 ||
    previous.seedStart !== report.seedStart ||
    !Array.isArray(previous.clusters) ||
    previous.completedPairs !== previous.clusters.length ||
    previous.completedPairs > report.pairs
  )
    throw Error('Mismatched evaluation progress; preserving evidence');
  for (const [i, pair] of previous.clusters.entries())
    if (
      pair.length !== 2 ||
      pair.some((m, t) => m.seed !== report.seedStart + i || m.neuralTeam !== t)
    )
      throw Error('Invalid swapped-seat evaluation progress');
  return previous.clusters;
}
export async function evaluate({
  run,
  model,
  index,
  pairs = 250,
  subdirectory = '',
  outputDirectory = null,
  champion = null,
  resume = false,
  opponents = LEGACY_TWO_OPPONENTS,
}) {
  if (
    !Array.isArray(opponents) ||
    !opponents.length ||
    new Set(opponents).size !== opponents.length
  )
    throw Error('Choose distinct GuanZero evaluation opponents');
  const definitions = opponents.map(opponentDefinition);
  if (opponents.includes('reason'))
    throw Error(
      'Reason requires a registered suite and evaluation-worker.mjs; never substitute self-play',
    );
  if (subdirectory && !/^[a-z][a-z0-9-]*$/.test(subdirectory))
    throw Error('Invalid evaluation subdirectory');
  const p = paths(run),
    start = evalSeed(index, pairs),
    folder = outputDirectory
      ? resolve(outputDirectory)
      : join(p.eval, `block-${String(index).padStart(4, '0')}`, subdirectory);
  if (!resolve(folder).startsWith(resolve(p.eval) + sep))
    throw Error('Evaluation output must stay inside run/eval');
  if (!resume && existsSync(join(folder, 'report.json')))
    throw Error('Evaluation report already exists');
  mkdirSync(folder, { recursive: true });
  const pinned = join(folder, 'model.onnx');
  if (existsSync(pinned)) {
    if (!resume || sha256(pinned) !== sha256(resolve(model)))
      throw Error('Frozen evaluation model mismatch');
  } else copyFileSync(resolve(model), pinned);
  if (opponents.includes('champion')) {
    if (!champion) champion = await freezeChampion(folder);
    if (sha256(champion.file) !== champion.metadata.modelSHA256)
      throw Error('Frozen champion SHA mismatch');
    Object.assign(
      definitions.find((d) => d.id === 'champion'),
      champion.metadata,
    );
  }
  const config = readJSON(join(p.root, 'config.json'), {});
  const report = {
    purpose: 'development',
    seedStart: start,
    seedEnd: start + pairs - 1,
    pairs,
    index,
    modelSHA256: sha256(pinned),
    sourceSHA256: {
      ...Object.fromEntries(
        [
          'ai/shared/simulation/match-rollout.mjs',
          'ai/shared/simulation/match-simulation.mjs',
          'ai/shared/simulation/rule-baseline.mjs',
          'ai/shared/simulation/simulation.mjs',
          'web/src/ai/hand-value.js',
          'web/src/ai/rule-policy.js',
          'web/src/ai/candidates.js',
          'web/src/ai/observation.js',
          'web/src/hand/hints.js',
          'web/src/core/cards.js',
          'web/src/core/combinations.js',
          'web/src/core/moves.js',
          'web/src/core/match.js',
          'web/src/core/tribute.js',
          ...readdirSync(join(ROOT, 'web/src/rule-bot'))
            .filter((name) => /\.(mjs|js)$/.test(name))
            .map((name) => 'web/src/rule-bot/' + name),
        ].map((name) => [name, sha256(join(ROOT, name))]),
      ),
      ...Object.fromEntries(
        readdirSync(join(ROOT, 'ai/guanzero/training'))
          .filter((n) => /\.(mjs|py)$/.test(n))
          .map((n) => ['ai/guanzero/training/' + n, sha256(join(ROOT, 'ai/guanzero/training', n))]),
      ),
      'web/src/ai/encoding.mjs': sha256(join(ROOT, 'web/src/ai/encoding.mjs')),
    },
    p0SHA256: sha256(join(ROOT, 'ai/danMCai/models/baseline/policy.onnx')),
    opponents: Object.fromEntries(definitions.map((definition) => [definition.id, definition])),
    trainingSourceSHA256: config.sourceSHA256 || {},
    exploration: 0,
    policy: 'greedy-network-only-no-web-styles-or-endgame',
    rules: { tribute: true, from: 2, through: 'A', aFail: 'draw' },
    intervalMethod: '95% paired-seed cluster percentile bootstrap, 2000 draws',
    results: {},
  };
  report.protocolSHA256 = createHash('sha256')
    .update(JSON.stringify({ ...report, results: undefined }))
    .digest('hex');
  const previous = readJSON(join(folder, 'report.json'), null);
  if (resume && previous) {
    if (previous.protocolSHA256 !== report.protocolSHA256)
      throw Error('Evaluation protocol changed; preserving existing report');
    if (previous.completedAt) return previous;
    report.results = previous.results;
  }
  const inference = await createInference(),
    pool = await createModelPool(ort, { threads: 1 });
  try {
    await inference.load(pinned);
    for (const definition of definitions) {
      const opponent = definition.id;
      if (report.results[opponent]) continue;
      const progressFile = join(folder, `${opponent}-progress.json`);
      const clusters = resume ? resumeClusters(readJSON(progressFile, null), report, opponent) : [];
      for (let i = clusters.length; i < pairs; i++) {
        const pair = [];
        for (const team of [0, 1]) {
          const random = seededRandom((start + i) ^ 0x6a09e667);
          pair.push(
            await playMatch({
              seed: start + i,
              team,
              mode: definition.mode,
              ruleVersion: definition.ruleVersion,
              evaluate: true,
              infer: (state) => inference.values(state),
              snapshotInfer:
                opponent === 'p0' || opponent === 'champion'
                  ? (state) =>
                      pool.values(
                        opponent === 'champion'
                          ? champion.file
                          : join(ROOT, 'ai/danMCai/models/baseline/policy.onnx'),
                        state,
                      )
                  : (state) => Float32Array.from(state.actions, () => random()),
            }),
          );
        }
        clusters.push(pair);
        writeJSON(progressFile, {
          protocolSHA256: report.protocolSHA256,
          opponent,
          completedPairs: clusters.length,
          pairs,
          modelSHA256: report.modelSHA256,
          opponentSHA256: definition.modelSHA256,
          seedStart: start,
          updatedAt: new Date().toISOString(),
          metrics: metrics(clusters),
          clusters,
        });
      }
      report.results[opponent] = {
        ...metrics(clusters),
        confidence95: intervals(clusters),
        clusters,
      };
      writeJSON(join(folder, 'report.json'), report);
      console.log(JSON.stringify({ kind: 'evaluation', opponent, ...metrics(clusters) }));
    }
  } finally {
    await inference.close();
    await pool.close();
  }
  report.completedAt = new Date().toISOString();
  writeJSON(join(folder, 'report.json'), report);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const run = option('run', 'ai/guanzero/runs/guanzero-adp'),
    p = paths(run);
  const indexFile = join(p.eval, 'next.json');
  const index = readJSON(indexFile, { index: 0 }).index;
  writeJSON(indexFile, { index: index + 1 });
  const latest = readJSON(join(p.models, 'latest.json'));
  await evaluate({
    run,
    model: option('model', join(p.models, latest.file)),
    index,
    pairs: Number(option('pairs', '250')),
    opponents: option('opponents', LEGACY_TWO_OPPONENTS.join(',')).split(','),
  });
}
