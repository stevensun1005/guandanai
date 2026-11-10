/** Brain-enabled Clint, deliberately distinct from historical rules-only evaluations. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createWebClint, exchangeRecords } from '../../shared/simulation/web-clint.mjs';
import { createRound } from '../../shared/simulation/simulation.mjs';
import { playMatch } from '../../shared/simulation/match-rollout.mjs';
import { BRAIN, BRAIN_STAT } from '../../../web/src/rule-bot/endgame-brain.mjs';
import { WEB_BRAIN } from '../../../web/src/rule-bot/runtime.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { metrics, intervals, resumeClusters } from './evaluate.mjs';
import { sourceClosure } from './source-closure.mjs';
import { MIXED_PANEL, suitePairs } from './opponents.mjs';
import { ROOT, readJSON, writeJSON, sha256, createInference } from './lib.mjs';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function freezeClint() {
  const identity = {
    id: 'clint',
    name: 'Clint规则机器人（含残局大脑）',
    version: 'rules-v2-brain-v1',
    mode: 'self',
    policy: 'web-rules-and-public-information-endgame-brain',
    brain: { ...BRAIN, ...WEB_BRAIN },
    random: 'seededRandom(roundSeed ^ 0x6a09e667)',
    sourceSHA256: sourceClosure(fileURLToPath(import.meta.url), ROOT),
  };
  return { ...identity, evaluationSHA256: digest(identity) };
}
export function verifyClintMetadata(clint) {
  const { evaluationSHA256, ...identity } = clint;
  assert.equal(evaluationSHA256, digest(identity));
  assert.equal(clint.id, 'clint');
  assert.equal(clint.mode, 'self');
  assert.equal(clint.version, 'rules-v2-brain-v1');
  assert.deepEqual(clint.brain, { ...BRAIN, ...WEB_BRAIN });
}
export function clintProtocolDigest(report) {
  const { results, protocolSHA256, completedAt, brainStats, ...identity } = report;
  return digest(identity);
}
export async function clintMatch({ seed, team, inference, play = playMatch }) {
  const games = new WeakMap(),
    before = { ...BRAIN_STAT };
  let decisions = 0,
    maxDecisionMs = 0;
  const result = await play({
    seed,
    team,
    mode: 'self',
    evaluate: true,
    tablePolicy: async (game, p) => {
      let clint = games.get(game);
      if (!clint) {
        const roundSeed = (Math.imul(seed, 1009) + game.round - 1) >>> 0;
        Object.assign(game, exchangeRecords(createRound(roundSeed).hands, game, game.prevOut));
        game.tok = seed + ':' + team;
        clint = createWebClint(roundSeed ^ 0x6a09e667);
        games.set(game, clint);
      }
      if (p % 2 !== team) {
        decisions++;
        const start = performance.now();
        const move = clint(game, p);
        maxDecisionMs = Math.max(maxDecisionMs, performance.now() - start);
        return move;
      }
      const plays = candidates(game.hands[p], game.L, game.trick?.play);
      const values = await inference.values(policyState(game, p, 0, plays));
      assert.equal(values.length, plays.length);
      assert.ok(values.every(Number.isFinite));
      return plays[values.reduce((best, value, i) => (value > values[best] ? i : best), 0)];
    },
  });
  result.clintStats = {
    decisions,
    maxDecisionMs,
    ...Object.fromEntries(Object.keys(BRAIN_STAT).map((k) => [k, BRAIN_STAT[k] - before[k]])),
  };
  return result;
}
export async function evaluateClint({ run, folder, plan }) {
  assert.equal(plan.opponentPanel, MIXED_PANEL);
  verifyClintMetadata(plan.clint);
  assert.deepEqual(plan.clint, freezeClint(), 'Clint source changed');
  assert.equal(sha256(join(folder, 'model.onnx')), plan.modelSHA256);
  const pairs = suitePairs(plan, 'clint'),
    out = join(folder, 'clint');
  mkdirSync(out, { recursive: true });
  const report = {
    purpose: 'development',
    seedStart: plan.seedStart,
    seedEnd: plan.seedStart + pairs - 1,
    pairs,
    index: plan.index,
    modelSHA256: plan.modelSHA256,
    sourceSHA256: plan.clint.sourceSHA256,
    opponents: { clint: plan.clint },
    opponentPanel: plan.opponentPanel,
    exploration: 0,
    policy: 'guanzero-greedy-vs-web-clint-with-endgame-brain',
    rules: { tribute: true, from: 2, through: 'A', aFail: 'draw' },
    intervalMethod: '95% paired-seed cluster percentile bootstrap, 2000 draws',
    results: {},
  };
  report.protocolSHA256 = clintProtocolDigest(report);
  const previous = readJSON(join(out, 'report.json'), null);
  if (previous) {
    assert.equal(previous.protocolSHA256, report.protocolSHA256);
    if (previous.completedAt) return previous;
  }
  const file = join(out, 'clint-progress.json'),
    progress = readJSON(file, null);
  if (progress) assert.equal(progress.evaluationSHA256, plan.clint.evaluationSHA256);
  const clusters = resumeClusters(progress, report, 'clint'),
    inference = await createInference();
  const stats = () =>
    clusters.flat().reduce((a, m) => {
      for (const [k, v] of Object.entries(m.clintStats))
        a[k] = k === 'maxDecisionMs' ? Math.max(a[k] || 0, v) : (a[k] || 0) + v;
      return a;
    }, {});
  try {
    await inference.load(join(folder, 'model.onnx'));
    for (let i = clusters.length; i < pairs; i++) {
      const pair = [];
      for (const team of [0, 1])
        pair.push(await clintMatch({ seed: plan.seedStart + i, team, inference }));
      clusters.push(pair);
      writeJSON(file, {
        protocolSHA256: report.protocolSHA256,
        evaluationSHA256: plan.clint.evaluationSHA256,
        opponent: 'clint',
        completedPairs: clusters.length,
        pairs,
        modelSHA256: plan.modelSHA256,
        opponentSHA256: plan.clint.evaluationSHA256,
        seedStart: plan.seedStart,
        updatedAt: new Date().toISOString(),
        metrics: metrics(clusters),
        brainStats: stats(),
        clusters,
      });
    }
    report.results.clint = { ...metrics(clusters), confidence95: intervals(clusters), clusters };
    report.brainStats = stats();
    report.completedAt = new Date().toISOString();
    writeJSON(join(out, 'report.json'), report);
    return report;
  } finally {
    await inference.close();
  }
}
