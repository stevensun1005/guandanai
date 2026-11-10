/** Same complete-match/swapped-seed protocol, with the actual reasoning policy on opponent seats. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { playMatch } from '../../shared/simulation/match-rollout.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { metrics, intervals, resumeClusters } from './evaluate.mjs';
import {
  createReasonEngine,
  chooseReason,
  verifyFrozenReason,
  reasonProtocol,
  REASON_V2_MOVE,
} from './reason.mjs';
import { REASON_PANELS, REASON_V1_PANEL, suiteReasonProtocol, suitePairs } from './opponents.mjs';
import { readJSON, writeJSON, sha256, createInference } from './lib.mjs';

export function reasonProtocolDigest(report) {
  const { results, protocolSHA256, completedAt, searchStats, ...identity } = report;
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export async function reasonMatch({ seed, team, inference, engine, play = playMatch }) {
  return play({
    seed,
    team,
    mode: 'self',
    evaluate: true,
    tablePolicy: async (game, p) => {
      if (p % 2 !== team)
        return chooseReason(
          engine,
          game,
          p,
          (Math.imul(seed ^ 0x5b31a9d7, 1009) + game.round - 1) >>> 0,
        );
      const plays = candidates(game.hands[p], game.L, game.trick?.play);
      const values = await inference.values(policyState(game, p, 0, plays));
      return plays[values.reduce((best, value, i) => (value > values[best] ? i : best), 0)];
    },
  });
}
export async function evaluateReason({ run, folder, plan, stop = () => {} }) {
  assert.deepEqual(plan.opponents, ['clint', 'champion', 'reason']);
  assert.ok(REASON_PANELS.includes(plan.opponentPanel), 'Not a reason panel');
  assert.equal(
    reasonProtocol(plan.reason),
    suiteReasonProtocol(plan),
    'Reason protocol and panel differ',
  );
  const pairs = suitePairs(plan, 'reason');
  const v1 = plan.opponentPanel === REASON_V1_PANEL;
  assert.equal(sha256(join(folder, 'model.onnx')), plan.modelSHA256);
  verifyFrozenReason(folder, plan.reason, plan.champion, { sources: true });
  const out = join(folder, 'reason');
  mkdirSync(out, { recursive: true });
  const report = {
    purpose: 'development',
    seedStart: plan.seedStart,
    seedEnd: plan.seedStart + pairs - 1,
    pairs,
    index: plan.index,
    modelSHA256: plan.modelSHA256,
    sourceSHA256: plan.reason.sourceSHA256,
    opponents: { reason: plan.reason },
    exploration: 0,
    // The v1 report keeps its registered shape; later protocols name themselves in the digest.
    policy: v1
      ? 'guanzero-greedy-vs-frozen-danmcai-reason-desktop'
      : 'guanzero-greedy-vs-frozen-danmcai-reason-move-deadline-50s',
    ...(!v1 && { opponentPanel: plan.opponentPanel }),
    rules: { tribute: true, from: 2, through: 'A', aFail: 'draw' },
    intervalMethod: '95% paired-seed cluster percentile bootstrap, 2000 draws',
    results: {},
  };
  report.protocolSHA256 = createHash('sha256')
    .update(JSON.stringify({ ...report, results: undefined }))
    .digest('hex');
  const previous = readJSON(join(out, 'report.json'), null);
  if (previous) {
    assert.equal(previous.protocolSHA256, report.protocolSHA256, 'Reason report protocol changed');
    if (previous.completedAt) return previous;
  }
  const progressFile = join(out, 'reason-progress.json'),
    progress = readJSON(progressFile, null);
  if (progress) assert.equal(progress.evaluationSHA256, plan.reason.evaluationSHA256);
  const clusters = resumeClusters(progress, report, 'reason');
  const inference = await createInference(),
    engine = await createReasonEngine(folder, plan.reason, plan.champion);
  try {
    await inference.load(join(folder, 'model.onnx'));
    if (progress?.searchStats) Object.assign(engine.stats, progress.searchStats);
    for (let i = clusters.length; i < pairs; i++) {
      stop();
      const pair = [];
      for (const team of [0, 1])
        pair.push(await reasonMatch({ seed: plan.seedStart + i, team, inference, engine }));
      clusters.push(pair);
      writeJSON(progressFile, {
        protocolSHA256: report.protocolSHA256,
        evaluationSHA256: plan.reason.evaluationSHA256,
        opponent: 'reason',
        completedPairs: clusters.length,
        pairs,
        modelSHA256: plan.modelSHA256,
        opponentSHA256: plan.reason.modelSHA256,
        seedStart: plan.seedStart,
        updatedAt: new Date().toISOString(),
        metrics: metrics(clusters),
        searchStats: engine.stats,
        clusters,
      });
    }
    if (!v1)
      for (const key of REASON_V2_MOVE.statistics)
        assert.ok(Number.isFinite(engine.stats[key]), 'Missing reason statistic ' + key);
    report.results.reason = { ...metrics(clusters), confidence95: intervals(clusters), clusters };
    report.searchStats = engine.stats;
    report.completedAt = new Date().toISOString();
    writeJSON(join(out, 'report.json'), report);
    return report;
  } finally {
    await inference.close();
    await engine.close();
  }
}
