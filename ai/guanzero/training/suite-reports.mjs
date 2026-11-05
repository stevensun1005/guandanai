import { modelLabel } from './model-labels.mjs';
import { join } from 'node:path';
import { opponentDefinition } from './opponents.mjs';
export function validSuiteReport(report, plan, opponent) {
  return Boolean(
    report?.completedAt &&
    report.modelSHA256 === plan.modelSHA256 &&
    report.index === plan.index &&
    report.pairs === plan.pairs &&
    report.seedStart === plan.seedStart &&
    report.seedEnd === plan.seedEnd &&
    report.results?.[opponent]?.matches === plan.pairs * 2 &&
    report.results[opponent].wins +
      report.results[opponent].losses +
      report.results[opponent].draws ===
      plan.pairs * 2 &&
    report.results[opponent].clusters?.length === plan.pairs &&
    report.results[opponent].clusters.every(
      (pair, i) =>
        pair.length === 2 &&
        pair.every((m, t) => m.seed === plan.seedStart + i && m.neuralTeam === t),
    ) &&
    (opponent !== 'champion' ||
      report.opponents?.champion?.modelSHA256 === plan.champion.modelSHA256),
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
      const report = read(join(folder, opponent, 'report.json'));
      const complete = validSuiteReport(report, plan, opponent);
      const progress = read(join(folder, opponent, `${opponent}-progress.json`));
      const validProgress =
        progress?.opponent === opponent &&
        progress.modelSHA256 === plan.modelSHA256 &&
        progress.seedStart === plan.seedStart &&
        progress.pairs === plan.pairs &&
        progress.completedPairs >= 0 &&
        progress.completedPairs <= plan.pairs &&
        progress.metrics?.matches === 2 * progress.completedPairs &&
        (opponent !== 'champion' || progress.opponentSHA256 === plan.champion.modelSHA256);
      const { clusters, ...m } = complete
        ? report.results[opponent]
        : validProgress
          ? progress.metrics
          : {};
      const definition = opponent === 'champion' ? plan.champion : opponentDefinition(opponent);
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
        seedEnd: plan.seedEnd,
        plannedMatches: 2 * plan.pairs,
        status: complete ? 'complete' : validProgress ? 'running' : 'queued',
        matches: 0,
        completedAt: complete ? report.completedAt : null,
        ...m,
      });
    }
  }
  return rows;
}
