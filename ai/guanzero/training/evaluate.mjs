import { copyFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { DEFAULT_OPPONENTS, opponentDefinition } from './opponents.mjs';
import { playMatch } from '../../shared/simulation/match-rollout.mjs';
import { seededRandom } from '../../shared/simulation/simulation.mjs';
import { createModelPool } from '../../local/training/continuous/lib.mjs';
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
export async function evaluate({
  run,
  model,
  index,
  pairs = 100,
  subdirectory = '',
  opponents = DEFAULT_OPPONENTS,
}) {
  if (
    !Array.isArray(opponents) ||
    !opponents.length ||
    new Set(opponents).size !== opponents.length
  )
    throw Error('Choose distinct GuanZero evaluation opponents');
  const definitions = opponents.map(opponentDefinition);
  if (subdirectory && !/^[a-z][a-z0-9-]*$/.test(subdirectory))
    throw Error('Invalid evaluation subdirectory');
  const p = paths(run),
    start = evalSeed(index, pairs),
    folder = join(p.eval, `block-${String(index).padStart(4, '0')}`, subdirectory);
  if (existsSync(join(folder, 'report.json'))) throw Error('Evaluation report already exists');
  mkdirSync(folder, { recursive: true });
  const pinned = join(folder, 'model.onnx');
  copyFileSync(resolve(model), pinned);
  const inference = await createInference(),
    pool = await createModelPool(ort, { threads: 1 });
  await inference.load(pinned);
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
    p0SHA256: sha256(join(ROOT, 'ai/local/models/baseline/policy.onnx')),
    opponents: Object.fromEntries(definitions.map((definition) => [definition.id, definition])),
    trainingSourceSHA256: config.sourceSHA256 || {},
    exploration: 0,
    intervalMethod: '95% paired-seed cluster percentile bootstrap, 2000 draws',
    results: {},
  };
  try {
    for (const definition of definitions) {
      const opponent = definition.id;
      const clusters = [];
      for (let i = 0; i < pairs; i++) {
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
                opponent === 'p0'
                  ? (state) =>
                      pool.values(join(ROOT, 'ai/local/models/baseline/policy.onnx'), state)
                  : (state) => Float32Array.from(state.actions, () => random()),
            }),
          );
        }
        clusters.push(pair);
        writeJSON(join(folder, `${opponent}-progress.json`), {
          completedPairs: clusters.length,
          pairs,
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
    pairs: Number(option('pairs', '100')),
    opponents: option('opponents', DEFAULT_OPPONENTS.join(',')).split(','),
  });
}
