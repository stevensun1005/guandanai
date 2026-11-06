import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validSuiteReport } from '../guanzero/training/suite-reports.mjs';
import { DEFAULT_OPPONENTS } from '../guanzero/training/opponents.mjs';
import { sha256 } from './artifacts.mjs';

export async function verifyEvaluatedSuite(directory, input, digest, source, root) {
  if (!directory) throw Error('GuanZero io48 requires --evaluated-suite');
  const suite = resolve(directory);
  const parent = dirname(suite);
  const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
  const plan = await read(join(suite, 'plan.json'));
  const manifest = await read(join(parent, 'manifest.json'));
  if (
    resolve(input) !== join(suite, 'model.onnx') ||
    basename(parent) !== 'development-500' ||
    basename(dirname(parent)) !== 'eval' ||
    basename(dirname(dirname(parent))) !== source.run ||
    plan.id !== basename(suite) ||
    source.version !== plan.modelVersion ||
    !/^model-\d+$/.test(plan.modelVersion) ||
    Number(plan.modelVersion.slice(6)) !== source.step ||
    plan.modelSHA256 !== digest ||
    plan.protocol !== 'development-500-v1' ||
    plan.pairs !== 250 ||
    plan.seedEnd !== plan.seedStart + 249 ||
    !isDeepStrictEqual(plan.opponents, DEFAULT_OPPONENTS) ||
    !manifest.suites.some((s) => isDeepStrictEqual(s, plan))
  )
    throw Error('Frozen evaluation identity mismatch');

  const gateFile = plan.champion.gate.evidence;
  if (!/^ai\/research\/evaluation\/[\w-]+\/gate-\d+\.json$/.test(gateFile))
    throw Error('Invalid champion evidence');
  const gateBytes = await readFile(join(root, gateFile)),
    gate = JSON.parse(gateBytes);
  if (
    sha256(gateBytes) !== plan.champion.gate.evidenceSHA256 ||
    gate.decision !== 'accept' ||
    gate.challenger.version !== plan.champion.version ||
    gate.challenger.sha256 !== plan.champion.modelSHA256 ||
    sha256(await readFile(join(suite, 'champion.onnx'))) !== plan.champion.modelSHA256
  )
    throw Error('Frozen champion gate mismatch');

  const opponents = {};
  for (const op of DEFAULT_OPPONENTS) {
    const bytes = await readFile(join(suite, op, 'report.json'));
    const report = JSON.parse(bytes);
    if (
      !validSuiteReport(report, plan, op) ||
      report.opponents[op].id !== op ||
      (op === 'rule' && report.opponents.rule.version !== 'original') ||
      (op === 'clint' && report.opponents.clint.version !== 'rules-v2') ||
      (op === 'champion' && !isDeepStrictEqual(report.opponents.champion.gate, plan.champion.gate))
    )
      throw Error('Incomplete or mismatched report: ' + op);
    const { wins, losses, draws, confidence95, clusters } = report.results[op];
    const matches = clusters.flat();
    if (
      matches.some(
        (m) => m.opponent !== report.opponents[op].mode || ![null, 0, 1].includes(m.winner),
      ) ||
      matches.filter((m) => m.winner === m.neuralTeam).length !== wins ||
      matches.filter((m) => m.winner === null).length !== draws
    )
      throw Error('Per-match outcomes disagree: ' + op);
    opponents[op] = { wins, losses, draws, confidence95, reportSHA256: sha256(bytes) };
  }
  return {
    protocol: plan.protocol,
    modelSHA256: digest,
    seedStart: plan.seedStart,
    seedEnd: plan.seedEnd,
    championSHA256: plan.champion.modelSHA256,
    opponents,
  };
}
