import { isDeepStrictEqual } from 'node:util';
import { modelLabel } from './model-labels.mjs';
import { join } from 'node:path';
import { opponentDefinition, suitePairs, MIXED_PANEL } from './opponents.mjs';
export function validSuiteReport(report, plan, opponent) {
  let pairs;
  try {
    pairs = suitePairs(plan, opponent);
  } catch {
    return false;
  }
  return Boolean(
    report?.completedAt &&
    report.modelSHA256 === plan.modelSHA256 &&
    report.index === plan.index &&
    report.pairs === pairs &&
    report.seedStart === plan.seedStart &&
    report.seedEnd === plan.seedStart + pairs - 1 &&
    report.results?.[opponent]?.matches === pairs * 2 &&
    report.results[opponent].wins +
      report.results[opponent].losses +
      report.results[opponent].draws ===
      pairs * 2 &&
    report.results[opponent].clusters?.length === pairs &&
    report.results[opponent].clusters.every(
      (pair, i) =>
        pair.length === 2 &&
        pair.every((m, t) => m.seed === plan.seedStart + i && m.neuralTeam === t),
    ) &&
    (opponent !== 'champion' ||
      report.opponents?.champion?.modelSHA256 === plan.champion.modelSHA256) &&
    (opponent !== 'clint' ||
      plan.opponentPanel !== MIXED_PANEL ||
      (isDeepStrictEqual(report.opponents?.clint, plan.clint) &&
        isDeepStrictEqual(report.sourceSHA256, plan.clint?.sourceSHA256))) &&
    (opponent !== 'reason' ||
      (!!plan.reason &&
        isDeepStrictEqual(report.opponents?.reason, plan.reason) &&
        isDeepStrictEqual(report.sourceSHA256, plan.reason.sourceSHA256))),
  );
}

export function suiteRows(
  evalDirectory,
  read,
  { runName = 'GuanZero', modelIdentities = {} } = {},
) {
  const root = join(evalDirectory, 'development-500'),
    manifest = read(join(root, 'manifest.json'));
  const rows = [];
  for (const entry of (manifest?.suites || []).slice(-4).reverse()) {
    if (!/^[a-z0-9-]+$/.test(entry.id)) continue;
    const folder = join(root, entry.id),
      plan = read(join(folder, 'plan.json'));
    if (
      !plan ||
      plan.protocol !== 'development-500-v1' ||
      plan.pairs !== 250 ||
      plan.modelSHA256 !== entry.modelSHA256 ||
      plan.index !== entry.index
    )
      continue;
    for (const opponent of plan.opponents) {
      let pairs;
      try {
        pairs = suitePairs(plan, opponent);
      } catch {
        continue;
      }
      const cancelled = read(join(folder, 'cancelled.json'));
      const retirement = read(join(folder, 'opponent-retirement.json'));
      const retired =
        retirement?.removedOpponents?.includes(opponent) &&
        retirement?.schema === 'guanzero-clint-retirement-v1' &&
        retirement.modelSHA256 === plan.modelSHA256;
      const report = read(join(folder, opponent, 'report.json'));
      const complete = validSuiteReport(report, plan, opponent);
      const progress = read(join(folder, opponent, `${opponent}-progress.json`));
      const validProgress =
        progress?.opponent === opponent &&
        progress.modelSHA256 === plan.modelSHA256 &&
        progress.seedStart === plan.seedStart &&
        progress.pairs === pairs &&
        progress.completedPairs >= 0 &&
        progress.completedPairs <= pairs &&
        progress.metrics?.matches === 2 * progress.completedPairs &&
        (opponent !== 'champion' || progress.opponentSHA256 === plan.champion.modelSHA256) &&
        (opponent !== 'clint' ||
          plan.opponentPanel !== MIXED_PANEL ||
          (progress.opponentSHA256 === plan.clint?.evaluationSHA256 &&
            progress.evaluationSHA256 === plan.clint?.evaluationSHA256)) &&
        (opponent !== 'reason' ||
          (progress.opponentSHA256 === plan.reason?.modelSHA256 &&
            progress.evaluationSHA256 === plan.reason?.evaluationSHA256));
      const { clusters, ...m } = complete
        ? report.results[opponent]
        : validProgress
          ? progress.metrics
          : {};
      const definition =
        opponent === 'champion'
          ? plan.champion
          : opponent === 'reason'
            ? plan.reason
            : opponent === 'clint' && plan.clint
              ? plan.clint
              : opponentDefinition(opponent);
      if (!definition) continue;
      rows.push({
        opponent,
        opponentName: definition.name,
        opponentVersion: definition.version,
        opponentSHA256: definition.modelSHA256,
        suite: plan.id,
        modelVersion: plan.modelVersion,
        modelName: modelLabel(runName, plan.modelSHA256, plan.modelVersion, modelIdentities),
        model: plan.modelSHA256.slice(0, 12),
        modelSHA256: plan.modelSHA256,
        protocol: plan.protocol,
        seedStart: plan.seedStart,
        seedEnd: plan.seedStart + pairs - 1,
        plannedMatches: 2 * pairs,
        status: complete
          ? 'complete'
          : cancelled || retired
            ? 'cancelled'
            : validProgress
              ? 'running'
              : 'queued',
        cancelledAt: cancelled?.cancelledAt ?? (retired ? retirement.requestedAt : null),
        matches: 0,
        completedAt: complete ? report.completedAt : null,
        ...m,
      });
    }
  }
  return rows;
}
